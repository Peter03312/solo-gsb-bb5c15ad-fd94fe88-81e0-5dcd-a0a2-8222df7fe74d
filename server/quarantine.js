'use strict';
// 质量隔离令：质检针对“原料 + 供应批号”签发/解除的隔离指令。
//
//   签发（POST /api/quarantine-orders）：记录原因、操作人、时间；同一批号同时只能有
//     一张生效令（重复签发明确拒绝）。签发即按当前事件时间线的批号流向确定生效范围：
//     确定命中（CONFIRMED）与因批号未知而无法排除（UNRESOLVED）的批次都受控，
//     传播依据随范围一并保存供展示。
//   解除（POST /api/quarantine-orders/:id/lift）：记录原因、操作人、时间；解除为终态，
//     重复解除明确拒绝。批次脱离所有生效令后才恢复后续操作。
//
// 受控批次的约束（在各自写入接口事务内核对）：
//   - 不得登记放行、不得登记标签卷、不得确认出货；
//   - 已有标签卷暂停贴用（派生状态，不永久停用；脱离全部生效令后自动恢复贴用）；
//   - 关联已出货单转待评估（终态，不自动恢复），有效的“准予继续流转”结论转需重评，
//     隔离期间评估只能登记召回。
//
// 范围刷新：原料资料或事件更正/删除、断网补录、整组换线或清洗变化后，recompute 在
// 同一事务内调用 syncScopes 重算全部生效令的范围并级联业务状态（原子完成）。
// 批号的 FLAGGED 异常标记仍只作留痕，与隔离令互不影响。

const { traceMaterial } = require('./trace');

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

class QuarantineError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'QuarantineError';
    this.code = code;
    this.details = details || [];
  }
}

// ---------- 读取助手 ----------
// 某批次当前被哪些生效令覆盖（空数组 = 未受控）。
function batchOrders(db, batchId) {
  if (batchId == null) return [];
  return db.prepare(
    `SELECT q.id AS order_id, q.order_code, q.reason, q.issued_by, q.issued_at,
            q.lot_id, l.lot_code, l.material_id,
            m.code AS material_code, m.name AS material_name,
            qs.classification
       FROM quarantine_scope qs
       JOIN quarantine_orders q ON q.id = qs.order_id AND q.status = 'ACTIVE'
       JOIN material_lots l ON l.id = q.lot_id
       JOIN materials m ON m.id = l.material_id
      WHERE qs.batch_id = ?
      ORDER BY q.id`
  ).all(batchId);
}

function isBatchControlled(db, batchId) {
  if (batchId == null) return false;
  return !!db.prepare(
    `SELECT 1 AS x FROM quarantine_scope qs
       JOIN quarantine_orders q ON q.id = qs.order_id
      WHERE q.status = 'ACTIVE' AND qs.batch_id = ? LIMIT 1`
  ).get(batchId);
}

// 全部受控批次 -> 生效令列表（/api/state 一次性取数用）。
function controlledOrdersByBatch(db) {
  const rows = db.prepare(
    `SELECT qs.batch_id, q.id AS order_id, q.order_code, q.reason,
            q.issued_by, q.issued_at, q.lot_id,
            l.lot_code, l.material_id, m.code AS material_code, m.name AS material_name,
            qs.classification
       FROM quarantine_scope qs
       JOIN quarantine_orders q ON q.id = qs.order_id AND q.status = 'ACTIVE'
       JOIN material_lots l ON l.id = q.lot_id
       JOIN materials m ON m.id = l.material_id
      ORDER BY q.id`
  ).all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.batch_id)) map.set(r.batch_id, []);
    map.get(r.batch_id).push(r);
  }
  return map;
}

// 各批号当前生效令（供批号列表/整页状态标注）。
function activeOrdersByLot(db) {
  const map = new Map();
  db.prepare(
    `SELECT q.lot_id, q.id AS order_id, q.order_code, q.reason, q.issued_by, q.issued_at
       FROM quarantine_orders q WHERE q.status = 'ACTIVE' ORDER BY q.id`
  ).all().forEach((r) => map.set(r.lot_id, r));
  return map;
}

function describeOrders(orders) {
  return orders
    .map((o) => `${o.order_code}（${o.material_name} 批号 ${o.lot_code}）`)
    .join('、');
}

