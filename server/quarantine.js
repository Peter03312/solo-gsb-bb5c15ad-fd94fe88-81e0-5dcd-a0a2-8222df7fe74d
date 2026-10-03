'use strict';
// 质量隔离令：质检针对“已登记的原料供应批号”签发/解除隔离令。
//
// 基本规则：
//   - 记录原因、操作人与时间；同一批号同时只能有一张生效令（部分唯一索引 + 预检查）；
//   - 批号原有的 FLAGGED 异常标记仅作留痕，与隔离令互不改变（flag 不自动生效，令也不改 flag）；
//   - 隔离令只可针对“已登记批号”；因批号未知而无法排除的批次由系统按追溯自动并入范围，
//     但不能对“批号未知”本身签令（无登记批号可挂）。
//
// 生效范围（每次签发/解除及任何时间线重算后整表重建 quarantine_order_scope）：
//   沿当前最新事件时间线做批号流向追溯，确定命中（CONFIRMED）与
//   因该原料批号未知而无法排除（UNRESOLVED）的批次都受控，并保存传播依据。
//   原料资料或事件更正、补录、换线或清洗后重算时同步刷新；
//   批次脱离所有生效令后自动解除受控。
//
// 受控联动（syncQuarantine，与重算/签发/解除在同一事务内原子完成）：
//   - 受控批次不得登记放行、登记标签卷或确认出货（写入侧守卫明确拒绝）；
//   - 受控批次名下仍 ACTIVE 的标签卷“暂停贴用”（suspended，可逆；不永久停用）：
//     不可核销贴用/作废、不可出货；脱离全部生效令后自动恢复（RETIRED 终态卷不恢复）；
//   - 关联已出货单（SHIPPED）转待评估 PENDING_REVIEW，隔离期间只能登记召回；
//   - 仍为 ACTIVE 的“准予继续流转”结论随上下文变化转需重评（STALE，只增不改）；
//   - 解除或流向变化使批次脱离所有生效令后恢复后续操作；
//     待评估出货单与历史处置结论不自动恢复。

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const PATH_LIMIT = 200; // 范围重建时保存尽可能完整的传播依据（判定本身不受限量影响）

class QuarantineError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'QuarantineError';
    this.status = status;
    this.code = code;
    this.details = details || [];
  }
}

function nonEmpty(body, field, label) {
  const v = String((body && body[field]) || '').trim();
  if (!v) throw new QuarantineError(400, 'INVALID_REQUEST', `请录入${label}`);
  return v;
}

function parseTime(body, field, label) {
  const v = String((body && body[field]) || '').trim();
  if (v && !TIME_RE.test(v)) {
    throw new QuarantineError(400, 'INVALID_REQUEST', `${label}格式应为 YYYY-MM-DDTHH:MM`);
  }
  return v;
}

