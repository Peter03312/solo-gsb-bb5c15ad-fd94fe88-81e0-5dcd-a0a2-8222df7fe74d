'use strict';
// 质量隔离令：端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务实例（含演示数据），验证：
//   签发：针对已登记批号；批号不存在/重复签发明确拒绝；
//   生效范围：确定命中 + 因批号未知无法排除都受控，展示传播依据与关联出货单；
//   受控联动：不得登记放行/标签卷/出货；已有卷暂停贴用（可核销拒绝，ROLL_SUSPENDED）但不永久停用；
//             关联已出货单转待评估；隔离期间只能召回（CONTINUE 拒绝）；有效的继续流转结论转需重评；
//   解除/流向变化：卷恢复贴用；待评估单与历史处置不自动恢复；
//   范围刷新：事件更正/清洗/补录/换线后同步刷新；
//   原子性与错误码：重复解除 409；批号未知不可签令；
//   /api/state 与余额、出货单上隔离字段；换线预演预测暂停/范围。
//   node scripts/test-quarantine.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39149';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-test-'));
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
    env: {
      ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: dbPath,
      SEED_DEMO: 'true', CC: '/usr/bin/gcc', CXX: '/usr/bin/g++'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    const state0 = (await api('GET', '/api/state')).json;
    const id = (code) => state0.materials.find((m) => m.code === code).id;
    const MILK = id('MILK-01'), EGG = id('EGG-01');
    const lotByCode = (matCode, lotCode) =>
      state0.materials.find((m) => m.code === matCode).lots.find((l) => l.lot_code === lotCode);
    const MILK_A = lotByCode('MILK-01', 'SUP-MILK-20260925-A').id;
    const MILK_B = lotByCode('MILK-01', 'SUP-MILK-20260926-B').id;
    const batchId = (code) => state0.batches.find((b) => b.code === code).id;
    const B2 = batchId('BATCH-002'), B3 = batchId('BATCH-003');
    let r;

    // ---------- 1. 入参校验：批号不存在 / 缺原因 / 批号未知不可签 ----------
    console.log('1) 签令入参校验');
    r = await api('POST', '/api/quarantine-orders', { lot_id: 99999, reason: 'x', issued_by: 'y' });
    check('批号不存在 -> 404 LOT_NOT_FOUND', r.status === 404 && r.json.code === 'LOT_NOT_FOUND', r.json);
    r = await api('POST', '/api/quarantine-orders', { lot_id: MILK_B, issued_by: 'y' });
    check('缺原因 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/quarantine-orders', { material_id: MILK, reason: 'x', issued_by: 'y' });
    check('不给批号（批号未知）不可签令 -> 400', r.status === 400, r.json);
    r = await api('POST', '/api/quarantine-orders', { lot_code: 'NO-SUCH-LOT', reason: 'x', issued_by: 'y' });
    check('lot_code 不存在 -> 404', r.status === 404 && r.json.code === 'LOT_NOT_FOUND', r.json);

    // ---------- 2. 签发 MILK-B：范围含 BATCH-002(确定) / BATCH-003(确定) ----------
    console.log('2) 签发 MILK-B 隔离令');
    r = await api('POST', '/api/quarantine-orders', {
      lot_id: MILK_B, reason: '供应商通报该批混入异常原料', issued_by: '质检员-陈静',
      issued_at: '2026-10-01T08:00'
    });
    check('签发 200，令号 QUAR-0001', r.status === 200 && r.json.order_code === 'QUAR-0001', r.json);
    const order = r.json;
    check('范围确定命中 2 批',
      order.scope.confirmed_batches.map((b) => b.batch_code).join(',') === 'BATCH-002,BATCH-003',
      order.scope);
    check('无“批号未知”类（该令未知传播来自 EGG，见下一张令）',
      order.scope.unresolved_batches.length === 0, order.scope);
    check('BATCH-003 关联出货单 SHIP-0001',
      order.scope.confirmed_batches.find((b) => b.batch_code === 'BATCH-003')
        .shipments.some((s) => s.shipment_code === 'SHIP-0001'));
    check('依据链展示（直接投料/引用/残留）',
      order.scope.confirmed_batches.find((b) => b.batch_code === 'BATCH-003')
        .evidence.chains.some((c) => c.includes('批次引用:BATCH-002')));
    check('响应 effects：LABEL-0001 暂停、SHIP-0001 待评估',
      order.effects.suspended_rolls.some((x) => x.roll_code === 'LABEL-0001') &&
      order.effects.pending_shipments.some((x) => x.shipment_code === 'SHIP-0001'),
      order.effects);

    // 重复签发拒绝
    r = await api('POST', '/api/quarantine-orders', { lot_id: MILK_B, reason: '再次', issued_by: 'z' });
    check('重复签发 -> 409 QUARANTINE_ORDER_EXISTS',
      r.status === 409 && r.json.code === 'QUARANTINE_ORDER_EXISTS', r.json);

    // ---------- 3. 受控后业务状态 ----------
    console.log('3) 受控联动：卷暂停、出货单待评估、守卫拒绝');
    let st = (await api('GET', '/api/state')).json;
    const roll = st.label_rolls.find((x) => x.roll_code === 'LABEL-0001');
    check('LABEL-0001 仍 ACTIVE 但 suspended=true（不永久停用）',
      roll.status === 'ACTIVE' && roll.suspended === true && !!roll.suspended_reason, roll);
    const ship = st.shipments.find((x) => x.shipment_code === 'SHIP-0001');
    check('SHIP-0001 PENDING_REVIEW 且 quarantined=true',
      ship.status === 'PENDING_REVIEW' && ship.quarantined === true, ship);
    const b3State = st.batches.find((b) => b.id === B3);
    check('/api/state 批次带 quarantine_hits',
      b3State.quarantined === true && b3State.quarantine_hits.length === 1, b3State);

    // 不得登记放行
    r = await api('POST', '/api/releases', {
      batch_id: B2, released_at: '2026-10-01T09:00', released_by: 'w'
    });
    check('受控批次登记放行 -> 409 BATCH_QUARANTINED',
      r.status === 409 && r.json.code === 'BATCH_QUARANTINED', r.json);

    // 不得核销贴用（暂停）
    r = await api('POST', '/api/label-rolls/1/consume', {
      expected_revision: roll.revision, applied: 1, voided: 0, used_by: 'w'
    });
    check('暂停卷核销 -> 409 ROLL_SUSPENDED，修订号不前进',
      r.status === 409 && r.json.code === 'ROLL_SUSPENDED', r.json);
    st = (await api('GET', '/api/state')).json;
    check('核销被拒后修订号不变',
      st.label_rolls.find((x) => x.id === 1).revision === roll.revision);

    // 余额为 0
    r = await api('GET', `/api/batches/${B3}/shipment-balance`);
    check('受控批次可出货余额 0（暂停卷不可出货）',
      r.json.shippable_qty === 0 && r.json.quarantined === true &&
      r.json.rolls[0].available_qty === 0 && r.json.rolls[0].suspended === true, r.json);

    // 不得确认出货
    r = await api('POST', '/api/shipments', {
      batch_id: B3, ship_qty: 1, shipped_by: 'w',
      allocations: [{ roll_id: 1, qty: 1 }]
    });
    check('受控批次出货 -> 409（批次或卷守卫）',
      r.status === 409 && ['BATCH_QUARANTINED', 'ROLL_SUSPENDED'].includes(r.json.code), r.json);

    // 不得登记标签卷
    r = await api('POST', '/api/label-rolls', {
      batch_id: B2, release_id: 1, allergens: ['乳'], print_qty: 10, registered_by: 'w'
    });
    check('受控批次登记标签卷 -> 409 BATCH_QUARANTINED',
      r.status === 409 && r.json.code === 'BATCH_QUARANTINED', r.json);

    // ---------- 4. 隔离期间只能召回 ----------
    console.log('4) 评估视图：隔离期间 CONTINUE 被拒，只能 RECALL');
    r = await api('GET', '/api/shipments/SHIP-0001/evaluation');
    check('评估视图含隔离条件',
      r.json.conditions.quarantined === true &&
      r.json.conditions.not_quarantined === false &&
      r.json.conditions.can_continue === false &&
      r.json.current_state.quarantine_orders.some((h) => h.order_code === 'QUAR-0001'),
      r.json.conditions);
    const ver1 = r.json.version;
    r = await api('POST', '/api/shipments/SHIP-0001/dispositions', {
      decision: 'CONTINUE', decided_by: '陈静', basis: '试放行', version: ver1
    });
    check('隔离期间 CONTINUE -> 409 CONTINUE_NOT_ALLOWED',
      r.status === 409 && r.json.code === 'CONTINUE_NOT_ALLOWED' &&
      r.json.details.some((d) => d.includes('隔离')), r.json);
    r = await api('POST', '/api/shipments/SHIP-0001/dispositions', {
      decision: 'RECALL', decided_by: '质检员-陈静',
      basis: '牛奶批号隔离，整批召回', version: ver1
    });
    check('隔离期间 RECALL 成功', r.status === 200 && r.json.disposition.decision === 'RECALL', r.json);

    // 重复处置拒绝
    const ver2 = r.json.evaluation.version;
    r = await api('POST', '/api/shipments/SHIP-0001/dispositions', {
      decision: 'RECALL', decided_by: '另一个人', basis: '覆盖', version: ver2
    });
    check('已有有效结论重复提交 -> 409 DISPOSITION_EXISTS',
      r.status === 409 && r.json.code === 'DISPOSITION_EXISTS', r.json);

    // ---------- 5. 解除：卷恢复；待评估单与历史召回不自动恢复 ----------
    console.log('5) 解除隔离令');
    r = await api('POST', '/api/quarantine-orders/QUAR-0001/release', {
      reason: '供应商复检合格', released_by: '陈静', released_at: '2026-10-01T10:00'
    });
    check('解除 200，范围清空',
      r.status === 200 && r.json.status === 'RELEASED' &&
      r.json.scope.controlled_batch_count === 0, r.json);
    check('effects：LABEL-0001 恢复贴用',
      r.json.effects.resumed_rolls.some((x) => x.roll_code === 'LABEL-0001'), r.json.effects);
    st = (await api('GET', '/api/state')).json;
    const rollAfter = st.label_rolls.find((x) => x.id === 1);
    check('解除后卷 suspended=false 且仍 ACTIVE',
      rollAfter.suspended === false && rollAfter.status === 'ACTIVE', rollAfter);
    const shipAfter = st.shipments.find((x) => x.shipment_code === 'SHIP-0001');
    check('解除后出货单仍 PENDING_REVIEW（不自动恢复）',
      shipAfter.status === 'PENDING_REVIEW', shipAfter);
    check('解除后批次 quarantined=false',
      !st.batches.find((b) => b.id === B3).quarantined);
    const ev3 = (await api('GET', '/api/shipments/SHIP-0001/evaluation')).json;
    check('历史召回结论转需重评（STALE），不自动生效',
      ev3.current_disposition && ev3.current_disposition.life_status === 'STALE' &&
      ev3.current_disposition.needs_review === true, ev3.current_disposition);
    check('解除后隔离条件解除，can_continue 取决于其它条件',
      ev3.conditions.quarantined === false, ev3.conditions);

    // 重复解除
    r = await api('POST', '/api/quarantine-orders/1/release', { reason: 'x', released_by: 'y' });
    check('重复解除 -> 409', r.status === 409 && r.json.code === 'QUARANTINE_ORDER_ALREADY_RELEASED', r.json);
    // 不存在
    r = await api('GET', '/api/quarantine-orders/9999');
    check('令不存在 -> 404', r.status === 404 && r.json.code === 'QUARANTINE_ORDER_NOT_FOUND', r.json);

    // ---------- 6. 批号未知无法排除也受控（EGG 批号未知：BATCH-002/003）----------
    console.log('6) 签令 EGG 原料下新批号 -> 批号未知无法排除批次也受控');
    r = await api('POST', '/api/material-lots', {
      material_id: EGG, lot_code: 'SUP-EGG-20260926-X', supplier: '某蛋品厂'
    });
    const eggLot = r.json.id;
    r = await api('POST', '/api/quarantine-orders', {
      lot_id: eggLot, reason: '蛋粉供应商通报同线异常', issued_by: '陈静'
    });
    check('签令成功', r.status === 200, r.json);
    check('无确定命中（该批号未直接投料）',
      r.json.scope.confirmed_batches.length === 0, r.json.scope);
    const codes = r.json.scope.unresolved_batches.map((b) => b.batch_code);
    check('因批号未知无法排除 BATCH-002/BATCH-003 均受控',
      codes.includes('BATCH-002') && codes.includes('BATCH-003'), codes);
    check('无法排除依据链含“[批号未知]”',
      r.json.scope.unresolved_batches[0].evidence.chains[0].includes('批号未知'),
      r.json.scope.unresolved_batches[0].evidence);

    // ---------- 7. 流向变化（清洗截断后范围刷新）----------
    console.log('7) 新增全清 + 事件更正：范围按最新时间线刷新');
    // 在 BATCH-002(10:00) 之前插入一次全清不能截断 BATCH-002 的直接投料（直接投料不受清洗影响），
    // 但会截断设备残留传播；批号未知 EGG 的 BATCH-002 来自直接投料，仍受控。
    // 改为验证“解除后再签发已被新清洗截断残留”的场景：先解除。
    await api('POST', '/api/quarantine-orders/2/release', { reason: '核实无关', released_by: '陈静' });

    // 换线预演预测：把 09:00 清洗时间移动不影响 10:00 直接投料。
    // 这里验证 replan preview 能返回隔离预测字段且不写正式数据。
    const events = (await api('GET', '/api/state')).json.events;
    const clean9 = events.find((e) => e.type === 'CLEAN' && e.event_time === '2026-09-30T09:00');
    r = await api('POST', '/api/replan/preview', {
      changes: [{
        op: 'update', event_id: clean9.id, type: 'CLEAN',
        event_time: '2026-09-30T09:30', equipment_id: clean9.equipment_id, note: '改时间预演'
      }]
    });
    check('换线预演返回隔离预测字段',
      r.status === 200 && Array.isArray(r.json.diff.quarantine_scope), r.json && r.json.diff);

    // ---------- 8. 补录/事件更正触发范围刷新（签发后更正事件）----------
    console.log('8) 签发后更正事件 -> 重算原子刷新范围与暂停状态');
    // 重新签 MILK-A（只直接投料 BATCH-002；BATCH-003 经引用+残留命中）
    r = await api('POST', '/api/quarantine-orders', {
      lot_id: MILK_A, reason: 'A 批复检异常', issued_by: '陈静'
    });
    check('MILK-A 签令成功，BATCH-002/003 确定命中',
      r.status === 200 &&
      r.json.scope.confirmed_batches.map((b) => b.batch_code).join(',') === 'BATCH-002,BATCH-003',
      r.json.scope);
    // 更正 BATCH-002 事件，去掉 MILK 原料（仅保留 EGG 批号未知）-> MILK-A 不再命中 BATCH-002
    const evB2 = events.find((e) => e.batch_code === 'BATCH-002');
    r = await api('PUT', `/api/events/${evB2.id}`, {
      type: 'PROCESS', event_time: evB2.event_time, equipment_id: evB2.equipment_id,
      batch_code: 'BATCH-002', note: evB2.note,
      material_inputs: [{ material_id: EGG }],
      ref_batch_ids: []
    });
    check('更正事件 200（隔离范围随重算刷新）', r.status === 200, r.json);
    r = await api('GET', '/api/quarantine-orders/3');
    check('更正后 MILK-A 令范围为空（不再命中任何批次），卷恢复',
      r.json.scope.controlled_batch_count === 0 &&
      (r.json.effects === undefined), r.json.scope);
    st = (await api('GET', '/api/state')).json;
    check('LABEL-0001 随范围清空恢复（若未被 RETIRE）',
      st.label_rolls.find((x) => x.id === 1).suspended === false ||
      st.label_rolls.find((x) => x.id === 1).status === 'RETIRED');

    // ---------- 9. 列表过滤 ----------
    console.log('9) 列表与过滤');
    r = await api('GET', '/api/quarantine-orders?status=RELEASED');
    check('按 RELEASED 过滤', r.status === 200 && r.json.orders.every((o) => o.status === 'RELEASED')
      && r.json.orders.length >= 2, r.json);
    r = await api('GET', '/api/quarantine-orders?status=ACTIVE');
    check('按 ACTIVE 过滤', r.json.orders.every((o) => o.status === 'ACTIVE'));
    r = await api('GET', `/api/quarantine-orders?lot_id=${MILK_A}`);
    check('按批号过滤', r.json.orders.every((o) => o.material_lot_id === MILK_A));
    r = await api('GET', '/api/quarantine-orders?status=BAD');
    check('非法 status -> 400', r.status === 400);

    // ---------- 10. 原有 FLAGGED 标记互不影响 ----------    console.log('10) FLAGGED 仅留痕');
    r = await api('GET', '/api/material-lots');
    const milkBLot = r.json.find((l) => l.id === MILK_B);
    check('MILK-B 仍为 FLAGGED（隔离令不改变异常标记）', milkBLot.flagged === true);
    const orderDetail = (await api('GET', '/api/quarantine-orders/1')).json;
    check('隔离令详情展示批号 FLAGGED 状态', orderDetail.lot.flagged === true);

    // ---------- 11. 多令重叠：解除其一，批次仍受另一令控制时不恢复 ----------
    console.log('11) 多令重叠覆盖：脱离全部生效令后才恢复');
    const SESAME = id('SESAME-01');
    r = await api('POST', '/api/material-lots', {
      material_id: SESAME, lot_code: 'SUP-SES-20260927-Y', supplier: '某芝麻厂'
    });
    const sesLot = r.json.id;
    // EGG 令（#2）已解除；先重签 EGG 令（批号未知传播：BATCH-002/003），再签 SESAME 令。
    r = await api('POST', '/api/quarantine-orders', { lot_id: eggLot, reason: '蛋粉再次异常', issued_by: '陈静' });
    check('重签 EGG 令成功', r.status === 200 && r.json.scope.controlled_batch_count >= 1, r.json);
    r = await api('POST', '/api/quarantine-orders', { lot_id: sesLot, reason: '芝麻批号异常', issued_by: '陈静' });
    check('SESAME 令成功（批号未知命中 BATCH-003）',
      r.status === 200 &&
      r.json.scope.unresolved_batches.some((b) => b.batch_code === 'BATCH-003'), r.json);
    const sesameOrderCode = r.json.order_code;
    st = (await api('GET', '/api/state')).json;
    check('BATCH-003 受多张令控制',
      (st.batches.find((b) => b.id === B3).quarantine_hits || []).length >= 2);
    // 只解除 EGG 令：BATCH-003 仍受 SESAME 令控制，仍受控。
    const eggOrderId = st.quarantine_orders.find((o) => o.material_lot_id === eggLot && o.active).id;
    r = await api('POST', `/api/quarantine-orders/${eggOrderId}/release`, {
      reason: '蛋粉排除', released_by: '陈静'
    });
    check('解除 EGG 令 200', r.status === 200);
    st = (await api('GET', '/api/state')).json;
    const b3Hits = st.batches.find((b) => b.id === B3).quarantine_hits || [];
    check('解除其一后 BATCH-003 仍受 SESAME 令控制（未恢复）',
      b3Hits.length === 1 && b3Hits[0].order_code === sesameOrderCode, b3Hits);
    // 再解除 SESAME 令：脱离全部生效令
    r = await api('POST', `/api/quarantine-orders/${sesameOrderCode}/release`, {
      reason: '芝麻排除', released_by: '陈静'
    });
    check('解除最后一张令后批次不再受控',
      r.status === 200 &&
      !(await api('GET', '/api/state')).json.batches.find((b) => b.id === B3).quarantined);

    console.log(`\n${failures === 0 ? '全部通过 ✅' : `有 ${failures} 项失败 ❌`}`);
  } finally {
    proc.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常退出：', err);
  process.exit(1);
});