// ---------- 范围刷新（在 recompute / 签发事务内调用） ----------
// 按当前最新合法时间线重算全部生效令的受控范围并整体重写；
// 对新进入受控范围的批次级联：关联已出货单转待评估（终态）、
// 有效的“准予继续流转”结论转需重评。返回范围变化与级联结果。
function syncScopes(db) {
  const activeOrders = db.prepare(
    `SELECT q.id, q.order_code, q.lot_id, q.reason, q.issued_by, q.issued_at,
            l.lot_code, l.material_id, m.code AS material_code, m.name AS material_name
       FROM quarantine_orders q
       JOIN material_lots l ON l.id = q.lot_id
       JOIN materials m ON m.id = l.material_id
      WHERE q.status = 'ACTIVE'
      ORDER BY q.id`
  ).all();

  const before = new Set(
    db.prepare(
      `SELECT DISTINCT qs.batch_id FROM quarantine_scope qs
         JOIN quarantine_orders q ON q.id = qs.order_id
        WHERE q.status = 'ACTIVE'`
    ).all().map((r) => r.batch_id)
  );

  // 整体重写生效令范围（解除令的范围行已在解除时删除）。
  db.prepare(
    `DELETE FROM quarantine_scope WHERE order_id IN
       (SELECT id FROM quarantine_orders WHERE status = 'ACTIVE')`
  ).run();
  const ins = db.prepare(
    `INSERT INTO quarantine_scope (order_id, batch_id, classification, evidence_json)
     VALUES (?,?,?,?)`
  );

  const after = new Set();
  const ordersByBatch = new Map();
  const pushOrder = (bid, order, classification) => {
    if (!ordersByBatch.has(bid)) ordersByBatch.set(bid, []);
    ordersByBatch.get(bid).push({ ...order, classification });
  };
  for (const order of activeOrders) {
    // 批号/原料档案受删除约束保护（有隔离令的批号不可删除），追溯必然可计算。
    const trace = traceMaterial(db, { material_id: order.material_id, lot_id: order.lot_id });
    for (const b of trace.confirmed_batches) {
      ins.run(order.id, b.batch_id, 'CONFIRMED', JSON.stringify(b.evidence));
      after.add(b.batch_id);
      pushOrder(b.batch_id, order, 'CONFIRMED');
    }
    for (const b of trace.unresolved_batches) {
      ins.run(order.id, b.batch_id, 'UNRESOLVED', JSON.stringify(b.evidence));
      after.add(b.batch_id);
      pushOrder(b.batch_id, order, 'UNRESOLVED');
    }
  }

  const newly = [...after].filter((b) => !before.has(b));
  const released = [...before].filter((b) => !after.has(b));

  let cascade = { pendingShipments: [], staleDispositions: [] };
  if (newly.length) {
    cascade = cascadeNewlyControlled(db, newly, ordersByBatch);
  }

  const codeOf = batchCodeMapper(db);
  return {
    newly_controlled: newly.map((bid) => ({ batch_id: bid, batch_code: codeOf(bid) })),
    released: released.map((bid) => ({ batch_id: bid, batch_code: codeOf(bid) })),
    pendingShipments: cascade.pendingShipments,
    staleDispositions: cascade.staleDispositions
  };
}

function batchCodeMapper(db) {
  const map = new Map(
    db.prepare('SELECT id, code FROM batches').all().map((b) => [b.id, b.code])
  );
  return (bid) => map.get(bid) || `#${bid}`;
}