// ---------- 批号定位（lot_id 单独可用；或 material_id + lot_code） ----------
function resolveTargetLot(db, body) {
  body = body || {};
  const hasLotId = body.lot_id !== undefined && body.lot_id !== null && body.lot_id !== '';
  const hasLotCode = body.lot_code !== undefined && body.lot_code !== null && body.lot_code !== '';
  if (hasLotId && hasLotCode) {
    throw new QuarantineError(400, 'INVALID_REQUEST', 'lot_id 与 lot_code 只能提供其一');
  }
  if (!hasLotId && !hasLotCode) {
    throw new QuarantineError(400, 'INVALID_REQUEST',
      '请指定隔离对象：已登记的供应批号 lot_id（或 material_id + lot_code）');
  }
  if (hasLotId) {
    const lot_id = parseInt(body.lot_id, 10);
    if (!Number.isInteger(lot_id)) {
      throw new QuarantineError(400, 'INVALID_REQUEST', 'lot_id 不合法');
    }
    const lot = db.prepare('SELECT * FROM material_lots WHERE id = ?').get(lot_id);
    if (!lot) throw new QuarantineError(404, 'LOT_NOT_FOUND', `供应批号 #${lot_id} 不存在`);
    return lot;
  }
  const lot_code = String(body.lot_code).trim();
  if (!lot_code) throw new QuarantineError(400, 'INVALID_REQUEST', 'lot_code 不能为空');
  let lot = db.prepare('SELECT * FROM material_lots WHERE lot_code = ?').get(lot_code);
  if (lot) return lot;
  // 批号号在不同原料间允许重名：未给 material_id 且号不唯一/不存在时明确拒绝。
  const material_id = parseInt(body.material_id, 10);
  if (!Number.isInteger(material_id)) {
    throw new QuarantineError(404, 'LOT_NOT_FOUND',
      `供应批号 "${lot_code}" 不存在（或该批号号在多个原料下存在，请同时提供 material_id）`);
  }
  const material = db.prepare('SELECT id, code FROM materials WHERE id = ?').get(material_id);
  if (!material) throw new QuarantineError(404, 'MATERIAL_NOT_FOUND', `原料 #${material_id} 不存在`);
  lot = db.prepare(
    'SELECT * FROM material_lots WHERE material_id = ? AND lot_code = ?'
  ).get(material_id, lot_code);
  if (!lot) {
    throw new QuarantineError(404, 'LOT_NOT_FOUND',
      `原料 ${material.code} 下不存在供应批号 "${lot_code}"`);
  }
  return lot;
}

function getOrderRow(db, idOrCode) {
  const key = String(idOrCode == null ? '' : idOrCode).trim();
  if (!key) return null;
  if (/^\d+$/.test(key)) {
    return db.prepare('SELECT * FROM quarantine_orders WHERE id = ?').get(parseInt(key, 10));
  }
  return db.prepare('SELECT * FROM quarantine_orders WHERE order_code = ?').get(key);
}

function activeOrderForLot(db, lotId) {
  return db.prepare(
    "SELECT * FROM quarantine_orders WHERE material_lot_id = ? AND status = 'ACTIVE' ORDER BY id LIMIT 1"
  ).get(lotId);
}

// ---------- 范围重建：按当前时间线为全部生效令重算并整表替换 scope ----------
// 返回 Map<batchId, Array<{order, classification, evidence}>>（重建后的受控集合）。
function rebuildAllScope(db) {
  const { traceMaterial } = require('./trace');
  const orders = db.prepare(
    "SELECT * FROM quarantine_orders WHERE status = 'ACTIVE' ORDER BY id"
  ).all();

  db.prepare('DELETE FROM quarantine_order_scope').run();
  const ins = db.prepare(
    `INSERT INTO quarantine_order_scope (order_id, batch_id, batch_code, classification, evidence_json)
     VALUES (?, ?, ?, ?, ?)`
  );

  // batchId -> 命中条目（一张批次可同时被多张令覆盖；同令 CONFIRMED 优先于 UNRESOLVED）
  const scopeMap = new Map();
  const addHit = (order, batchId, batchCode, classification, evidence) => {
    const list = scopeMap.get(batchId) || [];
    list.push({
      order_id: order.id,
      order_code: order.order_code,
      material_id: order.material_id,
      material_lot_id: order.material_lot_id,
      classification,
      reason: order.reason || '',
      issued_by: order.issued_by || '',
      issued_at: order.issued_at,
      evidence
    });
    scopeMap.set(batchId, list);
  };

  for (const order of orders) {
    // ① 确定命中：该原料 + 该批号的直接投料传播链。
    const lotTrace = traceMaterial(db, {
      material_id: order.material_id, lot_id: order.material_lot_id, path_limit: PATH_LIMIT
    });
    // ② 因该原料“批号未知”而无法排除：同一原料的未知批号传播链。
    const unknownTrace = traceMaterial(db, {
      material_id: order.material_id, path_limit: PATH_LIMIT
    });

    const seen = new Set();
    for (const b of lotTrace.confirmed_batches) {
      const ev = evidenceOf(b, 'CONFIRMED');
      ins.run(order.id, b.batch_id, b.batch_code, 'CONFIRMED', JSON.stringify(ev));
      addHit(order, b.batch_id, b.batch_code, 'CONFIRMED', ev);
      seen.add(b.batch_id);
    }
    for (const b of unknownTrace.unresolved_batches) {
      if (seen.has(b.batch_id)) continue; // 同令已有确定证据，CONFIRMED 优先
      const ev = evidenceOf(b, 'UNRESOLVED');
      ins.run(order.id, b.batch_id, b.batch_code, 'UNRESOLVED', JSON.stringify(ev));
      addHit(order, b.batch_id, b.batch_code, 'UNRESOLVED', ev);
      seen.add(b.batch_id);
    }
  }
  return scopeMap;
}

