'use strict';
// 质量隔离令：端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务实例（含演示数据），验证：
//   签发：记录原因/操作人/时间；按当前时间线批号流向确定生效范围（确定命中 +
//         批号未知无法排除均受控）并展示传播依据；同一批号同时只能一张生效令；
//         批号不存在/缺原因/缺操作人明确拒绝；
//   受控约束：不得登记放行/标签卷/出货；已有卷暂停贴用但不永久停用；
//         关联已出货单转待评估；有效的继续流转结论转需重评；隔离期间只能召回；
//   范围刷新：事件新增/更正、断网补录、整组换线后同步刷新（响应附 quarantine 变化）；
//   解除：记录原因/操作人/时间；脱离所有生效令后才恢复后续操作；
//         待评估单与历史处置不自动恢复；重复解除明确拒绝；解除后可重新签发；
//   台账：有隔离令的批号不可删除；列表/单条查询与过滤；FLAGGED 标记仍只作留痕。
//   node scripts/test-quarantine.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39141';
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

const codes = (list) => (list || []).map((x) => x.batch_code).sort();

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: dbPath, SEED_DEMO: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    let r;
    const state = () => api('GET', '/api/state').then((x) => x.json);
    const st0 = await state();
    const matId = (code) => st0.materials.find((m) => m.code === code).id;
    const MILK = matId('MILK-01'), EGG = matId('EGG-01'), WHEAT = matId('WHEAT-01'),
      SESAME = matId('SESAME-01'), SALT = matId('SALT-01');
    const lotId = (matCode, lotCode) =>
      st0.materials.find((m) => m.code === matCode).lots.find((l) => l.lot_code === lotCode).id;
    const MILK_B = lotId('MILK-01', 'SUP-MILK-20260926-B');
    const WHEAT_A = lotId('WHEAT-01', 'SUP-WHEAT-20260920-7');
    const batchId = (st, code) => st.batches.find((b) => b.code === code).id;
    const B2 = batchId(st0, 'BATCH-002'), B3 = batchId(st0, 'BATCH-003');
    const LABEL1 = st0.label_rolls.find((x) => x.roll_code === 'LABEL-0001').id;
    const REL3 = st0.batches.find((b) => b.code === 'BATCH-003')
      .releases.find((x) => x.status === 'ACTIVE').id;

    // ---------- 1. 签发：校验与生效范围 ----------
    console.log('1) 签发隔离令：参数校验、生效范围（确定命中）、关联出货单转待评估');
    r = await api('GET', '/api/quarantine-orders');
    check('初始无隔离令', r.status === 200 && r.json.orders.length === 0, r.json);
    r = await api('POST', '/api/quarantine-orders', { lot_id: MILK_B, issued_by: '王敏' });
    check('缺签发原因 → 400 INVALID_REQUEST',
      r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/quarantine-orders', { lot_id: MILK_B, reason: 'x' });
    check('缺签发操作人 → 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/quarantine-orders',
      { lot_id: 999999, reason: 'x', issued_by: 'y' });
    check('批号不存在 → 404 LOT_NOT_FOUND',
      r.status === 404 && r.json.code === 'LOT_NOT_FOUND', r.json);
    r = await api('POST', '/api/quarantine-orders',
      { lot_id: MILK_B, reason: 'x', issued_by: 'y', issued_at: '2026-10-01 09:00' });
    check('签发时间格式错 → 400', r.status === 400, r.json);

    r = await api('POST', '/api/quarantine-orders', {
      lot_id: MILK_B, reason: '供应商通报该批可能混入异常原料，隔离待查',
      issued_by: '质检员-王敏', issued_at: '2026-10-01T09:00'
    });
    check('签发成功 QUAR-0001',
      r.status === 200 && r.json.ok && r.json.order.order_code === 'QUAR-0001', r.json);
    check('签发记录原因/操作人/时间',
      r.json.order.reason.includes('隔离待查') &&
      r.json.order.issued_by === '质检员-王敏' &&
      r.json.order.issued_at === '2026-10-01T09:00', r.json.order);
    check('生效范围 = BATCH-002/003 确定命中',
      JSON.stringify(codes(r.json.order.scope.batches)) === JSON.stringify(['BATCH-002', 'BATCH-003']) &&
      r.json.order.scope.batches.every((b) => b.classification === 'CONFIRMED'),
      r.json.order.scope.batches);
    check('范围批次展示传播依据（证据链）',
      r.json.order.scope.batches.every((b) =>
        b.evidence && b.evidence.confirmed.chains.length > 0),
      r.json.order.scope.batches.map((b) => b.evidence));
    check('签发响应附新受控批次',
      JSON.stringify(codes(r.json.quarantine.newly_controlled)) ===
      JSON.stringify(['BATCH-002', 'BATCH-003']), r.json.quarantine);
    check('关联已出货单 SHIP-0001 同事务转待评估',
      r.json.pending_shipments.length === 1 &&
      r.json.pending_shipments[0].shipment_code === 'SHIP-0001' &&
      r.json.pending_shipments[0].status === 'PENDING_REVIEW', r.json.pending_shipments);
    const QUAR1 = r.json.order.id;

    r = await api('POST', '/api/quarantine-orders',
      { lot_id: MILK_B, reason: '重复签发', issued_by: '王敏' });
    check('同一批号重复签发 → 409 QUARANTINE_EXISTS',
      r.status === 409 && r.json.code === 'QUARANTINE_EXISTS', r.json);

    r = await api('GET', `/api/quarantine-orders/${QUAR1}`);
    check('单条查询含范围与关联出货单',
      r.status === 200 && r.json.scope.batch_count === 2 &&
      r.json.affected_shipments.some((s) => s.shipment_code === 'SHIP-0001'), r.json);
    r = await api('GET', '/api/shipments/SHIP-0001');
    check('SHIP-0001 待评估原因指向隔离令且批次受控',
      r.json.status === 'PENDING_REVIEW' && r.json.review_reason.includes('QUAR-0001') &&
      r.json.batch_quarantined === true, r.json);

    // ---------- 2. 受控约束：放行/标签卷/出货/核销 ----------
    console.log('2) 受控批次：禁放行/禁登记卷/禁出货；已有卷暂停贴用但不永久停用');
    const st1 = await state();
    const b2 = st1.batches.find((b) => b.code === 'BATCH-002');
    const b3 = st1.batches.find((b) => b.code === 'BATCH-003');
    check('state 中 BATCH-002/003 标记受控并列出隔离令',
      b2.quarantined && b3.quarantined &&
      b3.quarantine_orders[0].order_code === 'QUAR-0001', b3.quarantine_orders);
    const milkB = st1.materials.find((m) => m.code === 'MILK-01')
      .lots.find((l) => l.id === MILK_B);
    check('批号行标记 quarantine_active（FLAGGED 仍只是留痕）',
      milkB.quarantine_active === true && milkB.flagged === true, milkB);
    const roll1 = st1.label_rolls.find((x) => x.roll_code === 'LABEL-0001');
    check('LABEL-0001 暂停贴用但仍 ACTIVE（不永久停用）',
      roll1.quarantine_paused === true && roll1.status === 'ACTIVE', roll1);

    r = await api('POST', '/api/releases',
      { batch_id: B2, released_at: '2026-10-01T10:00', released_by: '质检员-王敏' });
    check('受控批次登记放行 → 409 BATCH_QUARANTINED',
      r.status === 409 && r.json.code === 'BATCH_QUARANTINED', r.json);
    r = await api('POST', '/api/releases',
      { batch_id: B3, released_at: '2026-10-01T10:00', released_by: '质检员-王敏' });
    check('BATCH-003 同样禁放行', r.status === 409 && r.json.code === 'BATCH_QUARANTINED');

    r = await api('POST', '/api/label-rolls', {
      batch_id: B3, release_id: REL3, allergens: b3.allergens,
      print_qty: 100, registered_by: '包装组长-李雷'
    });
    check('受控批次登记标签卷 → 409 BATCH_QUARANTINED',
      r.status === 409 && r.json.code === 'BATCH_QUARANTINED', r.json);

    r = await api('POST', `/api/label-rolls/${LABEL1}/consume`,
      { expected_revision: 2, applied: 1, voided: 0, used_by: '包装工-赵强' });
    check('受控批次卷核销贴用 → 409 ROLL_QUARANTINED',
      r.status === 409 && r.json.code === 'ROLL_QUARANTINED', r.json);

    r = await api('POST', '/api/shipments', {
      batch_id: B3, ship_qty: 1, shipped_by: '仓管-周杰',
      allocations: [{ roll_id: LABEL1, qty: 1 }]
    });
    check('受控批次确认出货 → 409 BATCH_QUARANTINED',
      r.status === 409 && r.json.code === 'BATCH_QUARANTINED', r.json);

    // ---------- 3. 隔离期间只能召回 ----------
    console.log('3) 评估视图：隔离中只能召回，CONTINUE 被拒、RECALL 落账');
    r = await api('GET', '/api/shipments/SHIP-0001/evaluation');
    check('评估视图标记隔离且不准予继续流转',
      r.json.conditions.quarantined === true &&
      r.json.conditions.can_continue === false &&
      r.json.conditions.blockers.some((t) => t.includes('质量隔离令')), r.json.conditions);
    const ver1 = r.json.version;
    r = await api('POST', '/api/shipments/SHIP-0001/dispositions', {
      decision: 'CONTINUE', decided_by: '质检员-陈静', basis: '试图放行', version: ver1
    });
    check('隔离期间提交 CONTINUE → 409 CONTINUE_NOT_ALLOWED',
      r.status === 409 && r.json.code === 'CONTINUE_NOT_ALLOWED', r.json);
    r = await api('POST', '/api/shipments/SHIP-0001/dispositions', {
      decision: 'RECALL', decided_by: '质检员-陈静',
      basis: '批号隔离待查，先召回在途品', version: ver1
    });
    check('隔离期间 RECALL 正常落账',
      r.status === 200 && r.json.disposition.decision === 'RECALL' &&
      r.json.disposition.life_status === 'ACTIVE', r.json);

    // ---------- 4. 范围随事件新增/更正同步刷新 ----------
    console.log('4) 事件新增/更正同步刷新范围（批号未知无法排除同样受控）');
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-02T08:00', equipment_id: 1,
      batch_code: 'BATCH-T1', note: '牛奶批号未知投料',
      material_inputs: [{ material_id: MILK }, { material_id: SALT }]
    });
    check('新事件使 BATCH-T1 因批号未知无法排除而新受控',
      r.status === 200 && codes(r.json.quarantine.newly_controlled).includes('BATCH-T1'),
      r.json.quarantine);
    r = await api('GET', `/api/quarantine-orders/${QUAR1}`);
    const t1Scope = r.json.scope.batches.find((b) => b.batch_code === 'BATCH-T1');
    check('BATCH-T1 以 UNRESOLVED 进入生效范围（含无法排除依据）',
      t1Scope && t1Scope.classification === 'UNRESOLVED' &&
      t1Scope.evidence.unresolved.chains.length > 0, t1Scope);
    const B_T1 = (await state()).batches.find((b) => b.code === 'BATCH-T1').id;
    r = await api('POST', '/api/releases',
      { batch_id: B_T1, released_at: '2026-10-02T09:00', released_by: '王敏' });
    check('无法排除批次同样不得登记放行', r.status === 409 && r.json.code === 'BATCH_QUARANTINED');

    const stT1 = await state();
    const t1Event = stT1.events.find((e) => e.batch_code === 'BATCH-T1');
    r = await api('PUT', `/api/events/${t1Event.id}`, {
      type: 'PROCESS', event_time: '2026-10-02T08:00', equipment_id: 1,
      batch_code: 'BATCH-T1', note: '更正为已知正常批号',
      material_inputs: [{ material_id: MILK, lot_id: lotId('MILK-01', 'SUP-MILK-20260925-A') }],
      ref_batch_ids: []
    });
    check('事件更正后 BATCH-T1 脱离生效范围',
      r.status === 200 && codes(r.json.quarantine.released).includes('BATCH-T1'),
      r.json.quarantine);
    r = await api('POST', '/api/releases',
      { batch_id: B_T1, released_at: '2026-10-02T09:00', released_by: '王敏' });
    check('脱离全部生效令后恢复登记放行', r.status === 200 && r.json.id, r.json);
    await api('DELETE', `/api/releases/${r.json.id}`); // 清理，保持后续断言简单

    // ---------- 5. 多令覆盖与解除 ----------
    console.log('5) 多令覆盖：脱离所有生效令才恢复；解除留痕、重复解除拒绝、解除后可再签发');
    r = await api('POST', '/api/material-lots',
      { material_id: EGG, lot_code: 'SUP-EGG-20260929-1', supplier: '测试蛋品' });
    const EGG_LOT = r.json.id;
    r = await api('POST', '/api/quarantine-orders', {
      lot_id: EGG_LOT, reason: '蛋品供应商例行排查', issued_by: '质检员-王敏'
    });
    check('第二张隔离令签发（蛋批号）QUAR-0002',
      r.status === 200 && r.json.order.order_code === 'QUAR-0002', r.json);
    check('蛋批号未知流向：BATCH-002/003 无法排除而受控',
      JSON.stringify(codes(r.json.order.scope.batches)) === JSON.stringify(['BATCH-002', 'BATCH-003']) &&
      r.json.order.scope.batches.every((b) => b.classification === 'UNRESOLVED'),
      r.json.order.scope.batches);
    const QUAR2 = r.json.order.id;

    r = await api('POST', `/api/quarantine-orders/${QUAR2}/lift`, {
      lifted_by: '质检主管-刘芳', lift_reason: '供应商排查排除异常'
    });
    check('解除蛋令成功但无批次脱离（奶令仍覆盖）',
      r.status === 200 && r.json.order.status === 'LIFTED' &&
      r.json.quarantine.released.length === 0, r.json.quarantine);
    r = await api('POST', '/api/releases',
      { batch_id: B2, released_at: '2026-10-02T10:00', released_by: '王敏' });
    check('仍被奶令覆盖：BATCH-002 不得放行', r.status === 409);

    r = await api('POST', `/api/quarantine-orders/${QUAR1}/lift`, {
      lifted_by: '质检主管-刘芳', lift_reason: '供应商复检合格，解除隔离',
      lifted_at: '2026-10-03T10:00'
    });
    check('解除奶令：BATCH-002/003 脱离全部生效令',
      r.status === 200 &&
      JSON.stringify(codes(r.json.quarantine.released)) === JSON.stringify(['BATCH-002', 'BATCH-003']),
      r.json.quarantine);
    check('解除留痕（操作人/时间/原因/范围快照）',
      r.json.order.lifted_by === '质检主管-刘芳' &&
      r.json.order.lifted_at === '2026-10-03T10:00' &&
      r.json.order.lift_reason.includes('复检合格') &&
      r.json.order.lifted_scope.length === 2, r.json.order);
    r = await api('POST', `/api/quarantine-orders/${QUAR1}/lift`, {
      lifted_by: '刘芳', lift_reason: '重复解除'
    });
    check('重复解除 → 409 QUARANTINE_NOT_ACTIVE',
      r.status === 409 && r.json.code === 'QUARANTINE_NOT_ACTIVE', r.json);
    r = await api('POST', '/api/quarantine-orders/999999/lift', {
      lifted_by: '刘芳', lift_reason: 'x'
    });
    check('解除不存在的令 → 404 ORDER_NOT_FOUND',
      r.status === 404 && r.json.code === 'ORDER_NOT_FOUND', r.json);

    r = await api('POST', '/api/releases',
      { batch_id: B2, released_at: '2026-10-03T11:00', released_by: '王敏' });
    check('脱离全部生效令后 BATCH-002 可登记放行', r.status === 200, r.json);
    r = await api('POST', `/api/label-rolls/${LABEL1}/consume`,
      { expected_revision: 2, applied: 1, voided: 0, used_by: '包装工-赵强' });
    check('卷自动恢复贴用（不永久停用）', r.status === 200 && r.json.revision === 3, r.json);
    r = await api('GET', '/api/shipments/SHIP-0001');
    check('待评估单不自动恢复（仍 PENDING_REVIEW，召回结论保留）',
      r.json.status === 'PENDING_REVIEW' &&
      r.json.current_disposition && r.json.current_disposition.decision === 'RECALL' &&
      r.json.current_disposition.life_status === 'ACTIVE', r.json);

    r = await api('POST', '/api/quarantine-orders', {
      lot_id: MILK_B, reason: '再次通报异常', issued_by: '王敏'
    });
    check('解除后同一批号可重新签发（QUAR-0003）',
      r.status === 200 && r.json.order.order_code === 'QUAR-0003', r.json);
    const QUAR3 = r.json.order.id;
    r = await api('POST', `/api/quarantine-orders/${QUAR3}/lift`, {
      lifted_by: '刘芳', lift_reason: '误报解除'
    });
    check('再次解除成功', r.status === 200 && r.json.order.status === 'LIFTED');

    // ---------- 6. 有效的继续流转结论转需重评 ----------
    console.log('6) 签发级联：有效 CONTINUE 结论转需重评（原子完成），隔离中只能召回');
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-03T08:00', equipment_id: 2,
      batch_code: 'BATCH-Q1', note: '小麦批（继续流转结论演示）',
      material_inputs: [{ material_id: WHEAT, lot_id: WHEAT_A }]
    });
    check('BATCH-Q1 创建', r.status === 200, r.json);
    const B_Q1 = (await state()).batches.find((b) => b.code === 'BATCH-Q1').id;
    r = await api('POST', '/api/releases',
      { batch_id: B_Q1, released_at: '2026-10-03T08:30', released_by: '王敏' });
    const REL_Q1 = r.json.id;
    check('BATCH-Q1 放行', r.status === 200, r.json);
    r = await api('POST', '/api/label-rolls', {
      batch_id: B_Q1, release_id: REL_Q1, allergens: ['含麸质的谷物'],
      print_qty: 50, registered_by: '李雷'
    });
    const ROLL_Q = r.json.id;
    check('BATCH-Q1 登记标签卷', r.status === 200 && r.json.roll_code, r.json);
    r = await api('POST', `/api/label-rolls/${ROLL_Q}/consume`,
      { expected_revision: 0, applied: 10, voided: 0, used_by: '赵强' });
    check('贴用 10 张', r.status === 200, r.json);
    r = await api('POST', '/api/shipments', {
      batch_id: B_Q1, ship_qty: 5, shipped_by: '周杰',
      allocations: [{ roll_id: ROLL_Q, qty: 5 }]
    });
    check('BATCH-Q1 出货 5 张', r.status === 200 && r.json.status === 'SHIPPED', r.json);
    const SHIP_Q = r.json.shipment_code;
    // 让单据转待评估（删除放行使卷停用），再补一条有效放行使 CONTINUE 成立
    await api('DELETE', `/api/releases/${REL_Q1}`);
    r = await api('POST', '/api/releases',
      { batch_id: B_Q1, released_at: '2026-10-03T09:00', released_by: '王敏' });
    check('重新登记放行', r.status === 200, r.json);
    r = await api('GET', `/api/shipments/${SHIP_Q}/evaluation`);
    check('三条件齐全可 CONTINUE', r.json.conditions.can_continue === true, r.json.conditions);
    const verQ = r.json.version;
    r = await api('POST', `/api/shipments/${SHIP_Q}/dispositions`, {
      decision: 'CONTINUE', decided_by: '质检员-陈静',
      basis: '复检合格，准予继续流转', version: verQ
    });
    check('登记有效 CONTINUE 结论',
      r.status === 200 && r.json.disposition.life_status === 'ACTIVE', r.json);

    r = await api('POST', '/api/quarantine-orders', {
      lot_id: WHEAT_A, reason: '小麦批供应商通报异物风险', issued_by: '王敏'
    });
    check('小麦令签发：范围含 BATCH-001 与 BATCH-Q1',
      r.status === 200 &&
      JSON.stringify(codes(r.json.order.scope.batches)) === JSON.stringify(['BATCH-001', 'BATCH-Q1']),
      r.json.order.scope.batches);
    check('有效 CONTINUE 结论同事务转需重评',
      r.json.stale_dispositions.length === 1 &&
      r.json.stale_dispositions[0].shipment_code === SHIP_Q &&
      r.json.stale_dispositions[0].decision === 'CONTINUE' &&
      r.json.stale_dispositions[0].reason.includes('质量隔离令'),
      r.json.stale_dispositions);
    const QUAR4 = r.json.order.id;
    r = await api('GET', `/api/shipments/${SHIP_Q}/evaluation`);
    check('评估视图：旧结论 STALE（需重新评估）且隔离中只能召回',
      r.json.current_disposition.life_status === 'STALE' &&
      r.json.current_disposition.stale_reason.includes('质量隔离令') &&
      r.json.conditions.can_continue === false, r.json);
    r = await api('POST', `/api/shipments/${SHIP_Q}/dispositions`, {
      decision: 'RECALL', decided_by: '质检员-陈静',
      basis: '隔离期间改判召回', version: r.json.version
    });
    check('STALE 后可登记新召回结论', r.status === 200 && r.json.disposition.decision === 'RECALL', r.json);

    r = await api('POST', `/api/quarantine-orders/${QUAR4}/lift`, {
      lifted_by: '刘芳', lift_reason: '异物排查排除'
    });
    check('解除小麦令', r.status === 200, r.json);
    r = await api('GET', `/api/shipments/${SHIP_Q}`);
    check('待评估单与历史处置不自动恢复',
      r.json.status === 'PENDING_REVIEW' &&
      r.json.current_disposition.decision === 'RECALL' &&
      r.json.current_disposition.life_status === 'ACTIVE', r.json);
    r = await api('POST', '/api/releases',
      { batch_id: B_Q1, released_at: '2026-10-03T12:00', released_by: '王敏' });
    check('解除后 BATCH-Q1 恢复放行登记', r.status === 200, r.json);

    // ---------- 7. 台账与查询 ----------
    console.log('7) 台账：有隔离令的批号不可删除；列表过滤；单条 404');
    r = await api('DELETE', `/api/material-lots/${MILK_B}`);
    check('有隔离令的批号不可删除 → 400 LOT_IN_USE',
      r.status === 400 && r.json.code === 'LOT_IN_USE', r.json);
    r = await api('DELETE', `/api/material-lots/${WHEAT_A}`);
    check('已解除历史令的批号同样不可删除', r.status === 400 && r.json.code === 'LOT_IN_USE');
    r = await api('GET', '/api/quarantine-orders?status=ACTIVE');
    check('当前无生效令', r.status === 200 && r.json.orders.length === 0, r.json);
    r = await api('GET', '/api/quarantine-orders?status=LIFTED');
    check('已解除令 4 张（奶×2、蛋、小麦）',
      r.status === 200 && r.json.orders.length === 4 &&
      r.json.orders.every((o) => o.status === 'LIFTED'), r.json.orders && r.json.orders.length);
    r = await api('GET', `/api/quarantine-orders?lot_id=${MILK_B}`);
    check('按批号过滤（奶批 2 张历史令）',
      r.status === 200 && r.json.orders.length === 2, r.json.orders);
    r = await api('GET', '/api/quarantine-orders?status=BOGUS');
    check('非法 status 过滤 → 400', r.status === 400 && r.json.code === 'INVALID_REQUEST');
    r = await api('GET', '/api/quarantine-orders/999999');
    check('查询不存在的令 → 404 ORDER_NOT_FOUND',
      r.status === 404 && r.json.code === 'ORDER_NOT_FOUND', r.json);

    // ---------- 8. 补录与整组换线同步刷新范围 ----------
    console.log('8) 断网补录 / 整组换线后同步刷新范围');
    r = await api('POST', '/api/material-lots',
      { material_id: SESAME, lot_code: 'SUP-SES-20261001-1', supplier: '测试麻酱' });
    const SES_LOT = r.json.id;
    r = await api('POST', '/api/quarantine-orders', {
      lot_id: SES_LOT, reason: '麻酱批通报异常', issued_by: '王敏'
    });
    check('麻酱批号本身未投料，但 BATCH-003 麻酱批号未知而无法排除（UNRESOLVED 受控）',
      r.status === 200 &&
      JSON.stringify(codes(r.json.order.scope.batches)) === JSON.stringify(['BATCH-003']) &&
      r.json.order.scope.batches[0].classification === 'UNRESOLVED',
      r.json.order.scope && r.json.order.scope.batches);
    const QUAR5 = r.json.order.id;

    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-02T09:00', equipment_id: 1,
      batch_code: 'BATCH-T2', note: '麻酱批投料',
      material_inputs: [{ material_id: SESAME, lot_id: SES_LOT }]
    });
    check('事件新增同步刷新：BATCH-T2 新受控',
      r.status === 200 && codes(r.json.quarantine.newly_controlled).includes('BATCH-T2'),
      r.json.quarantine);

    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-QUAR-1',
      records: [{
        external_ref: 'Q-001', type: 'PROCESS', event_time: '2026-10-04T08:00',
        equipment_id: 2, batch_code: 'BATCH-BF1', note: '断网补录麻酱批',
        material_inputs: [{ material_id: SESAME, lot_code: 'SUP-SES-20261001-1' }]
      }]
    });
    check('断网补录同步刷新：BATCH-BF1 新受控',
      r.status === 200 && codes(r.json.quarantine.newly_controlled).includes('BATCH-BF1'),
      r.json.quarantine);

    const stT2 = await state();
    const t2Event = stT2.events.find((e) => e.batch_code === 'BATCH-T2');
    const changes = [{
      op: 'update', event_id: t2Event.id, type: 'PROCESS',
      event_time: '2026-10-02T09:00', equipment_id: 1,
      note: '更正为食盐（不用麻酱批）', batch_code: 'BATCH-T2',
      material_inputs: [{ material_id: SALT }], ref_batch_ids: []
    }];
    r = await api('POST', '/api/replan/preview', { changes });
    check('换线预演预测 BATCH-T2 脱离受控',
      r.status === 200 && codes(r.json.diff.quarantine_will_release).includes('BATCH-T2'),
      r.json.diff);
    const ver = r.json.version;
    r = await api('POST', '/api/replan/apply', { version: ver, changes });
    check('整组换线确认应用同步刷新：BATCH-T2 脱离受控',
      r.status === 200 && codes(r.json.quarantine.released).includes('BATCH-T2'), r.json);
    r = await api('GET', `/api/quarantine-orders/${QUAR5}`);
    check('范围刷新后麻酱令覆盖 BATCH-003（未知无法排除）与 BATCH-BF1（确定命中）',
      JSON.stringify(codes(r.json.scope.batches)) === JSON.stringify(['BATCH-003', 'BATCH-BF1']),
      r.json.scope.batches);
    r = await api('POST', `/api/quarantine-orders/${QUAR5}/lift`, {
      lifted_by: '刘芳', lift_reason: '排查结束'
    });
    check('解除麻酱令：BATCH-003 与 BATCH-BF1 脱离',
      r.status === 200 &&
      JSON.stringify(codes(r.json.quarantine.released)) === JSON.stringify(['BATCH-003', 'BATCH-BF1']),
      r.json.quarantine);

    // ---------- 9. 整页状态汇总 ----------
    console.log('9) /api/state 汇总隔离令台账');
    const stEnd = await state();
    check('state 顶层含隔离令台账（全部已解除）',
      Array.isArray(stEnd.quarantine_orders) && stEnd.quarantine_orders.length === 5 &&
      stEnd.quarantine_orders.every((o) => o.status === 'LIFTED'),
      stEnd.quarantine_orders && stEnd.quarantine_orders.length);
    check('全部解除后无受控批次',
      stEnd.batches.every((b) => !b.quarantined), stEnd.batches.filter((b) => b.quarantined));
    check('LABEL-0001 未再暂停贴用',
      stEnd.label_rolls.find((x) => x.roll_code === 'LABEL-0001').quarantine_paused === false);

    console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
    proc.kill();
    process.exit(failures === 0 ? 0 : 1);
  } catch (err) {
    console.error('测试执行异常：', err);
    proc.kill();
    process.exit(1);
  }
}

main();