// 新受控批次的级联（与范围刷新同一事务）：
//   1) 关联已出货单 SHIPPED -> PENDING_REVIEW（终态，不自动恢复），并推进状态版本；
//   2) 这些批次出货单上仍为 ACTIVE 的“准予继续流转”结论 -> STALE（需重新评估）；
//      召回结论不受影响（隔离期间召回始终允许）。
function cascadeNewlyControlled(db, batchIds, ordersByBatch) {
  const evaluation = require('./evaluation');
  const shipments = require('./shipments');

  const pendingShipments = [];
  const staleDispositions = [];

  const selShip = db.prepare(
    `SELECT id FROM shipments WHERE batch_id = ? AND status = 'SHIPPED' ORDER BY id`
  );
  const updShip = db.prepare(
    `UPDATE shipments SET status = 'PENDING_REVIEW', review_reason = ?
      WHERE id = ? AND status = 'SHIPPED'`
  );
  const selDisp = db.prepare(
    `SELECT d.id, d.shipment_id, s.shipment_code
       FROM shipment_dispositions d
       JOIN shipments s ON s.id = d.shipment_id
      WHERE d.life_status = 'ACTIVE' AND d.decision = 'CONTINUE' AND s.batch_id = ?
      ORDER BY d.id`
  );
  const updDisp = db.prepare(
    `UPDATE shipment_dispositions SET life_status = 'STALE', stale_reason = ? WHERE id = ?`
  );

  for (const bid of batchIds) {
    const orderDesc = describeOrders(ordersByBatch.get(bid) || []);
    // 1) 关联已出货单转待评估
    for (const s of selShip.all(bid)) {
      const reason =
        `批次已纳入质量隔离令生效范围（${orderDesc}）：关联已出货单转待评估，` +
        '隔离期间只能登记召回；待评估状态不自动恢复';
      const info = updShip.run(reason, s.id);
      if (info.changes) {
        // 转待评估即推进状态版本：此前查询取得的版本立即过期。
        evaluation.bumpVersion(db, s.id);
        pendingShipments.push(shipments.formatShipment(
          db.prepare('SELECT * FROM shipments WHERE id = ?').get(s.id), db));
      }
    }
    // 2) 有效的“准予继续流转”结论转需重评
    for (const d of selDisp.all(bid)) {
      const reason =
        `批次新纳入质量隔离令生效范围（${orderDesc}），隔离期间只能召回，` +
        '原“准予继续流转”结论需重新评估';
      updDisp.run(reason, d.id);
      staleDispositions.push({
        disposition_id: d.id,
        shipment_id: d.shipment_id,
        shipment_code: d.shipment_code,
        decision: 'CONTINUE',
        decision_text: '准予继续流转',
        reason
      });
    }
  }
  return { pendingShipments, staleDispositions };
}

// ---------- 签发 ----------
// body: { lot_id, reason, issued_by, issued_at? }
function issueOrder(db, body) {
  body = body || {};
  const lot_id = parseInt(body.lot_id, 10);
  if (!Number.isInteger(lot_id)) {
    throw new QuarantineError('INVALID_REQUEST', '请指定供应批号 lot_id');
  }
  const reason = String(body.reason || '').trim();
  if (!reason) throw new QuarantineError('INVALID_REQUEST', '请录入签发原因');
  const issued_by = String(body.issued_by || '').trim();
  if (!issued_by) throw new QuarantineError('INVALID_REQUEST', '请录入签发操作人');
  const issued_at = String(body.issued_at || '').trim();
  if (issued_at && !TIME_RE.test(issued_at)) {
    throw new QuarantineError('INVALID_REQUEST', '签发时间格式应为 YYYY-MM-DDTHH:MM');
  }
  const lot = db.prepare(
    `SELECT l.id, l.lot_code, l.material_id, m.code AS material_code, m.name AS material_name
       FROM material_lots l JOIN materials m ON m.id = l.material_id
      WHERE l.id = ?`
  ).get(lot_id);
  if (!lot) throw new QuarantineError('LOT_NOT_FOUND', `供应批号 #${lot_id} 不存在`);

  let orderId;
  let sync;
  // 签发、范围计算与关联业务状态更新在同一事务内原子完成。
  const tx = db.transaction(() => {
    const dup = db.prepare(
      `SELECT id, order_code FROM quarantine_orders WHERE lot_id = ? AND status = 'ACTIVE'`
    ).get(lot_id);
    if (dup) {
      throw new QuarantineError(
        'QUARANTINE_EXISTS',
        `批号 ${lot.lot_code}（${lot.material_name}）已存在生效中的质量隔离令 ${dup.order_code}；` +
        '同一批号同时只能有一张生效令，请先解除原令'
      );
    }
    try {
      orderId = db.prepare(
        `INSERT INTO quarantine_orders (order_code, lot_id, reason, status, issued_by, issued_at)
         VALUES ('', ?, ?, 'ACTIVE', ?, COALESCE(?, datetime('now')))`
      ).run(lot_id, reason, issued_by, issued_at || null).lastInsertRowid;
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        throw new QuarantineError(
          'QUARANTINE_EXISTS',
          `批号 ${lot.lot_code}（${lot.material_name}）已存在生效中的质量隔离令；` +
          '同一批号同时只能有一张生效令，请先解除原令'
        );
      }
      throw err;
    }
    const code = `QUAR-${String(orderId).padStart(4, '0')}`;
    db.prepare('UPDATE quarantine_orders SET order_code = ? WHERE id = ?').run(code, orderId);
    // 按当前事件时间线确定生效范围并级联关联业务状态（同事务）。
    sync = syncScopes(db);
  });
  tx();

  return {
    ok: true,
    order: getOrder(db, orderId),
    quarantine: { newly_controlled: sync.newly_controlled, released: sync.released },
    pending_shipments: sync.pendingShipments,
    stale_dispositions: sync.staleDispositions
  };
}