function evidenceOf(traceBatch, classification) {
  const key = classification === 'CONFIRMED' ? 'confirmed' : 'unresolved';
  const e = traceBatch.evidence[key] || {};
  return {
    classification,
    chain_count: e.chain_count || 0,
    truncated: !!e.truncated,
    routes: e.routes || { direct: false, batch_reference: false, equipment_residue: false },
    chains: e.chains || []
  };
}

// ---------- 受控集合读取（由 scope 派生表直接查，不重跑追溯） ----------
function controlledHitsForBatch(db, batchId) {
  if (batchId == null) return [];
  return db.prepare(
    `SELECT qos.classification, qos.evidence_json,
            qo.id AS order_id, qo.order_code, qo.material_id, qo.material_lot_id,
            qo.reason, qo.issued_by, qo.issued_at
       FROM quarantine_order_scope qos
       JOIN quarantine_orders qo ON qo.id = qos.order_id
      WHERE qos.batch_id = ? ORDER BY qo.id`
  ).all(batchId).map((r) => ({
    order_id: r.order_id,
    order_code: r.order_code,
    material_id: r.material_id,
    material_lot_id: r.material_lot_id,
    classification: r.classification,
    reason: r.reason || '',
    issued_by: r.issued_by || '',
    issued_at: r.issued_at,
    evidence: safeParse(r.evidence_json)
  }));
}

function controlledBatchIds(db) {
  return new Set(
    db.prepare('SELECT DISTINCT batch_id FROM quarantine_order_scope').all().map((r) => r.batch_id)
  );
}

function safeParse(s) {
  try { return JSON.parse(s || '{}'); } catch (_) { return {}; }
}

function hitDetails(hits) {
  return hits.map((h) => {
    const cls = h.classification === 'CONFIRMED' ? '确定命中' : '因批号未知无法排除';
    return `隔离令 ${h.order_code}（${cls}${h.reason ? `：${h.reason}` : ''}）`;
  });
}

// 写入侧守卫：受控批次不得登记放行 / 标签卷 / 出货。
function assertBatchNotControlled(db, batchId, action) {
  const hits = controlledHitsForBatch(db, batchId);
  if (!hits.length) return;
  throw new QuarantineError(
    409,
    'BATCH_QUARANTINED',
    `该批次当前受 ${hits.length} 张质量隔离令控制，${action}在隔离期间不允许；` +
    '解除隔离或流向变化使批次脱离全部生效令后方可恢复',
    hitDetails(hits)
  );
}

