'use strict';
// 设备检修停机窗口。
//
// 设备检修期间不能记录加工或清洗。操作员按设备登记、调整、取消停机窗口，
// 填写起止时间、原因与操作人，并可查询窗口及其覆盖的冲突事件：
//   - 窗口为左闭右开区间 [start_time, end_time)，起点须早于终点；
//   - 同设备窗口不可重叠（相邻允许：一个窗口的终点可等于另一个的起点）；
//   - 登记或调整若覆盖已有加工/清洗事件，返回冲突事件并整次拒绝；
//   - 单条事件新增/更正、断网整包补录、换线整组预演与确认应用，均按最终设备与
//     时间核对窗口（见 validation.js 的全量校验），命中即指出冲突、整次拒绝；
//   - 停机不等于清洗：窗口不是事件，不改变设备残留或过敏原推导，不触发重算联动。

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

class DowntimeError extends Error {
  constructor(code, message, details, conflicts) {
    super(message);
    this.name = 'DowntimeError';
    this.code = code;
    this.details = details || [];
    this.conflicts = conflicts || [];
  }
}

// 统一为含秒的形式再按字符串比较（事件时间与窗口时间均为本地 ISO 串，同构可比）。
function normTime(t) {
  return String(t).length === 16 ? `${t}:00` : String(t);
}

// ---------- 请求体规范化（设备/起止/原因/操作人） ----------
function normalizeWindowBody(db, body) {
  body = body || {};
  // 设备：equipment_id 或 equipment_code 二选一（与补录接口口径一致）。
  const hasId = body.equipment_id !== undefined && body.equipment_id !== null && body.equipment_id !== '';
  const hasCode = body.equipment_code !== undefined && body.equipment_code !== null && body.equipment_code !== '';
  if (hasId && hasCode) {
    throw new DowntimeError('INVALID_REQUEST', '设备的 equipment_id 与 equipment_code 只能提供其一');
  }
  let equipment = null;
  if (hasId) {
    const id = parseInt(body.equipment_id, 10);
    if (!Number.isInteger(id)) throw new DowntimeError('INVALID_REQUEST', '设备 equipment_id 不合法');
    equipment = db.prepare('SELECT id, code, name FROM equipment WHERE id = ?').get(id);
  } else if (hasCode) {
    const code = String(body.equipment_code).trim();
    if (!code) throw new DowntimeError('INVALID_REQUEST', '设备编码不能为空');
    equipment = db.prepare('SELECT id, code, name FROM equipment WHERE code = ?').get(code);
  } else {
    throw new DowntimeError('INVALID_REQUEST', '请选择设备（equipment_id 或 equipment_code）');
  }
  if (!equipment) {
    throw new DowntimeError('EQUIPMENT_NOT_FOUND', '设备不存在，请先在“原料与设备”页登记设备');
  }

  const start_time = String(body.start_time || '').trim();
  if (!TIME_RE.test(start_time)) {
    throw new DowntimeError('INVALID_REQUEST', '开始时间格式应为 YYYY-MM-DDTHH:MM，例如 2026-10-09T08:00');
  }
  const end_time = String(body.end_time || '').trim();
  if (!TIME_RE.test(end_time)) {
    throw new DowntimeError('INVALID_REQUEST', '结束时间格式应为 YYYY-MM-DDTHH:MM，例如 2026-10-09T12:00');
  }
  if (!(normTime(start_time) < normTime(end_time))) {
    throw new DowntimeError(
      'INVALID_REQUEST',
      `窗口起点须早于终点（左闭右开区间 [起点, 终点)）：收到 [${start_time}, ${end_time})`
    );
  }
  const reason = String(body.reason || '').trim();
  if (!reason) throw new DowntimeError('INVALID_REQUEST', '请填写停机原因 reason');
  const operator = String(body.operator != null ? body.operator : (body.operated_by || '')).trim();
  if (!operator) throw new DowntimeError('INVALID_REQUEST', '请填写操作人 operator');

  return { equipment, start_time, end_time, reason, operator };
}

// ---------- 同设备窗口重叠（相邻允许：终点==起点 不算重叠） ----------
function findOverlaps(db, equipment_id, start_time, end_time, excludeId) {
  const s = normTime(start_time);
  const e = normTime(end_time);
  return db.prepare(
    `SELECT id, equipment_id, start_time, end_time, reason, operator
       FROM equipment_downtime_windows
      WHERE equipment_id = ? AND id != ?
      ORDER BY start_time, id`
  ).all(equipment_id, excludeId || 0)
    .filter((w) => s < normTime(w.end_time) && normTime(w.start_time) < e);
}