// ---------- 解除 ----------
// body: { lifted_by, lift_reason (或 reason), lifted_at? }
function liftOrder(db, id, body) {
  body = body || {};
  const orderId = parseInt(id, 10);
  if (!Number.isInteger(orderId)) {
    throw new QuarantineError('INVALID_REQUEST', '隔离令 id 不合法');
  }
  const lifted_by = String(body.lifted_by || '').trim();
  if (!lifted_by) throw new QuarantineError('INVALID_REQUEST', '请录入解除操作人');
  const lift_reason = String(body.lift_reason || body.reason || '').trim();
  if (!lift_reason) throw new QuarantineError('INVALID_REQUEST', '请录入解除原因');
  const lifted_at = String(body.lifted_at || '').trim();
  if (lifted_at && !TIME_RE.test(lifted_at)) {
    throw new QuarantineError('INVALID_REQUEST', '解除时间格式应为 YYYY-MM-DDTHH:MM');
  }

  let released = [];
  // 解除与范围收回在同一事务内原子完成；待评估单与历史处置结论不自动恢复。
  const tx = db.transaction(() => {
    const order = db.prepare('SELECT * FROM quarantine_orders WHERE id = ?').get(orderId);
    if (!order) throw new QuarantineError('ORDER_NOT_FOUND', `质量隔离令 #${orderId} 不存在`);
    if (order.status !== 'ACTIVE') {
      throw new QuarantineError(
        'QUARANTINE_NOT_ACTIVE',
        `质量隔离令 ${order.order_code} 已于 ${order.lifted_at} 由 ${order.lifted_by} 解除；` +
        '解除为终态，不能重复解除'
      );
    }
    // 解除前范围快照（留痕），随后删除范围行。
    const scopeRows = db.prepare(
      `SELECT qs.batch_id, qs.classification, b.code AS batch_code
         FROM quarantine_scope qs LEFT JOIN batches b ON b.id = qs.batch_id
        WHERE qs.order_id = ? ORDER BY qs.batch_id`
    ).all(orderId);
    const snapshot = scopeRows.map((r) => ({
      batch_id: r.batch_id,
      batch_code: r.batch_code || `#${r.batch_id}`,
      classification: r.classification
    }));
    db.prepare(
      `UPDATE quarantine_orders
          SET status = 'LIFTED', lifted_by = ?, lifted_at = COALESCE(?, datetime('now')),
              lift_reason = ?, lifted_scope_json = ?
        WHERE id = ?`
    ).run(lifted_by, lifted_at || null, lift_reason, JSON.stringify(snapshot), orderId);
    db.prepare('DELETE FROM quarantine_scope WHERE order_id = ?').run(orderId);
    // 仍被其它生效令覆盖的批次不算脱离，只有脱离所有生效令的批次才恢复后续操作。
    const still = new Set(
      db.prepare(
        `SELECT DISTINCT qs.batch_id FROM quarantine_scope qs
           JOIN quarantine_orders q ON q.id = qs.order_id
          WHERE q.status = 'ACTIVE'`
      ).all().map((r) => r.batch_id)
    );
    released = snapshot
      .filter((r) => !still.has(r.batch_id))
      .map((r) => ({ batch_id: r.batch_id, batch_code: r.batch_code }));
  });
  tx();

  return {
    ok: true,
    order: getOrder(db, orderId),
    quarantine: { newly_controlled: [], released },
    note: '隔离令已解除：脱离全部生效令的批次恢复放行/标签卷/出货登记与标签卷贴用；' +
          '已转待评估的出货单与历史处置结论不自动恢复'
  };
}

// ---------- 读取模型 ----------
function shipmentBriefs(db, batchId) {
  const rows = db.prepare(
    `SELECT id, shipment_code, status, review_reason, ship_qty, shipped_at, shipped_by
       FROM shipments WHERE batch_id = ? ORDER BY id`
  ).all(batchId);
  const dispStmt = db.prepare(
    `SELECT decision, life_status, stale_reason FROM shipment_dispositions
      WHERE shipment_id = ? ORDER BY id DESC LIMIT 1`
  );
  return rows.map((s) => {
    const d = dispStmt.get(s.id);
    return {
      shipment_id: s.id,
      shipment_code: s.shipment_code,
      status: s.status,
      pending_review: s.status === 'PENDING_REVIEW',
      review_reason: s.review_reason || '',
      ship_qty: s.ship_qty,
      shipped_at: s.shipped_at,
      shipped_by: s.shipped_by,
      current_disposition: d ? {
        decision: d.decision,
        decision_text: d.decision === 'CONTINUE' ? '准予继续流转' : '召回',
        life_status: d.life_status,
        needs_review: d.life_status === 'STALE',
        stale_reason: d.stale_reason || ''
      } : null
    };
  });
}

