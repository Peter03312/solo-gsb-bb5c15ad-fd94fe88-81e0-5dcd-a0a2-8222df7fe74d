'use strict';
// 设备检修停机窗口 端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务（空白库，自建数据），验证：
//   登记/调整/取消/查询停机窗口（起止、原因、操作人）；
//   左闭右开区间、起点须早于终点；同设备不可重叠、相邻允许；
//   登记/调整覆盖已有加工/清洗事件 -> 返回冲突事件并整次拒绝；
//   单条事件新增/更正按最终设备与时间核对窗口（命中整次拒绝、不改变现有事件）；
//   断网整包补录命中窗口 -> 整包回滚（不写事件、不写补录台账）；
//   已成功补录的同号同内容重试仍返回原结果（幂等优先于窗口核对）；
//   换线预演命中窗口 -> 拒绝且不写正式数据；窗口变动后旧预演确认须重新核对（版本过期）；
//   停机不等于清洗：窗口不改变设备残留或过敏原推导。
//   node scripts/test-downtime.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39153';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downtime-test-'));
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
    const LINE = await newId('/api/equipment', { code: 'LINE-A', name: '烘焙A线' });
    const LINE2 = await newId('/api/equipment', { code: 'LINE-B', name: '烘焙B线' });
    const state = async () => (await api('GET', '/api/state')).json;
    const eventCount = async () => (await state()).events.length;
    let r;

    // ---------- 1. 入参校验 ----------
    console.log('1) 登记窗口入参校验（缺设备/设备不存在/时间格式/起点须早于终点/缺原因/缺操作人）');
    r = await api('POST', '/api/downtime-windows', { start_time: '2026-10-05T08:00', end_time: '2026-10-05T10:00', reason: '检修', operator: '张工' });
    check('缺设备 -> 400 INVALID_REQUEST', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/downtime-windows', { equipment_id: 999999, start_time: '2026-10-05T08:00', end_time: '2026-10-05T10:00', reason: '检修', operator: '张工' });
    check('设备不存在 -> 404 EQUIPMENT_NOT_FOUND', r.status === 404 && r.json.code === 'EQUIPMENT_NOT_FOUND', r.json);
    r = await api('POST', '/api/downtime-windows', { equipment_id: LINE, start_time: '2026-10-05 08:00', end_time: '2026-10-05T10:00', reason: '检修', operator: '张工' });
    check('开始时间格式错 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/downtime-windows', { equipment_id: LINE, start_time: '2026-10-05T10:00', end_time: '2026-10-05T10:00', reason: '检修', operator: '张工' });
    check('起点=终点 -> 400（起点须早于终点）', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/downtime-windows', { equipment_id: LINE, start_time: '2026-10-05T12:00', end_time: '2026-10-05T08:00', reason: '检修', operator: '张工' });
    check('起点>终点 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/downtime-windows', { equipment_id: LINE, start_time: '2026-10-05T08:00', end_time: '2026-10-05T10:00', operator: '张工' });
    check('缺停机原因 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/downtime-windows', { equipment_id: LINE, start_time: '2026-10-05T08:00', end_time: '2026-10-05T10:00', reason: '检修' });
    check('缺操作人 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/downtime-windows', { equipment_id: LINE, equipment_code: 'LINE-A', start_time: '2026-10-05T08:00', end_time: '2026-10-05T10:00', reason: '检修', operator: '张工' });
    check('id 与编码同传 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    check('全部拒绝后无窗口', (await api('GET', '/api/downtime-windows')).json.windows.length === 0);

    // ---------- 2. 登记与同设备重叠（相邻允许） ----------
    console.log('2) 登记窗口与同设备重叠校验（相邻允许、跨设备不相关）');
    r = await api('POST', '/api/downtime-windows', { equipment_code: 'LINE-A', start_time: '2026-10-05T08:00', end_time: '2026-10-05T10:00', reason: '月度检修', operator: '设备科-张工' });
    check('按 equipment_code 登记成功', r.status === 200 && r.json.id && r.json.equipment_code === 'LINE-A', r.json);
    const W1 = r.json.id;
    check('返回窗口含起止/原因/操作人', r.json.start_time === '2026-10-05T08:00' && r.json.end_time === '2026-10-05T10:00' && r.json.reason === '月度检修' && r.json.operator === '设备科-张工', r.json);

    const overlapBodies = [
      ['部分重叠', '2026-10-05T09:00', '2026-10-05T11:00'],
      ['包含既有', '2026-10-05T07:00', '2026-10-05T12:00'],
      ['被既有包含', '2026-10-05T08:30', '2026-10-05T09:30'],
      ['同起点', '2026-10-05T08:00', '2026-10-05T09:00'],
      ['同终点', '2026-10-05T09:00', '2026-10-05T10:00']
    ];
    for (const [label, s, e] of overlapBodies) {
      r = await api('POST', '/api/downtime-windows', { equipment_id: LINE, start_time: s, end_time: e, reason: 'x', operator: 'y' });
      check(`${label} -> 409 WINDOW_OVERLAP`, r.status === 409 && r.json.code === 'WINDOW_OVERLAP', r.json);
    }
    r = await api('POST', '/api/downtime-windows', { equipment_id: LINE, start_time: '2026-10-05T06:00', end_time: '2026-10-05T08:00', reason: '前段保养', operator: '张工' });
    check('相邻（终点=既有起点）允许', r.status === 200, r.json);
    const W6 = r.json.id;
    r = await api('POST', '/api/downtime-windows', { equipment_id: LINE, start_time: '2026-10-05T10:00', end_time: '2026-10-05T12:00', reason: '后段保养', operator: '张工' });
    check('相邻（起点=既有终点）允许', r.status === 200, r.json);
    const W7 = r.json.id;
    r = await api('POST', '/api/downtime-windows', { equipment_id: LINE2, start_time: '2026-10-05T08:00', end_time: '2026-10-05T10:00', reason: '它设备同时段', operator: '李工' });
    check('不同设备同时段允许', r.status === 200, r.json);
    const W8 = r.json.id;

    // ---------- 3. 登记/调整覆盖已有事件 -> 返回冲突事件并整次拒绝 ----------
    console.log('3) 覆盖已有加工/清洗事件的窗口登记被拒绝并返回冲突事件');
    const procEvent = await newId('/api/events', { type: 'PROCESS', event_time: '2026-10-06T08:00', equipment_id: LINE, batch_code: 'B-W1', material_ids: [MILK], note: '窗口外加工' });
    const cleanEvent = await newId('/api/events', { type: 'CLEAN', event_time: '2026-10-06T09:00', equipment_id: LINE, note: '窗口外清洗' });
    const winCountBefore = (await api('GET', '/api/downtime-windows')).json.windows.length;

    r = await api('POST', '/api/downtime-windows', { equipment_id: LINE, start_time: '2026-10-06T07:00', end_time: '2026-10-06T10:00', reason: '覆盖两条事件', operator: '张工' });
    check('覆盖加工+清洗 -> 409 WINDOW_EVENT_CONFLICT', r.status === 409 && r.json.code === 'WINDOW_EVENT_CONFLICT', r.json);
    check('返回 2 条冲突事件（含事件号/类型/批次）',
      Array.isArray(r.json.conflicts) && r.json.conflicts.length === 2 &&
      r.json.conflicts.some((c) => c.event_id === procEvent && c.type === 'PROCESS' && c.batch_code === 'B-W1') &&
      r.json.conflicts.some((c) => c.event_id === cleanEvent && c.type === 'CLEAN'), r.json);
    r = await api('POST', '/api/downtime-windows', { equipment_id: LINE, start_time: '2026-10-06T08:00', end_time: '2026-10-06T09:00', reason: '左闭边界', operator: '张工' });
    check('左闭：起点时刻的事件被覆盖 -> 409 且冲突 1 条', r.status === 409 && r.json.conflicts.length === 1 && r.json.conflicts[0].event_id === procEvent, r.json);
    r = await api('POST', '/api/downtime-windows', { equipment_id: LINE, start_time: '2026-10-06T07:00', end_time: '2026-10-06T08:00', reason: '右开边界', operator: '张工' });
    check('右开：终点时刻的事件不被覆盖 -> 登记成功', r.status === 200, r.json);
    const W9 = r.json.id;
    check('冲突拒绝未留下窗口（整次拒绝）',
      (await api('GET', '/api/downtime-windows')).json.windows.length === winCountBefore + 1);

    // ---------- 4. 调整窗口 ----------
    console.log('4) 调整窗口：合法调整、重叠拒绝、覆盖事件拒绝（原窗口不变）、未知窗口');
    r = await api('PUT', `/api/downtime-windows/${W1}`, { equipment_id: LINE, start_time: '2026-10-05T08:00', end_time: '2026-10-05T10:00', reason: '月度检修（改）', operator: '设备科-王工' });
    check('原范围调整原因/操作人成功（排除自身重叠检查）', r.status === 200 && r.json.reason === '月度检修（改）' && r.json.operator === '设备科-王工', r.json);
    r = await api('PUT', `/api/downtime-windows/${W1}`, { equipment_id: LINE, start_time: '2026-10-05T07:00', end_time: '2026-10-05T09:00', reason: '与相邻重叠', operator: '张工' });
    check('调整与相邻窗口重叠 -> 409 WINDOW_OVERLAP', r.status === 409 && r.json.code === 'WINDOW_OVERLAP', r.json);
    r = await api('PUT', `/api/downtime-windows/${W1}`, { equipment_id: LINE, start_time: '2026-10-06T08:30', end_time: '2026-10-06T09:30', reason: '覆盖清洗', operator: '张工' });
    check('调整覆盖已有事件 -> 409 WINDOW_EVENT_CONFLICT', r.status === 409 && r.json.code === 'WINDOW_EVENT_CONFLICT' && r.json.conflicts.length === 1 && r.json.conflicts[0].event_id === cleanEvent, r.json);
    r = await api('GET', `/api/downtime-windows/${W1}`);
    check('两次拒绝后原窗口不变', r.json.start_time === '2026-10-05T08:00' && r.json.reason === '月度检修（改）', r.json);
    r = await api('PUT', '/api/downtime-windows/999999', { equipment_id: LINE, start_time: '2026-10-05T08:00', end_time: '2026-10-05T10:00', reason: 'x', operator: 'y' });
    check('调整不存在窗口 -> 404 WINDOW_NOT_FOUND', r.status === 404 && r.json.code === 'WINDOW_NOT_FOUND', r.json);

    // ---------- 5. 单条事件新增/更正核对窗口 ----------
    console.log('5) 单条事件新增/更正按最终设备与时间核对窗口（命中整次拒绝）');
    let n0 = await eventCount();
    r = await api('POST', '/api/events', { type: 'PROCESS', event_time: '2026-10-05T08:30', equipment_id: LINE, batch_code: 'B-BAD1', material_ids: [MILK] });
    check('窗口内新增加工 -> 400，details 指出窗口', r.status === 400 && r.json.details && r.json.details.some((d) => d.includes('停机窗口') && d.includes('检修期间不能记录加工或清洗')), r.json);
    r = await api('POST', '/api/events', { type: 'CLEAN', event_time: '2026-10-05T09:00', equipment_id: LINE, note: '窗口内清洗' });
    check('窗口内新增清洗 -> 400', r.status === 400 && r.json.details.some((d) => d.includes('停机窗口')), r.json);
    r = await api('POST', '/api/events', { type: 'PROCESS', event_time: '2026-10-05T10:00', equipment_id: LINE, batch_code: 'B-BAD2', material_ids: [MILK] });
    check('相邻后段窗口起点（左闭）-> 400', r.status === 400 && r.json.details.some((d) => d.includes('停机窗口')), r.json);
    check('拒绝后事件数不变', (await eventCount()) === n0);
    r = await api('POST', '/api/events', { type: 'PROCESS', event_time: '2026-10-05T12:00', equipment_id: LINE, batch_code: 'B-W3', material_ids: [EGG], note: '窗口终点（右开）允许' });
    check('窗口终点时刻（右开）允许', r.status === 200, r.json);
    const edgeEvent = r.json.id;
    r = await api('POST', '/api/events', { type: 'PROCESS', event_time: '2026-10-05T08:30', equipment_id: LINE2, batch_code: 'B-BAD3', material_ids: [MILK] });
    check('它设备窗口内同样拒绝', r.status === 400 && r.json.details.some((d) => d.includes('停机窗口')), r.json);

    r = await api('PUT', `/api/events/${procEvent}`, { type: 'PROCESS', event_time: '2026-10-05T08:30', equipment_id: LINE, batch_code: 'B-W1', material_ids: [MILK], note: '试图移入窗口' });
    check('更正把事件移入窗口 -> 400', r.status === 400 && r.json.details.some((d) => d.includes('停机窗口')), r.json);
    let evNow = (await state()).events.find((e) => e.id === procEvent);
    check('拒绝后事件保持原时间', evNow.event_time === '2026-10-06T08:00', evNow);
    r = await api('PUT', `/api/events/${procEvent}`, { type: 'PROCESS', event_time: '2026-10-06T10:00', equipment_id: LINE, batch_code: 'B-W1', material_ids: [MILK], note: '移到窗口外' });
    check('更正到窗口外合法时间 -> 成功', r.status === 200, r.json);

    // ---------- 6. 断网整包补录核对窗口（整包回滚；同号同内容重试仍返回原结果） ----------
    console.log('6) 断网补录：命中窗口整包回滚；已成功补录同号同内容重试仍返回原结果');
    n0 = await eventCount();
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-WIN',
      records: [
        { external_ref: 'W-1', type: 'PROCESS', event_time: '2026-10-05T08:30', equipment_id: LINE, batch_code: 'B-BF-BAD', material_inputs: [{ material_id: MILK }] }
      ]
    });
    check('补录记录落入窗口 -> 400 BACKFILL_REJECTED', r.status === 400 && r.json.code === 'BACKFILL_REJECTED' && r.json.details.some((d) => d.includes('停机窗口')), r.json);
    check('整包回滚：事件数不变', (await eventCount()) === n0);
    check('整包回滚：补录台账未写入', !(await api('GET', '/api/backfills')).json.backfills.some((b) => b.backfill_code === 'BF-WIN'));

    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-OK',
      records: [
        { external_ref: 'K-1', type: 'PROCESS', event_time: '2026-10-07T08:00', equipment_id: LINE, batch_code: 'B-BF1', material_inputs: [{ material_id: MILK }] },
        { external_ref: 'K-2', type: 'CLEAN', event_time: '2026-10-07T09:00', equipment_id: LINE, note: '断网期间全清' }
      ]
    });
    check('合法补录成功', r.status === 200 && r.json.ok === true, r.json);
    const bfMapping = r.json.event_mapping;
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-OK',
      records: [
        { external_ref: 'K-1', type: 'PROCESS', event_time: '2026-10-07T08:00', equipment_code: 'LINE-A', batch_code: 'B-BF1', material_inputs: [{ material_code: 'MILK' }] },
        { external_ref: 'K-2', type: 'CLEAN', event_time: '2026-10-07T09:00', equipment_code: 'LINE-A', note: '断网期间全清' }
      ]
    });
    check('同号同内容重试 -> 幂等返回原结果', r.status === 200 && r.json.idempotent === true && JSON.stringify(r.json.event_mapping) === JSON.stringify(bfMapping), r.json);

    // 删除补录事件并在该时段登记窗口后，同号同内容重试仍返回原结果（幂等优先于窗口核对）
    await api('DELETE', `/api/events/${bfMapping['K-2']}`);
    await api('DELETE', `/api/events/${bfMapping['K-1']}`);
    r = await api('POST', '/api/downtime-windows', { equipment_id: LINE, start_time: '2026-10-07T07:00', end_time: '2026-10-07T10:00', reason: '事后检修', operator: '张工' });
    check('事件删除后该时段可登记窗口', r.status === 200, r.json);
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-OK',
      records: [
        { external_ref: 'K-1', type: 'PROCESS', event_time: '2026-10-07T08:00', equipment_id: LINE, batch_code: 'B-BF1', material_inputs: [{ material_id: MILK }] },
        { external_ref: 'K-2', type: 'CLEAN', event_time: '2026-10-07T09:00', equipment_id: LINE, note: '断网期间全清' }
      ]
    });
    check('已成功补录同号同内容重试仍返回原结果（不重新核对窗口、不重复写入）',
      r.status === 200 && r.json.idempotent === true && JSON.stringify(r.json.event_mapping) === JSON.stringify(bfMapping), r.json);
    r = await api('GET', '/api/backfills/BF-OK');
    check('对账显示补录事件已删除（台账保留）', r.json.records.every((x) => x.reconcile_status === 'DELETED'), r.json);

    // ---------- 7. 换线整组预演与确认应用核对窗口 ----------
    console.log('7) 换线预演/确认：命中窗口拒绝；窗口变动后旧预演确认须重新核对');
    const st7 = await state();
    const ev1 = st7.events.find((e) => e.id === procEvent);
    const fullProcess = (ev, patch = {}) => ({
      op: 'update', event_id: ev.id, type: 'PROCESS',
      event_time: ev.event_time, equipment_id: ev.equipment_id, note: ev.note || '',
      batch_code: ev.batch_code,
      material_ids: ev.inputs.filter((i) => i.material_id).map((i) => i.material_id),
      ref_batch_ids: ev.inputs.filter((i) => i.ref_batch_id).map((i) => i.ref_batch_id),
      ...patch
    });
    r = await api('POST', '/api/replan/preview', { changes: [fullProcess(ev1, { event_time: '2026-10-05T08:30' })] });
    check('预演把事件移入窗口 -> 400 REPLAN_REJECTED（指出窗口）',
      r.status === 400 && r.json.code === 'REPLAN_REJECTED' && r.json.details.some((d) => d.includes('停机窗口')), r.json);
    evNow = (await state()).events.find((e) => e.id === procEvent);
    check('预演不写正式数据（事件时间不变）', evNow.event_time === '2026-10-06T10:00', evNow);

    r = await api('POST', '/api/replan/preview', { changes: [fullProcess(ev1, { event_time: '2026-10-06T11:00' })] });
    check('合法预演通过并取得版本', r.status === 200 && typeof r.json.version === 'string', r.json);
    const goodVersion = r.json.version;
    const goodChanges = r.json.changes;

    // 窗口变动（登记新窗口覆盖预演目标时段）后，旧预演的确认必须重新核对
    r = await api('POST', '/api/downtime-windows', { equipment_id: LINE, start_time: '2026-10-06T10:30', end_time: '2026-10-06T12:00', reason: '午间检修', operator: '张工' });
    check('预演后登记新窗口成功（该时段暂无事件）', r.status === 200, r.json);
    const W11 = r.json.id;
    r = await api('POST', '/api/replan/apply', { version: goodVersion, changes: goodChanges });
    check('窗口变动后旧预演确认 -> 409 VERSION_EXPIRED', r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    r = await api('POST', '/api/replan/preview', { changes: [fullProcess(ev1, { event_time: '2026-10-06T11:00' })] });
    check('重新预演即发现落入新窗口 -> 400 REPLAN_REJECTED', r.status === 400 && r.json.code === 'REPLAN_REJECTED' && r.json.details.some((d) => d.includes('停机窗口')), r.json);
    evNow = (await state()).events.find((e) => e.id === procEvent);
    check('确认被拒后事件仍未改变', evNow.event_time === '2026-10-06T10:00', evNow);

    r = await api('POST', '/api/replan/preview', { changes: [fullProcess(ev1, { event_time: '2026-10-06T13:00' })] });
    check('改到窗口外时间的预演通过', r.status === 200, r.json);
    const v2 = r.json.version;
    r = await api('POST', '/api/replan/apply', { version: v2, changes: r.json.changes });
    check('确认应用成功', r.status === 200 && r.json.ok === true && r.json.phase === 'APPLIED', r.json);
    evNow = (await state()).events.find((e) => e.id === procEvent);
    check('应用后事件已按最终时间落库', evNow.event_time === '2026-10-06T13:00', evNow);

    // ---------- 8. 停机不等于清洗：窗口不改变设备残留或过敏原推导 ----------
    console.log('8) 停机不等于清洗：登记窗口不改变设备残留/推导，也不触发重算联动');
    await api('POST', '/api/events', { type: 'PROCESS', event_time: '2026-10-08T08:00', equipment_id: LINE, batch_code: 'B-W4', material_ids: [MILK], note: '含乳加工' });
    const before = (await state()).equipment.find((e) => e.id === LINE);
    check('加工后设备残留含乳', before.allergens.includes('乳'), before);
    r = await api('POST', '/api/downtime-windows', { equipment_id: LINE, start_time: '2026-10-08T12:00', end_time: '2026-10-08T14:00', reason: '午后检修', operator: '张工' });
    check('登记午后检修窗口成功', r.status === 200, r.json);
    check('窗口接口不触发重算联动（无 invalidated 等字段）',
      r.json.invalidated === undefined && r.json.retired_rolls === undefined && r.json.pending_shipments === undefined, r.json);
    const after = (await state()).equipment.find((e) => e.id === LINE);
    check('登记窗口后设备残留与最后清洗时间不变',
      JSON.stringify(after.allergens) === JSON.stringify(before.allergens) &&
      after.last_cleaned_at === before.last_cleaned_at, { before, after });

    // ---------- 9. 查询窗口及冲突事件、/api/state ----------
    console.log('9) 查询窗口列表/单个/按设备过滤，以及 /api/state 携带 downtime_windows');
    r = await api('GET', '/api/downtime-windows');
    check('列表返回全部窗口', r.status === 200 && r.json.windows.length === 8, r.json);
    check('每项含设备编码与冲突事件数组',
      r.json.windows.every((w) => w.equipment_code && Array.isArray(w.conflicting_events)), r.json);
    r = await api('GET', `/api/downtime-windows?equipment_id=${LINE2}`);
    check('按设备过滤', r.status === 200 && r.json.windows.length === 1 && r.json.windows[0].id === W8, r.json);
    r = await api('GET', '/api/downtime-windows?equipment_id=abc');
    check('过滤参数非法 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('GET', `/api/downtime-windows/${W6}`);
    check('单个查询', r.status === 200 && r.json.id === W6 && r.json.reason === '前段保养', r.json);
    r = await api('GET', '/api/downtime-windows/999999');
    check('查询不存在窗口 -> 404', r.status === 404 && r.json.code === 'WINDOW_NOT_FOUND', r.json);
    r = await state();
    check('/api/state 顶层含 downtime_windows', Array.isArray(r.downtime_windows) && r.downtime_windows.length === 8, r.downtime_windows);

    // ---------- 10. 取消窗口 ----------
    console.log('10) 取消窗口后该时段可重新记录事件');
    r = await api('DELETE', '/api/downtime-windows/999999');
    check('取消不存在窗口 -> 404', r.status === 404 && r.json.code === 'WINDOW_NOT_FOUND', r.json);
    r = await api('DELETE', `/api/downtime-windows/${W1}`);
    check('取消窗口成功', r.status === 200 && r.json.ok === true, r.json);
    r = await api('POST', '/api/events', { type: 'PROCESS', event_time: '2026-10-05T08:30', equipment_id: LINE, batch_code: 'B-AFTER', material_ids: [MILK], note: '窗口取消后可记录' });
    check('取消后原窗口时段可记录加工', r.status === 200, r.json);
    r = await api('POST', '/api/events', { type: 'PROCESS', event_time: '2026-10-05T09:30', equipment_id: LINE, batch_code: 'B-STILL', material_ids: [MILK] });
    check('其余窗口仍然生效（W7 起点 10:00 前仍受 W6/W7 约束…09:30 位于已取消窗口，允许）', r.status === 200, r.json);
    r = await api('POST', '/api/events', { type: 'CLEAN', event_time: '2026-10-05T11:00', equipment_id: LINE, note: '仍在 W7 内' });
    check('未取消的窗口仍然拦截', r.status === 400 && r.json.details.some((d) => d.includes('停机窗口')), r.json);

    console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  } finally {
    proc.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试执行异常：', err);
  process.exit(1);
});