// ---------- 受控联动：卷暂停/恢复 + 已出货单转待评估 ----------
// 必须在已完成范围重建（rebuildAllScope）后的同一事务内调用。
function syncQuarantine(db, scopeMap) {
  const evaluation = require('./evaluation');

  const suspendedRolls = [];
  const resumedRolls = [];
  const suspendedOrderIdsByRoll = new Map();

  const rolls = db.prepare(
    `SELECT lr.id, lr.roll_code, lr.batch_id, lr.suspended, lr.suspended_reason,
            b.code AS batch_code
       FROM label_rolls lr LEFT JOIN batches b ON b.id = lr.batch_id
      WHERE lr.status = 'ACTIVE'`
  ).all();

  const updSuspend = db.prepare(
    'UPDATE label_rolls SET suspended = 1, suspended_reason = ? WHERE id = ?'
  );
  const updResume = db.prepare(
    "UPDATE label_rolls SET suspended = 0, suspended_reason = '' WHERE id = ?"
  );

  for (const roll of rolls) {
    const hits = roll.batch_id == null ? [] : (scopeMap.get(roll.batch_id) || []);
    if (hits.length) {
      const reason = suspensionReason(roll.batch_code, hits);
      if (!roll.suspended) {
        updSuspend.run(reason, roll.id);
        suspendedRolls.push({
          id: roll.id, roll_code: roll.roll_code,
          batch_id: roll.batch_id, batch_code: roll.batch_code || null,
          reason, order_codes: hits.map((h) => h.order_code)
        });
      } else if (roll.suspended_reason !== reason) {
        // 范围变化（新增/解除令、分类变化）时刷新原因，保持暂停状态。
        updSuspend.run(reason, roll.id);
      }
      suspendedOrderIdsByRoll.set(roll.id, hits.map((h) => h.order_code));
    } else if (roll.suspended) {
      // 脱离全部生效令：自动恢复贴用（不影响已永久停用的 RETIRED 卷——上面只查 ACTIVE）。
      updResume.run(roll.id);
      resumedRolls.push({
        id: roll.id, roll_code: roll.roll_code,
        batch_id: roll.batch_id, batch_code: roll.batch_code || null
      });
    }
  }

  // ---- 关联已出货单：批次受控的 SHIPPED 单转待评估（终态不自动恢复）----
  const pendingShipments = [];
  const updShip = db.prepare(
    "UPDATE shipments SET status = 'PENDING_REVIEW', review_reason = ? WHERE id = ? AND status = 'SHIPPED'"
  );
  const shipRows = db.prepare(
    `SELECT s.id, s.batch_id, b.code AS batch_code
       FROM shipments s LEFT JOIN batches b ON b.id = s.batch_id
      WHERE s.status = 'SHIPPED'`
  ).all();
  for (const s of shipRows) {
    const hits = s.batch_id == null ? [] : (scopeMap.get(s.batch_id) || []);
    if (!hits.length) continue;
    const reason = shipmentReason(s.batch_code, hits);
    const info = updShip.run(reason, s.id);
    if (info.changes) {
      // 转待评估推进状态版本：此前查询取得的评估版本立即过期。
      evaluation.bumpVersion(db, s.id);
      const shipments = require('./shipments');
      pendingShipments.push(shipments.formatShipment(
        db.prepare('SELECT * FROM shipments WHERE id = ?').get(s.id), db
      ));
    }
  }

  return { suspendedRolls, resumedRolls, pendingShipments };
}

function orderBrief(h) {
  const cls = h.classification === 'CONFIRMED' ? '确定命中' : '批号未知无法排除';
  return `${h.order_code}（${cls}）`;
}

function suspensionReason(batchCode, hits) {
  const codes = [...new Set(hits.map((h) => h.order_code))].join('、');
  return `批次 ${batchCode || '#?'} 受质量隔离令 ${codes} 控制（${hits.map(orderBrief).join('；')}），` +
         '暂停贴用但不永久停用；脱离全部生效令后自动恢复';
}

function shipmentReason(batchCode, hits) {
  const parts = hitDetails(hits);
  return `批次 ${batchCode || '#?'} 受质量隔离令控制，隔离期间只能召回：${parts.join('；')}`;
}