// ---------- 窗口覆盖的既有加工/清洗事件（左闭右开） ----------
function findEventConflicts(db, equipment_id, start_time, end_time) {
  const s = normTime(start_time);
  const e = normTime(end_time);
  return db.prepare(
    `SELECT ev.id, ev.event_time, ev.type, ev.equipment_id, ev.note, b.code AS batch_code
       FROM events ev LEFT JOIN batches b ON b.id = ev.batch_id
      WHERE ev.equipment_id = ?
      ORDER BY ev.event_time, ev.id`
  ).all(equipment_id)
    .filter((ev) => {
      const t = normTime(ev.event_time);
      return t >= s && t < e;
    });
}

function formatConflictEvent(ev, equipment) {
  return {
    event_id: ev.id,
    event_time: ev.event_time,
    type: ev.type,
    equipment_id: ev.equipment_id,
    equipment_code: equipment ? equipment.code : undefined,
    batch_code: ev.batch_code || null,
    note: ev.note || ''
  };
}

function conflictDetails(conflicts) {
  return conflicts.map((ev) =>
    `事件 #${ev.id}（${ev.event_time}，${ev.type === 'CLEAN' ? '清洗' : '加工'}` +
    `${ev.batch_code ? `，批次 ${ev.batch_code}` : ''}）`
  );
}

// ---------- 登记 ----------
function createWindow(db, body) {
  const w = normalizeWindowBody(db, body);
  return db.transaction(() => {
    const overlaps = findOverlaps(db, w.equipment.id, w.start_time, w.end_time, 0);
    if (overlaps.length) {
      throw new DowntimeError(
        'WINDOW_OVERLAP',
        `设备 ${w.equipment.code} 在 [${w.start_time}, ${w.end_time}) 与已有停机窗口重叠：` +
        '同设备窗口不可重叠（相邻允许），整次拒绝',
        overlaps.map((o) =>
          `窗口 #${o.id} [${o.start_time}, ${o.end_time})${o.reason ? `（${o.reason}）` : ''}`)
      );
    }
    const conflicts = findEventConflicts(db, w.equipment.id, w.start_time, w.end_time);
    if (conflicts.length) {
      throw new DowntimeError(
        'WINDOW_EVENT_CONFLICT',
        `停机窗口 [${w.start_time}, ${w.end_time}) 覆盖设备 ${w.equipment.code} 已有的 ` +
        `${conflicts.length} 条加工/清洗事件：检修期间不能记录加工或清洗，整次拒绝`,
        conflictDetails(conflicts),
        conflicts.map((ev) => formatConflictEvent(ev, w.equipment))
      );
    }
    const info = db.prepare(
      `INSERT INTO equipment_downtime_windows (equipment_id, start_time, end_time, reason, operator)
       VALUES (?,?,?,?,?)`
    ).run(w.equipment.id, w.start_time, w.end_time, w.reason, w.operator);
    return getWindow(db, info.lastInsertRowid);
  })();
}

// ---------- 调整（全量覆盖：设备/起止/原因/操作人） ----------
function updateWindow(db, id, body) {
  const existing = db.prepare('SELECT id FROM equipment_downtime_windows WHERE id = ?').get(id);
  if (!existing) throw new DowntimeError('WINDOW_NOT_FOUND', `停机窗口 #${id} 不存在`);
  const w = normalizeWindowBody(db, body);
  return db.transaction(() => {
    const overlaps = findOverlaps(db, w.equipment.id, w.start_time, w.end_time, id);
    if (overlaps.length) {
      throw new DowntimeError(
        'WINDOW_OVERLAP',
        `调整后设备 ${w.equipment.code} 在 [${w.start_time}, ${w.end_time}) 与已有停机窗口重叠：` +
        '同设备窗口不可重叠（相邻允许），整次拒绝、原窗口不变',
        overlaps.map((o) =>
          `窗口 #${o.id} [${o.start_time}, ${o.end_time})${o.reason ? `（${o.reason}）` : ''}`)
      );
    }
    const conflicts = findEventConflicts(db, w.equipment.id, w.start_time, w.end_time);
    if (conflicts.length) {
      throw new DowntimeError(
        'WINDOW_EVENT_CONFLICT',
        `调整后窗口 [${w.start_time}, ${w.end_time}) 覆盖设备 ${w.equipment.code} 已有的 ` +
        `${conflicts.length} 条加工/清洗事件：检修期间不能记录加工或清洗，整次拒绝、原窗口不变`,
        conflictDetails(conflicts),
        conflicts.map((ev) => formatConflictEvent(ev, w.equipment))
      );
    }
    db.prepare(
      `UPDATE equipment_downtime_windows
          SET equipment_id = ?, start_time = ?, end_time = ?, reason = ?, operator = ?,
              updated_at = datetime('now')
        WHERE id = ?`
    ).run(w.equipment.id, w.start_time, w.end_time, w.reason, w.operator, id);
    return getWindow(db, id);
  })();
}

