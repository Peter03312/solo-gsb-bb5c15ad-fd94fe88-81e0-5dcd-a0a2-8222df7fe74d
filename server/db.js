'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'allergen.db');

let db;

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function initDbFile() {
  const d = getDb();
  return d;
}

function initSchema(d) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    allergens TEXT NOT NULL DEFAULT '[]'  -- JSON 字符串数组
  );

  -- 原料供应批号（批号档案）：同一供应批号号只在一种原料下唯一；供应商通报异常时
  -- 可置 status='FLAGGED'（仅标记，供追溯查询参考，不自动改变任何放行/出货结论）。
  CREATE TABLE IF NOT EXISTS material_lots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL REFERENCES materials(id),
    lot_code TEXT NOT NULL,             -- 供应批号（供应商批号），同一原料下唯一
    supplier TEXT NOT NULL DEFAULT '',  -- 供应商（可选）
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FLAGGED')),
    flagged_reason TEXT NOT NULL DEFAULT '', -- 供应商通报异常说明（仅留痕/提示）
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (material_id, lot_code)
  );

  CREATE TABLE IF NOT EXISTS equipment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_time TEXT NOT NULL,          -- ISO 字符串，如 2026-09-30T08:00
    type TEXT NOT NULL CHECK (type IN ('PROCESS','CLEAN')),
    equipment_id INTEGER NOT NULL REFERENCES equipment(id),
    batch_id INTEGER UNIQUE REFERENCES batches(id), -- PROCESS 时唯一
    -- CLEAN 事件本次已核实去除的过敏原集合（JSON 字符串数组）：
    --   NULL = 全清（既有 CLEAN 事件与旧请求省略该字段均为此语义，清空设备全部残留）；
    --   非空数组 = 部分清洗，只清除指定过敏原的设备残留及其来源，其余残留继续进入后续批次。
    --   显式空数组（'[]'）非法，写入时拒绝；PROCESS 事件恒为 NULL。
    clean_allergens TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS process_inputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    material_id INTEGER REFERENCES materials(id),
    batch_id INTEGER REFERENCES batches(id),
    -- 本次原料输入所属供应批号：可空 = 批号未知（旧事件只传 material_ids 的输入均记为未知）。
    -- 只对原料输入有意义；引用批次输入恒为 NULL。
    material_lot_id INTEGER REFERENCES material_lots(id),
    CHECK ((material_id IS NOT NULL AND batch_id IS NULL)
        OR (material_id IS NULL AND batch_id IS NOT NULL))
  );

  -- 重算结果（派生数据，随事件变更全量刷新）
  CREATE TABLE IF NOT EXISTS batch_outputs (
    batch_id INTEGER PRIMARY KEY REFERENCES batches(id) ON DELETE CASCADE,
    allergens TEXT NOT NULL DEFAULT '[]',
    paths_json TEXT NOT NULL DEFAULT '[]'
  );

  -- 设备当前残留（最后一次已核实清洗之后的累积）
  CREATE TABLE IF NOT EXISTS equipment_residue (
    equipment_id INTEGER PRIMARY KEY REFERENCES equipment(id) ON DELETE CASCADE,
    allergens TEXT NOT NULL DEFAULT '[]',
    paths_json TEXT NOT NULL DEFAULT '[]',
    last_cleaned_at TEXT
  );

  CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL REFERENCES batches(id),
    released_at TEXT NOT NULL,
    released_by TEXT NOT NULL DEFAULT '',
    snapshot_allergens TEXT NOT NULL DEFAULT '[]',  -- 登记当时的过敏原集合（排序）
    status TEXT NOT NULL CHECK (status IN ('ACTIVE','INVALIDATED')),
    invalid_reason TEXT NOT NULL DEFAULT '',
    created_event_seq INTEGER NOT NULL DEFAULT 0  -- 登记时的事件版本号
  );

  -- 过敏原标签卷：包装前按“当前批次推导集合 ∩ 所选有效放行快照”一致后登记一卷。
  -- 卷一旦停用（status='RETIRED'）为终态：余量不可再贴，即使集合后来恢复也不自动解冻。
  CREATE TABLE IF NOT EXISTS label_rolls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roll_code TEXT NOT NULL UNIQUE,         -- 卷号，如 LABEL-0001（登记事务内补发）
    batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
    release_id INTEGER REFERENCES releases(id) ON DELETE SET NULL,
    print_qty INTEGER NOT NULL CHECK (print_qty > 0),  -- 印量（正整数张数）
    applied_qty INTEGER NOT NULL DEFAULT 0 CHECK (applied_qty >= 0), -- 已贴用
    void_qty INTEGER NOT NULL DEFAULT 0 CHECK (void_qty >= 0),       -- 已作废
    revision INTEGER NOT NULL DEFAULT 0,    -- 核销修订号（乐观并发：每次核销 +1）
    allergen_set TEXT NOT NULL DEFAULT '[]',-- 拟印过敏原集合（规范化排序 JSON）
    registered_at TEXT NOT NULL,
    registered_by TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETIRED')),
    retired_reason TEXT NOT NULL DEFAULT '', -- 停用原因（终态留痕）
    CHECK (applied_qty + void_qty <= print_qty)
  );

  -- 标签卷核销流水：贴用 / 作废按修订号核销，整次事务化。
  CREATE TABLE IF NOT EXISTS label_roll_usages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roll_id INTEGER NOT NULL REFERENCES label_rolls(id) ON DELETE CASCADE,
    used_at TEXT NOT NULL,
    applied_qty INTEGER NOT NULL CHECK (applied_qty >= 0),
    void_qty INTEGER NOT NULL CHECK (void_qty >= 0),
    expected_revision INTEGER NOT NULL,     -- 客户端核销时依据的修订号
    used_by TEXT NOT NULL DEFAULT ''
  );

  -- 包装出货单：按批次把已贴用标签按卷分配给出货单（整单事务化，任一条件不满足即拒绝且不占数量）。
  -- 单据只增不改：批次/放行后续更正、放行删除均不删除出货记录，仅置为“待评估”（PENDING_REVIEW，终态不自动恢复）。
  CREATE TABLE IF NOT EXISTS shipments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shipment_code TEXT NOT NULL UNIQUE,       -- 出货单号，如 SHIP-0001（出货事务内补发）
    batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL, -- 批次可因更正删除，单据保留
    batch_code TEXT NOT NULL DEFAULT '',      -- 批次编码快照
    ship_qty INTEGER NOT NULL CHECK (ship_qty > 0), -- 正整数出货量（张）
    allergen_set TEXT NOT NULL DEFAULT '[]',  -- 出货当时的过敏原集合快照（规范化排序 JSON）
    status TEXT NOT NULL DEFAULT 'SHIPPED'
      CHECK (status IN ('SHIPPED','PENDING_REVIEW')), -- 已出货 / 待评估（不自动恢复）
    review_reason TEXT NOT NULL DEFAULT '',   -- 待评估原因（留痕）
    shipped_at TEXT NOT NULL,
    shipped_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 出货单分配明细：每条记录保存出货当时的放行标识、过敏原集合、卷号与修订号快照。
  -- release_id 不加外键：放行删除后出货记录仍须保留其标识；卷不会被删除（仅停用）。
  CREATE TABLE IF NOT EXISTS shipment_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shipment_id INTEGER NOT NULL REFERENCES shipments(id),
    roll_id INTEGER NOT NULL REFERENCES label_rolls(id),
    roll_code TEXT NOT NULL DEFAULT '',       -- 卷号快照（如 LABEL-0001）
    release_id INTEGER,                       -- 当时绑定的放行标识
    release_at TEXT,                          -- 放行时间快照
    release_by TEXT NOT NULL DEFAULT '',      -- 放行人快照
    allergen_set TEXT NOT NULL DEFAULT '[]',  -- 当时卷（=批次推导=放行快照）过敏原集合
    roll_revision INTEGER NOT NULL,           -- 当时卷的修订号
    qty INTEGER NOT NULL CHECK (qty > 0)      -- 本卷分配张数（正整数）
  );

  -- 出货质量处置（整单）：仅对“待评估（PENDING_REVIEW）”出货单登记整单结论。
  --   decision='CONTINUE' 准予继续流转；decision='RECALL' 召回。
  -- 记录只增不改：处置行本身永不 UPDATE/DELETE；同一出货单已有有效结论时再提交（哪怕携带旧版本）
  --   一律拒绝，不会覆盖既有结论。此后批次过敏原 / 有效放行 / 所用卷停用信息变化时，
  --   旧结论由 syncStaleDispositions 标记 life_status='STALE'（需重新评估，不自动生效），
  --   原结论内容、依据、操作人原样保留；出货单原状态与数量占用不因处置而改变。
  CREATE TABLE IF NOT EXISTS shipment_dispositions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 不加外键/ON DELETE：处置记录只增不改，出货单本身也从不删除；
    -- 批次连带删除等场景下处置记录与其历史结论必须原样保留。
    shipment_id INTEGER NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('CONTINUE','RECALL')),
    decided_by TEXT NOT NULL DEFAULT '',       -- 提交操作人
    basis TEXT NOT NULL DEFAULT '',            -- 处置依据
    expected_version INTEGER NOT NULL,         -- 查询时取得的状态版本（乐观并发）
    context_hash TEXT NOT NULL DEFAULT '',     -- 提交当时的评估上下文指纹（变化即需重评）
    context_snapshot TEXT NOT NULL DEFAULT '{}', -- 提交当时的上下文快照（用于生成需重评原因）
    status_version INTEGER NOT NULL,           -- 提交后该单的状态版本
    life_status TEXT NOT NULL DEFAULT 'ACTIVE'
      CHECK (life_status IN ('ACTIVE','STALE')), -- 有效 / 需重新评估（结论不自动生效）
    stale_reason TEXT NOT NULL DEFAULT '',
    decided_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 出货单状态版本：每次创建出货单 / 出货单转待评估 / 登记处置时 +1。
  -- 质量处置接口要求提交查询时取得的版本，事务内与最新版本核对，过期拒绝且不产生记录。
  CREATE TABLE IF NOT EXISTS shipment_versions (
    -- 出货单从不删除；不加外键以便与只增不改的处置记录保持同一保留语义。
    shipment_id INTEGER PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 0
  );

  -- 断网补录批号（整包）：一次断网期间的加工/已核实清洗日志用一个补录批号整包提交。
  -- 整包事务化：任一记录不合法（未知对象、空清洗集合、时间冲突、未来/循环引用、
  -- 外部记录号冲突等）整包回滚，不留部分事件。
  -- 补录批号唯一：同号同内容重试返回原结果（幂等）；同号不同内容整包拒绝。
  CREATE TABLE IF NOT EXISTS backfill_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    backfill_code TEXT NOT NULL UNIQUE,      -- 补录批号（调用方提供，全局唯一）
    content_hash TEXT NOT NULL,              -- 整包内容哈希（解析为 id 后的规范化内容，供同号重试比对）
    external_hash TEXT NOT NULL DEFAULT '',  -- 整包外部形态哈希（id/code 解析前，供重试提前判定，绕过解析）
    record_count INTEGER NOT NULL,           -- 包内有序记录数
    inserted_count INTEGER NOT NULL DEFAULT 0, -- 本次新写入的事件数（同号同内容的既有记录不重复写入）
    reused_count INTEGER NOT NULL DEFAULT 0,   -- 命中既有外部记录号、复用既有事件的记录数
    result_json TEXT NOT NULL DEFAULT '{}',  -- 首次成功的完整响应（重试原样返回）
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 补录包内记录（每条含外部记录号、时间与设备；与实际事件一一对应）。
  -- 外部记录号语义：同号同内容允许跨包复用（指向同一既有事件，不重复写入，见 idx_backfill_records_external），
  -- 同号不同内容在提交校验阶段即整包拒绝。
  -- event_id 不加外键：事件随后可经既有单条接口更正/删除（兼容性不变），
  -- 对账时如实反映“事件仍在 / 已被更正 / 已删除”。
  CREATE TABLE IF NOT EXISTS backfill_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    backfill_id INTEGER NOT NULL REFERENCES backfill_batches(id),
    seq INTEGER NOT NULL,                    -- 包内顺序（0 起；包内引用只可指向更早产出）
    external_ref TEXT NOT NULL,              -- 外部记录号（断网日志中的原始记录号）
    event_type TEXT NOT NULL CHECK (event_type IN ('PROCESS','CLEAN')),
    event_time TEXT NOT NULL,
    equipment_id INTEGER NOT NULL,
    event_id INTEGER,                        -- 对应事件 id（复用既有记录时指向既有事件；事件删除后置空）
    content_hash TEXT NOT NULL,              -- 本记录内容哈希（解析后规范化，供外部记录号冲突检测）
    canonical_json TEXT NOT NULL DEFAULT '{}', -- 解析后规范化记录（对账比对基线）
    UNIQUE (backfill_id, seq),
    UNIQUE (backfill_id, external_ref)
  );

  -- 设备检修停机窗口：检修期间不能记录加工或清洗。
  --   窗口为左闭右开区间 [start_time, end_time)，起点须早于终点；
  --   同设备窗口不可重叠（相邻允许：一个的终点可等于另一个的起点）；
  --   登记/调整时若覆盖已有加工/清洗事件则整次拒绝（见 downtime.js）；
  --   事件新增/更正、断网补录、换线预演与确认应用均按最终设备与时间核对窗口
  --   （见 validation.js 全量校验）。
  --   停机不等于清洗：窗口不是事件，不改变设备残留或过敏原推导，不触发重算联动。
  CREATE TABLE IF NOT EXISTS equipment_downtime_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipment_id INTEGER NOT NULL REFERENCES equipment(id),
    start_time TEXT NOT NULL,          -- 窗口起点（左闭，含该时刻），ISO 如 2026-10-09T08:00
    end_time TEXT NOT NULL,            -- 窗口终点（右开，不含该时刻）
    reason TEXT NOT NULL DEFAULT '',   -- 停机原因
    operator TEXT NOT NULL DEFAULT '', -- 操作人
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (start_time < end_time)
  );

  CREATE INDEX IF NOT EXISTS idx_events_time ON events(event_time, id);
  CREATE INDEX IF NOT EXISTS idx_process_inputs_event ON process_inputs(event_id);
  CREATE INDEX IF NOT EXISTS idx_material_lots_material ON material_lots(material_id);
  CREATE INDEX IF NOT EXISTS idx_releases_batch ON releases(batch_id);
  CREATE INDEX IF NOT EXISTS idx_label_rolls_batch ON label_rolls(batch_id);
  CREATE INDEX IF NOT EXISTS idx_label_usages_roll ON label_roll_usages(roll_id);
  CREATE INDEX IF NOT EXISTS idx_shipments_batch ON shipments(batch_id);
  CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
  CREATE INDEX IF NOT EXISTS idx_shipment_items_shipment ON shipment_items(shipment_id);
  CREATE INDEX IF NOT EXISTS idx_shipment_items_roll ON shipment_items(roll_id);
  CREATE INDEX IF NOT EXISTS idx_ship_disp_shipment ON shipment_dispositions(shipment_id);
  CREATE INDEX IF NOT EXISTS idx_backfill_records_backfill ON backfill_records(backfill_id);
  CREATE INDEX IF NOT EXISTS idx_backfill_records_event ON backfill_records(event_id);
  -- 外部记录号查询索引：同号同内容允许跨包复用（指向同一既有事件，不重复写入），
  -- 故不加全局唯一约束；“同号不同内容整包拒绝”在提交校验中按首次出现记录比对哈希强制。
  CREATE INDEX IF NOT EXISTS idx_backfill_records_external ON backfill_records(external_ref);
  CREATE INDEX IF NOT EXISTS idx_downtime_windows_equipment ON equipment_downtime_windows(equipment_id);
  `);

  // ---- 旧库迁移（CREATE TABLE IF NOT EXISTS 不会为既有表补列）----
  // process_inputs.material_lot_id：原料供应批号归属；旧记录全部保持 NULL（批号未知），不丢失。
  // 注意：引用该列的索引必须在补列之后再创建，否则旧库建索引会报“无此列”。
  const inputCols = d.prepare("PRAGMA table_info(process_inputs)").all().map((c) => c.name);
  if (!inputCols.includes('material_lot_id')) {
    d.exec(
      'ALTER TABLE process_inputs ADD COLUMN material_lot_id INTEGER REFERENCES material_lots(id)'
    );
  }
  d.exec('CREATE INDEX IF NOT EXISTS idx_process_inputs_lot ON process_inputs(material_lot_id)');

  // events.clean_allergens：CLEAN 事件本次已核实去除的过敏原集合（NULL=全清，旧事件全部保持全清语义）。
  const eventCols = d.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  if (!eventCols.includes('clean_allergens')) {
    d.exec('ALTER TABLE events ADD COLUMN clean_allergens TEXT');
  }
}

module.exports = { getDb, initDbFile, initSchema, DB_PATH };