// ---------- 签发 ----------
function issueOrder(db, body) {
  body = body || {};
  const lot = resolveTargetLot(db, body);
  const reason = nonEmpty(body, 'reason', '签发原因');
  const issued_by = nonEmpty(body, 'issued_by', '签发操作人');
  const issued_at = parseTime(body, 'issued_at', '签发时间');

  const existing = activeOrderForLot(db, lot.id);
  if (existing) {
    throw new QuarantineError(
      409,
      'QUARANTINE_ORDER_EXISTS',
      `供应批号 ${lot.lot_code} 已存在生效中的质量隔离令 ${existing.order_code}，` +
      '同一批号同时只能有一张生效令；如需变更请先解除原令',
      [`${existing.order_code} 签发于 ${existing.issued_at}（${existing.issued_by}）`]
    );
  }

  let orderId;
  let effects = null;
  const tx = db.transaction(() => {
    orderId = db.prepare(
      `INSERT INTO quarantine_orders
         (order_code, material_id, material_lot_id, reason, issued_by, issued_at, status)
       VALUES ('', ?, ?, ?, ?, COALESCE(?, datetime('now')), 'ACTIVE')`
    ).run(lot.material_id, lot.id, reason, issued_by, issued_at || null).lastInsertRowid;
    const order_code = `QUAR-${String(orderId).padStart(4, '0')}`;
    db.prepare('UPDATE quarantine_orders SET order_code = ? WHERE id = ?').run(order_code, orderId);

    const scopeMap = rebuildAllScope(db);
    const q = syncQuarantine(db, scopeMap);
    // 上下文（受控状态、卷暂停）变化：仍为 ACTIVE 的旧结论转需重评（只增不改）。
    const staleDispositions = require('./evaluation').syncStaleDispositions(db);
    effects = {
      suspended_rolls: q.suspendedRolls,
      resumed_rolls: q.resumedRolls,
      pending_shipments: q.pendingShipments,
      stale_dispositions: staleDispositions
    };
  });
  tx();

  return getOrder(db, orderId, { effects });
}

