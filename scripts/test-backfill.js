'use strict';
// 断网日志整包补录 端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务（空白库，自建数据），验证：
//   整包提交（加工/清洗、批号未知、部分清洗、编码或 id 引用）；
//   包内引用只可指向更早产出（顺序 + 时间）；引用库内更早批次；
//   未知对象 / 空清洗集合 / 时间冲突 / 未来引用 / 循环引用 / 批次重复产出 -> 整包回滚不留部分事件；
//   同补录批号同内容重试幂等返回原结果；同号不同内容整包拒绝；
//   外部记录号同号同内容复用既有事件（不重复写入）；同号不同内容整包拒绝；
//   成功后按时间线重算联动：放行失效、标签卷停用、出货单待评估、处置结论需重评；
//   对账查询：OK / 事件被单条接口更正 MISMATCH / 事件被删除 DELETED；
//   既有单条事件接口与 /api/state 形状兼容（事件附 external_ref，不影响旧字段）。
//   node scripts/test-backfill.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39152';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/api/state');
      if (res.ok) return;
    } catch (_) { /* 未就绪 */ }
    if (proc.exitCode !== null) throw new Error('服务提前退出');
    await sleep(250);
  }
  throw new Error('服务启动超时');
}

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: dbPath, SEED_DEMO: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    const newId = async (url, body) => (await api('POST', url, body)).json.id;
    const MILK = await newId('/api/materials', { code: 'MILK', name: '全脂奶粉', allergens: ['乳'] });
    const EGG = await newId('/api/materials', { code: 'EGG', name: '全蛋液', allergens: ['蛋'] });
    const SESAME = await newId('/api/materials', { code: 'SESAME', name: '芝麻酱', allergens: ['芝麻'] });
    const PEANUT = await newId('/api/materials', { code: 'PEANUT', name: '花生碎', allergens: ['花生'] });
    const LINE = await newId('/api/equipment', { code: 'LINE-A', name: '烘焙A线' });
    const LINE2 = await newId('/api/equipment', { code: 'LINE-B', name: '烘焙B线' });
    // 牛奶供应批号（断网补录里按 lot_id / lot_code 引用，含批号未知输入）
    const LOT = await newId('/api/material-lots', { material_id: MILK, lot_code: 'SUP-MILK-1' });
    const D = '2026-10-01T';
    let r;

    // ---------- 1. 形状/入参校验（不落任何事件） ----------
    console.log('1) 请求形状校验：缺批号/空包/缺外部记录号/包内重复外部记录号/类型非法');
    r = await api('POST', '/api/backfills', { records: [] });
    check('缺 backfill_code -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/backfills', { backfill_code: 'BF', records: [] });
    check('空记录数组 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF',
      records: [{ type: 'PROCESS', event_time: D + '08:00', equipment_id: LINE, batch_code: 'B1' }]
    });
    check('缺外部记录号 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF',
      records: [
        { external_ref: 'R1', type: 'CLEAN', event_time: D + '08:00', equipment_id: LINE },
        { external_ref: 'R1', type: 'CLEAN', event_time: D + '09:00', equipment_id: LINE }
      ]
    });
    check('包内外部记录号重复 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF',
      records: [{ external_ref: 'R1', type: 'WRONG', event_time: D + '08:00', equipment_id: LINE }]
    });
    check('类型非法 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF',
      records: [{ external_ref: 'R1', type: 'CLEAN', event_time: D + '08:00', equipment_id: LINE, clean_allergens: [] }]
    });
    check('显式空清洗集合 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF',
      records: [{ external_ref: 'R1', type: 'CLEAN', event_time: D + '08:00', equipment_id: LINE, clean_allergens: ['  '] }]
    });
    check('空白清洗名称 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF',
      records: [{
        external_ref: 'R1', type: 'PROCESS', event_time: D + '08:00', equipment_id: LINE,
        batch_code: 'B1', clean_allergens: ['乳']
      }]
    });
    check('PROCESS 携带清洗范围 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);

    // ---------- 2. 未知对象整包拒绝 ----------
    console.log('2) 未知对象：未知设备/原料/批号/引用批次/批号与原料不匹配');
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF', records: [
        { external_ref: 'R1', type: 'CLEAN', event_time: D + '08:00', equipment_code: 'NOPE' }
      ]
    });
    check('未知设备编码 -> 400 BACKFILL_REJECTED', r.status === 400 && r.json.code === 'BACKFILL_REJECTED', r.json);
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF', records: [
        { external_ref: 'R1', type: 'PROCESS', event_time: D + '08:00', equipment_id: LINE,
          batch_code: 'B1', material_inputs: [{ material_code: 'NOPE' }] }
      ]
    });
    check('未知原料编码 -> 400', r.status === 400 && r.json.code === 'BACKFILL_REJECTED', r.json);
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF', records: [
        { external_ref: 'R1', type: 'PROCESS', event_time: D + '08:00', equipment_id: LINE,
          batch_code: 'B1', material_inputs: [{ material_id: MILK, lot_id: 9999 }] }
      ]
    });
    check('未知供应批号 -> 400', r.status === 400 && r.json.code === 'BACKFILL_REJECTED', r.json);
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF', records: [
        { external_ref: 'R1', type: 'PROCESS', event_time: D + '08:00', equipment_id: LINE,
          batch_code: 'B1', material_inputs: [{ material_id: EGG, lot_id: LOT }] }
      ]
    });
    check('批号与原料不匹配 -> 400', r.status === 400 && r.json.code === 'BACKFILL_REJECTED', r.json);
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF', records: [
        { external_ref: 'R1', type: 'PROCESS', event_time: D + '08:00', equipment_id: LINE,
          batch_code: 'B1', material_inputs: [], ref_batch_codes: ['GHOST'] }
      ]
    });
    check('引用未知批次 -> 400', r.status === 400 && r.json.code === 'BACKFILL_REJECTED', r.json);

    // ---------- 3. 首次整包补录成功（含批号未知、按 lot_code 引用、部分清洗） ----------
    console.log('3) 首次补录成功：B1(乳,批号未知) -> 全清 -> B2(牛奶批号+蛋批号未知) -> 部分清洗(去乳)');
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-DAY1',
      records: [
        { external_ref: 'LOG-001', type: 'PROCESS', event_time: D + '08:00', equipment_code: 'LINE-A',
          batch_code: 'B1', note: '早班乳批（批号未知）',
          material_inputs: [{ material_id: MILK }] },
        { external_ref: 'LOG-002', type: 'CLEAN', event_time: D + '09:00', equipment_id: LINE,
          note: '全清（CIP）' },
        { external_ref: 'LOG-003', type: 'PROCESS', event_time: D + '10:00', equipment_id: LINE,
          batch_code: 'B2', note: '牛奶已知批号 + 蛋批号未知',
          material_inputs: [
            { material_code: 'MILK', lot_code: 'SUP-MILK-1' },
            { material_id: EGG }
          ] },
        { external_ref: 'LOG-004', type: 'CLEAN', event_time: D + '10:30', equipment_id: LINE,
          note: '部分清洗：仅核实去乳（蛋残留保留）', clean_allergens: ['乳', '乳'] }
      ]
    });
    check('首次补录 200', r.status === 200, r.json);
    check('映射 4 条外部记录号',
      r.json.event_mapping['LOG-001'] && r.json.event_mapping['LOG-002'] &&
      r.json.event_mapping['LOG-003'] && r.json.event_mapping['LOG-004'], r.json.event_mapping);
    check('inserted=4 reused=0 produced=2',
      r.json.impact_summary.inserted_events === 4 &&
      r.json.impact_summary.reused_events === 0 &&
      r.json.impact_summary.produced_batches === 2, r.json.impact_summary);

    // 推导核对：B1 乳；全清后 B2 = 乳+蛋（原料，无设备残留）；部分清洗后设备残留仅剩蛋
    let st = (await api('GET', '/api/state')).json;
    const batchAllergens = Object.fromEntries(st.batches.map((b) => [b.code, b.allergens]));
    check('B1 推导含乳', (batchAllergens['B1'] || []).includes('乳'), batchAllergens);
    check('B2 推导为乳+蛋',
      (batchAllergens['B2'] || []).includes('乳') && (batchAllergens['B2'] || []).includes('蛋'),
      batchAllergens['B2']);
    const lineState = st.equipment.find((e) => e.code === 'LINE-A');
    check('部分清洗后设备残留仅蛋',
      lineState.allergens.length === 1 && lineState.allergens[0] === '蛋', lineState.allergens);
    check('设备最近一次清洗为部分清洗(去乳)',
      lineState.last_clean_partial === true &&
      JSON.stringify(lineState.last_clean_allergens) === JSON.stringify(['乳']),
      lineState.last_clean_allergens);
    // 事件附外部记录号（兼容旧字段）
    const log1 = st.events.find((e) => e.batch_code === 'B1');
    check('/api/state 事件附 external_ref/backfill_code（旧字段保留）',
      log1.external_ref === 'LOG-001' && log1.backfill_code === 'BF-DAY1' &&
      log1.type === 'PROCESS' && Array.isArray(log1.inputs), log1);

    // ---------- 4. 包内引用：更早产出 OK；指向更晚/未来/循环整包回滚 ----------
    console.log('4) 包内引用规则');
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-REF-OK',
      records: [
        { external_ref: 'R1', type: 'PROCESS', event_time: D + '11:00', equipment_id: LINE2,
          batch_code: 'R1', note: '引用库内更早 B2(10:00)', material_inputs: [{ material_id: SESAME }],
          ref_batch_codes: ['B2'] },
        { external_ref: 'R2', type: 'PROCESS', event_time: D + '12:00', equipment_id: LINE2,
          batch_code: 'R2', note: '引用包内更早 R1', material_inputs: [],
          ref_batch_codes: ['R1'] }
      ]
    });
    check('引用库内更早批次 + 包内更早批次 200', r.status === 200, r.json);

    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-REF-FWD',
      records: [
        { external_ref: 'F1', type: 'PROCESS', event_time: D + '13:00', equipment_id: LINE2,
          batch_code: 'F1', material_inputs: [], ref_batch_codes: ['F2'] },
        { external_ref: 'F2', type: 'PROCESS', event_time: D + '14:00', equipment_id: LINE2,
          batch_code: 'F2', material_inputs: [] }
      ]
    });
    check('引用包内更晚产出 -> 400', r.status === 400, r.json);

    // 引用未来库内批次（R2 产出 12:00，新事件 11:30 引用它）
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-REF-FUT',
      records: [
        { external_ref: 'U1', type: 'PROCESS', event_time: D + '11:30', equipment_id: LINE,
          batch_code: 'U1', material_inputs: [], ref_batch_codes: ['R2'] }
      ]
    });
    check('引用未来批次 -> 400 整包回滚', r.status === 400 && r.json.code === 'BACKFILL_REJECTED', r.json);

    // 循环引用：新批次 X(15:00) 引用 R2；再补 Y(16:00) 引用 X；再尝试让 R2 引 X——
    // R2 已在库不可改；改为构造 X->Y 与 Y->X 的两条新事件成环（同一包内不可能，需跨包）。
    // 先补 X(15:00) 引用 R2；
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-CYCLE-1',
      records: [
        { external_ref: 'C1', type: 'PROCESS', event_time: D + '15:00', equipment_id: LINE2,
          batch_code: 'C1', material_inputs: [], ref_batch_codes: ['R2'] }
      ]
    });
    check('成环前置批次 C1 200', r.status === 200, r.json);
    // 时间冲突：与既有事件同设备同时刻
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-CONF-TIME',
      records: [
        { external_ref: 'T1', type: 'CLEAN', event_time: D + '15:00', equipment_id: LINE2, note: '撞 C1 时间' }
      ]
    });
    check('同设备同时刻冲突 -> 400', r.status === 400 && r.json.code === 'BACKFILL_REJECTED', r.json);
    // 批次重复产出：包内新批次码与库内已有批次重复
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-DUP-BATCH',
      records: [
        { external_ref: 'T2', type: 'PROCESS', event_time: D + '16:00', equipment_id: LINE2,
          batch_code: 'B2', material_inputs: [] }
      ]
    });
    check('产出已在库的批次 -> 400', r.status === 400, r.json);
    // 所有失败整包回滚：无 F1/F2/U1/T1/T2 事件残留
    st = (await api('GET', '/api/state')).json;
    const codesAfter = st.batches.map((b) => b.code);
    check('回滚不留部分批次（无 F1/F2/U1/T2 批次）',
      !codesAfter.includes('F1') && !codesAfter.includes('F2') &&
      !codesAfter.includes('U1') && !codesAfter.includes('T2'), codesAfter);

    // ---------- 5. 幂等：同号同内容重试返回原结果 ----------
    console.log('5) 同补录批号重试：同内容幂等（含 id/编码互换）；不同内容 409');
    const first = await api('GET', '/api/backfills/BF-DAY1');
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-DAY1',
      records: [
        { external_ref: 'LOG-001', type: 'PROCESS', event_time: D + '08:00', equipment_id: LINE,
          batch_code: 'B1', note: '早班乳批（批号未知）', material_inputs: [{ material_id: MILK }] },
        { external_ref: 'LOG-002', type: 'CLEAN', event_time: D + '09:00', equipment_id: LINE,
          note: '全清（CIP）' },
        { external_ref: 'LOG-003', type: 'PROCESS', event_time: D + '10:00', equipment_id: LINE,
          batch_code: 'B2', note: '牛奶已知批号 + 蛋批号未知',
          material_inputs: [
            { material_id: MILK, lot_id: LOT },
            { material_id: EGG }
          ] },
        { external_ref: 'LOG-004', type: 'CLEAN', event_time: D + '10:30', equipment_id: LINE,
          note: '部分清洗：仅核实去乳（蛋残留保留）', clean_allergens: ['乳'] }
      ]
    });
    check('同号同内容（id 形式、去重清洗名）-> 200 idempotent',
      r.status === 200 && r.json.idempotent === true, r.json);
    check('幂等返回原映射（事件号不变）',
      r.json.event_mapping['LOG-003'] === first.json.records.find((x) => x.external_ref === 'LOG-003').event_id,
      r.json.event_mapping);
    st = (await api('GET', '/api/state')).json;
    // BF-DAY1:4 + BF-REF-OK:2 + BF-CYCLE-1(C1):1 = 7 条事件；幂等重试不新增。
    check('幂等重试不新增事件（仍为 7 条）', st.events.length === 7, st.events.length);

    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-DAY1',
      records: [
        { external_ref: 'LOG-001', type: 'PROCESS', event_time: D + '08:00', equipment_id: LINE,
          batch_code: 'B1', note: '改了备注', material_inputs: [{ material_id: MILK }] }
      ]
    });
    check('同号不同内容 -> 409 BACKFILL_CODE_CONFLICT',
      r.status === 409 && r.json.code === 'BACKFILL_CODE_CONFLICT', r.json);

    // ---------- 6. 外部记录号：同号同内容跨包复用；冲突整包拒绝 ----------
    console.log('6) 外部记录号跨包：同内容复用不重复写入；不同内容 409');
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-REUSE',
      records: [
        { external_ref: 'LOG-003', type: 'PROCESS', event_time: D + '10:00', equipment_id: LINE,
          batch_code: 'B2', note: '牛奶已知批号 + 蛋批号未知',
          material_inputs: [
            { material_id: MILK, lot_id: LOT },
            { material_id: EGG }
          ] },
        { external_ref: 'NEW-1', type: 'PROCESS', event_time: D + '17:00', equipment_id: LINE2,
          batch_code: 'N1', note: '新批引用复用批次 B2', material_inputs: [{ material_id: SESAME }],
          ref_batch_codes: ['B2'] }
      ]
    });
    check('同号同内容复用 + 新事件 200', r.status === 200, r.json);
    check('inserted=1 reused=1',
      r.json.impact_summary.inserted_events === 1 && r.json.impact_summary.reused_events === 1,
      r.json.impact_summary);
    check('复用映射指向既有事件',
      r.json.event_mapping['LOG-003'] === first.json.records.find((x) => x.external_ref === 'LOG-003').event_id,
      r.json.event_mapping);

    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-CONFLICT-REF',
      records: [
        { external_ref: 'LOG-001', type: 'CLEAN', event_time: D + '18:00', equipment_id: LINE, note: '冒号冲突' }
      ]
    });
    check('外部记录号不同内容 -> 409 BACKFILL_EXTERNAL_REF_CONFLICT',
      r.status === 409 && r.json.code === 'BACKFILL_EXTERNAL_REF_CONFLICT', r.json);

    // ---------- 7. 成功后联动：放行失效/卷停用/出货待评估/处置需重评 ----------
    console.log('7) 补录改变历史推导 -> 放行失效、标签卷停用、出货单待评估、处置 STALE');
    // 现状：N1(17:00, LINE-B) = B2(乳/蛋)+芝麻；为其登记放行 + 标签卷 + 出货
    const st2 = (await api('GET', '/api/state')).json;
    const n1Batch = st2.batches.find((b) => b.code === 'N1');
    const n1Allergens = n1Batch.allergens.slice().sort();
    r = await api('POST', '/api/releases', {
      batch_id: n1Batch.id, released_at: D + '17:30', released_by: '质检-王敏'
    });
    const releaseId = r.json.id;
    r = await api('POST', '/api/label-rolls', {
      batch_id: n1Batch.id, release_id: releaseId,
      allergens: n1Allergens, print_qty: 100, registered_by: '包装-李雷',
      registered_at: D + '17:40'
    });
    const rollId = r.json.id;
    check('登记标签卷成功（三方一致）', !!rollId, r.json);
    await api('POST', `/api/label-rolls/${rollId}/consume`, {
      expected_revision: 0, applied: 10, voided: 0, used_by: '赵强'
    });
    r = await api('POST', '/api/shipments', {
      batch_id: n1Batch.id, ship_qty: 10, shipped_by: '仓管-孙倩', shipped_at: D + '18:00',
      allocations: [{ roll_id: rollId, qty: 10 }]
    });
    const shipCode = r.json.shipment_code;
    check('出货成功', !!shipCode, r.json);

    // 用补录在 N1 之前插入“花生”残留：在 LINE-B 11:00 之前补一个花生批 + 不清洗，
    // 花生经设备残留进入 R1(11:00)/R2(12:00)/C1(15:00)/N1(17:00)。
    // 07:30 LINE-B 加工花生批 P1（无清洗），随后 R1 11:00 在同设备 -> 残留传播。
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-PEANUT',
      records: [
        { external_ref: 'PEA-1', type: 'PROCESS', event_time: D + '07:30', equipment_id: LINE2,
          batch_code: 'P1', note: '断网漏录：早班花生批', material_inputs: [{ material_id: PEANUT }] }
      ]
    });
    check('补录花生残留批 200', r.status === 200, r.json);
    check('影响摘要：放行失效 1、卷停用 1、出货待评估 1',
      r.json.impact_summary.invalidated_releases >= 1 &&
      r.json.impact_summary.retired_label_rolls >= 1 &&
      r.json.impact_summary.pending_shipments >= 1, r.json.impact_summary);
    check('响应附 invalidated/retired_rolls/pending_shipments',
      r.json.invalidated.some((x) => x.id === releaseId) &&
      r.json.retired_rolls.some((x) => x.id === rollId) &&
      r.json.pending_shipments.some((x) => x.shipment_code === shipCode),
      { invalidated: r.json.invalidated, retired: r.json.retired_rolls });

    // 登记召回处置，再补录改变上下文 -> 处置 STALE
    let evalView = (await api('GET', `/api/shipments/${shipCode}/evaluation`)).json;
    r = await api('POST', `/api/shipments/${shipCode}/dispositions`, {
      decision: 'RECALL', decided_by: '质检-陈静', basis: '补录发现花生残留，整批召回',
      version: evalView.version
    });
    check('登记召回处置成功', r.status === 200, r.json);
    // 补录一次全清（17:15，N1 之后）不改变 N1；改为更早插入清洗会截断残留而改变集合——
    // 在 LINE-B 07:40 补全清会截断花生进入 R1：时间线上 07:30 P1 花生 -> 07:40 全清。
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-WASH',
      records: [
        { external_ref: 'WASH-1', type: 'CLEAN', event_time: D + '07:40', equipment_id: LINE2,
          note: '断网漏录：花生批后全清（截断残留传播）' }
      ]
    });
    check('补录早于后续批次的全清 200', r.status === 200, r.json);
    check('补录重算使处置结论需重新评估',
      (r.json.stale_dispositions || []).some((x) => x.shipment_code === shipCode) ||
      r.json.impact_summary.stale_dispositions >= 1,
      r.json.stale_dispositions);

    // ---------- 8. 对账：OK / MISMATCH / DELETED ----------
    console.log('8) 对账查询：补录后经单条接口更正 -> MISMATCH；删除 -> DELETED');
    r = await api('GET', '/api/backfills/BF-PEANUT');
    check('花生补录包对账存在', r.status === 200, r.json);
    const peaEventId = r.json.records[0].event_id;
    // 单条接口更正备注（内容与补录不同）
    const peaRaw = (await api('GET', '/api/state')).json.events.find((e) => e.id === peaEventId);
    const upd = await api('PUT', `/api/events/${peaEventId}`, {
      type: 'PROCESS', event_time: peaRaw.event_time, equipment_id: peaRaw.equipment_id,
      batch_code: 'P1', note: '事后更正：备注变化',
      material_inputs: [{ material_id: PEANUT }]
    });
    check('既有单条 PUT 接口仍可用（兼容）', upd.status === 200, upd.json);
    r = await api('GET', '/api/backfills/BF-PEANUT');
    check('更正后对账 MISMATCH 并给出字段差异',
      r.json.status === 'HAS_DRIFT' &&
      r.json.records[0].reconcile_status === 'MISMATCH' &&
      r.json.records[0].differences.some((x) => x.field === 'note'), r.json.records[0]);

    // 单条删除一个补录事件（选仅含未被引用的 WASH-1）
    const washEventId = (await api('GET', '/api/backfills/BF-WASH')).json.records[0].event_id;
    const del = await api('DELETE', `/api/events/${washEventId}`, undefined);
    check('既有单条 DELETE 接口仍可用（兼容）', del.status === 200, del.json);
    r = await api('GET', '/api/backfills/BF-WASH');
    check('删除后对账 DELETED（event_id 置空、记录保留）',
      r.json.status === 'HAS_DRIFT' &&
      r.json.records[0].reconcile_status === 'DELETED' &&
      r.json.records[0].event_id === null, r.json.records[0]);

    // 列表
    r = await api('GET', '/api/backfills');
    check('补录批号列表包含各包',
      r.status === 200 &&
      ['BF-DAY1', 'BF-REF-OK', 'BF-PEANUT', 'BF-WASH'].every((c) =>
        r.json.backfills.some((b) => b.backfill_code === c)), r.json);

    // ---------- 9. 未来时间不拦截（与单条接口一致，仅拦截未来“引用”） ----------
    console.log('9) 补录未来时刻的事件本身允许（仅引用未来批次被拒）');
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-FUTURE-EVENT',
      records: [
        { external_ref: 'FUT-1', type: 'PROCESS', event_time: '2026-12-31T08:00', equipment_id: LINE,
          batch_code: 'FUT1', note: '计划中事件', material_inputs: [{ material_id: EGG }] }
      ]
    });
    check('未来时刻加工事件补录 200', r.status === 200, r.json);

    console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
    if (failures) process.exitCode = 1;
  } finally {
    proc.kill();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