function scopeBatches(db, orderId, { withEvidence }) {
  const rows = db.prepare(
    `SELECT qs.batch_id, qs.classification, qs.evidence_json,
            b.code AS batch_code, ev.event_time AS produced_at, eq.code AS equipment_code
       FROM quarantine_scope qs
       LEFT JOIN batches b ON b.id = qs.batch_id
       LEFT JOIN events ev ON ev.batch_id = qs.batch_id
       LEFT JOIN equipment eq ON eq.id = ev.equipment_id
      WHERE qs.order_id = ?
      ORDER BY ev.event_time, qs.batch_id`
  ).all(orderId);
  return rows.map((r) => {
    const base = {
      batch_id: r.batch_id,
      batch_code: r.batch_code || `#${r.batch_id}`,
      classification: r.classification, // CONFIRMED 确定命中 / UNRESOLVED 批号未知无法排除
      produced_at: r.produced_at || null,
      equipment_code: r.equipment_code || null
    };
    if (!withEvidence) return base;
    let evidence = null;
    try { evidence = JSON.parse(r.evidence_json || 'null'); } catch (_) { evidence = null; }
    return {
      ...base,
      evidence, // 传播依据：confirmed/unresolved 各自的链、途径与截断标记
      shipments: shipmentBriefs(db, r.batch_id)
    };
  });
}

function formatOrder(row, db, { withEvidence = false } = {}) {
  const active = row.status === 'ACTIVE';
  const order = {
    id: row.id,
    order_code: row.order_code,
    lot_id: row.lot_id,
    lot_code: row.lot_code,
    material_id: row.material_id,
    material_code: row.material_code,
    material_name: row.material_name,
    reason: row.reason,
    status: row.status, // ACTIVE 生效中 / LIFTED 已解除（终态）
    active,
    issued_by: row.issued_by,
    issued_at: row.issued_at,
    lifted_by: row.lifted_by || null,
    lifted_at: row.lifted_at || null,
    lift_reason: row.lift_reason || '',
    created_at: row.created_at
  };
  if (active) {
    const batches = scopeBatches(db, row.id, { withEvidence });
    const affected = withEvidence
      ? batches.flatMap((b) => b.shipments.map((s) => ({
        ...s, batch_id: b.batch_id, batch_code: b.batch_code
      })))
      : [];
    order.scope = {
      batch_count: batches.length,
      confirmed_count: batches.filter((b) => b.classification === 'CONFIRMED').length,
      unresolved_count: batches.filter((b) => b.classification === 'UNRESOLVED').length,
      batches
    };
    if (withEvidence) order.affected_shipments = affected;
  } else {
    // 已解除：当前范围为空；解除时范围快照留痕展示。
    let liftedScope = [];
    try { liftedScope = JSON.parse(row.lifted_scope_json || '[]'); } catch (_) { liftedScope = []; }
    order.scope = { batch_count: 0, confirmed_count: 0, unresolved_count: 0, batches: [] };
    order.lifted_scope = liftedScope;
  }
  return order;
}

const ORDER_SELECT =
  `SELECT q.*, l.lot_code, l.material_id, m.code AS material_code, m.name AS material_name
     FROM quarantine_orders q
     JOIN material_lots l ON l.id = q.lot_id
     JOIN materials m ON m.id = l.material_id`;

function getOrder(db, id, { withEvidence = true } = {}) {
  const row = db.prepare(`${ORDER_SELECT} WHERE q.id = ?`).get(id);
  return row ? formatOrder(row, db, { withEvidence }) : null;
}

// 列表：?status=ACTIVE|LIFTED、?lot_id= 过滤；范围只带批次清单（传播依据见单条查询）。
function listOrders(db, { status = null, lot_id = null } = {}) {
  let sql = ORDER_SELECT;
  const args = [];
  const where = [];
  if (status) { where.push('q.status = ?'); args.push(status); }
  if (lot_id != null) { where.push('q.lot_id = ?'); args.push(lot_id); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY q.id';
  return db.prepare(sql).all(...args)
    .map((row) => formatOrder(row, db, { withEvidence: false }));
}

module.exports = {
  QuarantineError,
  issueOrder,
  liftOrder,
  getOrder,
  listOrders,
  syncScopes,
  batchOrders,
  isBatchControlled,
  controlledOrdersByBatch,
  activeOrdersByLot,
  describeOrders
};