// ---------- 解除 ----------
function releaseOrder(db, idOrCode, body) {
  body = body || {};
  const row = getOrderRow(db, idOrCode);
  if (!row) throw new QuarantineError(404, 'QUARANTINE_ORDER_NOT_FOUND', '质量隔离令不存在');
  if (row.status !== 'ACTIVE') {
    throw new QuarantineError(
      409,
      'QUARANTINE_ORDER_ALREADY_RELEASED',
      `质量隔离令 ${row.order_code} 已于 ${row.released_at || '此前'} 解除，不能重复解除`,
      [`解除人：${row.released_by || '未署名'}${row.released_reason ? `；原因：${row.released_reason}` : ''}`]
    );
  }
  const released_reason = nonEmpty(body, 'reason', '解除原因');
  const released_by = nonEmpty(body, 'released_by', '解除操作人');
  const released_at = parseTime(body, 'released_at', '解除时间');

  let effects = null;
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE quarantine_orders
          SET status = 'RELEASED', released_reason = ?, released_by = ?,
              released_at = COALESCE(?, datetime('now'))
        WHERE id = ? AND status = 'ACTIVE'`
    ).run(released_reason, released_by, released_at || null, row.id);
    const scopeMap = rebuildAllScope(db);
    const q = syncQuarantine(db, scopeMap);
    // 解除后上下文变化：此前 ACTIVE 结论（含隔离期间登记的召回）转需重评；不自动恢复。
    const staleDispositions = require('./evaluation').syncStaleDispositions(db);
    effects = {
      suspended_rolls: q.suspendedRolls,
      resumed_rolls: q.resumedRolls,
      pending_shipments: q.pendingShipments,
      stale_dispositions: staleDispositions
    };
  });
  tx();

  return getOrder(db, row.id, { effects });
}

// ---------- 读取模型 ----------
function lotRef(db, lotId) {
  return db.prepare(
    `SELECT ml.id AS lot_id, ml.lot_code, ml.status AS lot_status,
            ml.flagged_reason, m.id AS material_id, m.code AS material_code,
            m.name AS material_name
       FROM material_lots ml JOIN materials m ON m.id = ml.material_id
      WHERE ml.id = ?`
  ).get(lotId);
}

function scopeRows(db, orderId) {
  return db.prepare(
    'SELECT * FROM quarantine_order_scope WHERE order_id = ? ORDER BY id'
  ).all(orderId);
}

// 合并两张追溯（确定命中 + 批号未知无法排除）的设备残留展示。
function equipmentResidueForOrder(db, order) {
  const { traceMaterial } = require('./trace');
  const out = new Map();
  let lotRes = [];
  try {
    lotRes = traceMaterial(db, {
      material_id: order.material_id, lot_id: order.material_lot_id, path_limit: 60
    }).equipment_residue;
  } catch (_) { lotRes = []; }
  let unknownRes = [];
  try {
    unknownRes = traceMaterial(db, { material_id: order.material_id, path_limit: 60 })
      .equipment_residue;
  } catch (_) { unknownRes = []; }
  for (const r of lotRes.concat(unknownRes)) {
    const cur = out.get(r.equipment_id) || {
      equipment_id: r.equipment_id,
      equipment_code: r.equipment_code,
      equipment_name: r.equipment_name,
      last_cleaned_at: r.last_cleaned_at,
      confirmed_chains: new Set(),
      unresolved_chains: new Set()
    };
    (r.confirmed_chains || []).forEach((c) => cur.confirmed_chains.add(c));
    (r.unresolved_chains || []).forEach((c) => cur.unresolved_chains.add(c));
    out.set(r.equipment_id, cur);
  }
  return [...out.values()].map((r) => ({
    ...r,
    confirmed_chains: [...r.confirmed_chains],
    unresolved_chains: [...r.unresolved_chains]
  })).sort((a, b) => a.equipment_code.localeCompare(b.equipment_code, 'zh'));
}

function formatOrder(row, extra) {
  if (!row) return null;
  return {
    id: row.id,
    order_code: row.order_code,
    material_id: row.material_id,
    material_lot_id: row.material_lot_id,
    reason: row.reason || '',
    issued_by: row.issued_by || '',
    issued_at: row.issued_at,
    status: row.status,
    active: row.status === 'ACTIVE',
    released_reason: row.released_reason || '',
    released_by: row.released_by || '',
    released_at: row.released_at,
    created_at: row.created_at,
    ...(extra || {})
  };
}

function getOrder(db, idOrCode, opts) {
  const row = typeof idOrCode === 'number' || /^\d+$/.test(String(idOrCode))
    ? db.prepare('SELECT * FROM quarantine_orders WHERE id = ?').get(parseInt(idOrCode, 10))
    : getOrderRow(db, idOrCode);
  if (!row) throw new QuarantineError(404, 'QUARANTINE_ORDER_NOT_FOUND', '质量隔离令不存在');

  const ref = lotRef(db, row.material_lot_id) || {};
  const shipments = require('./shipments');

  const scope = scopeRows(db, row.id).map((s) => {
    const ev = safeParse(s.evidence_json);
    const shipRows = s.batch_id
      ? db.prepare('SELECT * FROM shipments WHERE batch_id = ? ORDER BY id').all(s.batch_id)
      : [];
    return {
      batch_id: s.batch_id,
      batch_code: s.batch_code,
      classification: s.classification,
      controlled: true,
      evidence: ev,
      shipments: shipRows.map((x) => shipments.formatShipment(x, db))
    };
  }).sort((a, b) =>
    a.batch_code.localeCompare(b.batch_code, 'zh') || a.batch_id - b.batch_id);

  const confirmed = scope.filter((s) => s.classification === 'CONFIRMED');
  const unresolved = scope.filter((s) => s.classification === 'UNRESOLVED');
  const allShips = scope.flatMap((s) =>
    s.shipments.map((x) => ({ ...x, classification: s.classification })));

  const data = formatOrder(row, {
    material: {
      id: ref.material_id, code: ref.material_code, name: ref.material_name
    },
    lot: {
      id: ref.lot_id, lot_code: ref.lot_code,
      status: ref.lot_status, flagged: ref.lot_status === 'FLAGGED',
      flagged_reason: ref.flagged_reason || ''
    },
    scope: {
      controlled_batch_count: scope.length,
      confirmed_batches: confirmed,
      unresolved_batches: unresolved,
      shipments: {
        confirmed: allShips.filter((s) => s.classification === 'CONFIRMED'),
        unresolved: allShips.filter((s) => s.classification === 'UNRESOLVED')
      }
    },
    // 生效令另附当前设备残留（批号可能仍滞留的设备）；已解除令 scope 为空。
    equipment_residue: row.status === 'ACTIVE' ? equipmentResidueForOrder(db, row) : [],
    refreshed_at: new Date().toISOString(),
    effects: (opts && opts.effects) || undefined
  });
  if (!data.effects) delete data.effects;
  return data;
}

function listOrders(db, { status = null, material_id = null, lot_id = null, activeOnly = false } = {}) {
  let sql =
    `SELECT qo.*,
            m.code AS material_code, m.name AS material_name,
            ml.lot_code AS lot_code, ml.status AS lot_status
       FROM quarantine_orders qo
       JOIN materials m ON m.id = qo.material_id
       JOIN material_lots ml ON ml.id = qo.material_lot_id
      WHERE 1=1`;
  const args = [];
  if (activeOnly || status === 'ACTIVE') { sql += " AND qo.status = 'ACTIVE'"; }
  else if (status === 'RELEASED') { sql += " AND qo.status = 'RELEASED'"; }
  if (material_id != null) { sql += ' AND qo.material_id = ?'; args.push(material_id); }
  if (lot_id != null) { sql += ' AND qo.material_lot_id = ?'; args.push(lot_id); }
  sql += ' ORDER BY qo.id DESC';

  const countStmt = db.prepare(
    'SELECT classification, COUNT(*) AS c FROM quarantine_order_scope WHERE order_id = ? GROUP BY classification'
  );
  return db.prepare(sql).all(...args).map((r) => ({
    ...formatOrder(r),
    material: { id: r.material_id, code: r.material_code, name: r.material_name },
    lot: {
      id: r.material_lot_id, lot_code: r.lot_code,
      status: r.lot_status, flagged: r.lot_status === 'FLAGGED'
    },
    scope_summary: r.status === 'ACTIVE'
      ? (() => {
          const counts = { CONFIRMED: 0, UNRESOLVED: 0 };
          for (const c of countStmt.all(r.id)) counts[c.classification] = c.c;
          return {
            controlled_batch_count: counts.CONFIRMED + counts.UNRESOLVED,
            confirmed_batch_count: counts.CONFIRMED,
            unresolved_batch_count: counts.UNRESOLVED
          };
        })()
      : { controlled_batch_count: 0, confirmed_batch_count: 0, unresolved_batch_count: 0 }
  }));
}

// 供 /api/state：批次 -> 当前受控摘要
function quarantineState(db) {
  const rows = db.prepare(
    `SELECT qos.batch_id, qos.batch_code, qos.classification,
            qo.id AS order_id, qo.order_code, qo.reason, qo.issued_by, qo.issued_at
       FROM quarantine_order_scope qos
       JOIN quarantine_orders qo ON qo.id = qos.order_id
      ORDER BY qo.id`
  ).all();
  const byBatch = new Map();
  for (const r of rows) {
    const list = byBatch.get(r.batch_id) || [];
    list.push({
      order_id: r.order_id, order_code: r.order_code,
      classification: r.classification,
      reason: r.reason || '', issued_by: r.issued_by || '', issued_at: r.issued_at
    });
    byBatch.set(r.batch_id, list);
  }
  return byBatch;
}

module.exports = {
  QuarantineError,
  issueOrder,
  releaseOrder,
  getOrder,
  listOrders,
  rebuildAllScope,
  syncQuarantine,
  controlledHitsForBatch,
  controlledBatchIds,
  assertBatchNotControlled,
  quarantineState,
  activeOrderForLot,
  hitDetails
};