// ---------- 取消 ----------
function deleteWindow(db, id) {
  const existing = db.prepare('SELECT id FROM equipment_downtime_windows WHERE id = ?').get(id);
  if (!existing) throw new DowntimeError('WINDOW_NOT_FOUND', `停机窗口 #${id} 不存在`);
  db.prepare('DELETE FROM equipment_downtime_windows WHERE id = ?').run(id);
  return { ok: true, id };
}

// ---------- 查询 ----------
function formatWindow(row, conflictingEvents) {
  return {
    id: row.id,
    equipment_id: row.equipment_id,
    equipment_code: row.equipment_code,
    equipment_name: row.equipment_name,
    start_time: row.start_time,
    end_time: row.end_time,
    reason: row.reason,
    operator: row.operator,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // 正常恒为空（登记/调整与事件写入两侧均拒绝冲突）；保留供对账核查。
    conflicting_events: conflictingEvents || []
  };
}

const WINDOW_SQL =
  `SELECT w.id, w.equipment_id, w.start_time, w.end_time, w.reason, w.operator,
          w.created_at, w.updated_at,
          e.code AS equipment_code, e.name AS equipment_name
     FROM equipment_downtime_windows w
     JOIN equipment e ON e.id = w.equipment_id`;

function getWindow(db, id) {
  const row = db.prepare(`${WINDOW_SQL} WHERE w.id = ?`).get(id);
  if (!row) return null;
  return formatWindow(row, findEventConflicts(db, row.equipment_id, row.start_time, row.end_time)
    .map((ev) => formatConflictEvent(ev, { code: row.equipment_code })));
}

function getWindowOrThrow(db, id) {
  const w = getWindow(db, id);
  if (!w) throw new DowntimeError('WINDOW_NOT_FOUND', `停机窗口 #${id} 不存在`);
  return w;
}

function listWindows(db, { equipment_id = null } = {}) {
  let sql = WINDOW_SQL;
  const args = [];
  if (equipment_id != null) {
    sql += ' WHERE w.equipment_id = ?';
    args.push(equipment_id);
  }
  sql += ' ORDER BY w.start_time, w.id';
  return db.prepare(sql).all(...args).map((row) =>
    formatWindow(row, findEventConflicts(db, row.equipment_id, row.start_time, row.end_time)
      .map((ev) => formatConflictEvent(ev, { code: row.equipment_code }))));
}

// ---------- 全量校验用：事件是否落入停机窗口 ----------
// 给定事件数组（含 id/event_time/type/equipment_id），返回 [{ event, window }]：
// 事件时刻落入同设备某窗口 [start, end) 即冲突（左闭右开）。
function collectWindowConflicts(db, events) {
  const windows = db.prepare(
    'SELECT id, equipment_id, start_time, end_time, reason, operator FROM equipment_downtime_windows'
  ).all();
  if (!windows.length) return [];
  const byEquip = new Map();
  for (const w of windows) {
    const norm = { ...w, _s: normTime(w.start_time), _e: normTime(w.end_time) };
    if (!byEquip.has(w.equipment_id)) byEquip.set(w.equipment_id, []);
    byEquip.get(w.equipment_id).push(norm);
  }
  const conflicts = [];
  for (const ev of events) {
    const ws = byEquip.get(ev.equipment_id);
    if (!ws) continue;
    const t = normTime(ev.event_time);
    for (const w of ws) {
      if (t >= w._s && t < w._e) conflicts.push({ event: ev, window: w });
    }
  }
  return conflicts;
}

module.exports = {
  DowntimeError,
  createWindow,
  updateWindow,
  deleteWindow,
  getWindow,
  getWindowOrThrow,
  listWindows,
  collectWindowConflicts
};
