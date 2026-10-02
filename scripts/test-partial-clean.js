'use strict';
// 部分清洗（CLEAN 显式携带已核实去除过敏原集合 clean_allergens）端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务实例（空白库，自建数据），验证：
//   入参：省略=全清（旧请求兼容）；显式空集/非字符串/空白名称拒绝；重复名按一个处理；
//        PROCESS 携带 clean_allergens 拒绝；
//   推导：部分清洗只清除指定过敏原的设备残留与来源，其余残留进入后续批次；
//        更正/删除早期清洗后沿时间线重算并联动放行/标签卷/出货单/处置结论；
//   追溯：尚有任一未清除过敏原即不能排除批号（顺序多次部分清洗按过敏原逐一截断）；
//        无过敏原登记原料部分清洗不能排除批号，只有全清截断；清洗不抹去直接投料/批次引用；
//   换线：单条编辑、整组 preview/apply 均支持清洗范围；预演不改正式状态；版本校验沿用；
//   状态展示：/api/state 事件含清洗范围与清洗后残留，设备含最近一次清洗范围。
//   node scripts/test-partial-clean.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39141';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-clean-test-'));
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
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    const newId = async (url, body) => (await api('POST', url, body)).json.id;
    const MILK = await newId('/api/materials', { code: 'MILK', name: '奶粉', allergens: ['乳', '大豆'] });
    const PNT = await newId('/api/materials', { code: 'PNT', name: '花生碎', allergens: ['花生'] });
    const SALT = await newId('/api/materials', { code: 'SALT', name: '食用盐', allergens: [] });
    const LINE = await newId('/api/equipment', { code: 'LINE-A', name: '一线' });
    const LINE2 = await newId('/api/equipment', { code: 'LINE-B', name: '二线' });
    const LOT = await newId('/api/material-lots', { material_id: MILK, lot_code: 'L-100' });
    const SALT_LOT = await newId('/api/material-lots', { material_id: SALT, lot_code: 'S-9' });
    const D = '2026-10-01T';
    let r;

    const procEvent = (time, equipment_id, batch_code, material_inputs) =>
      api('POST', '/api/events', {
        type: 'PROCESS', event_time: D + time, equipment_id, batch_code, material_inputs
      });
    const cleanEvent = (time, equipment_id, extra = {}) =>
      api('POST', '/api/events', { type: 'CLEAN', event_time: D + time, equipment_id, ...extra });
    const state = async () => (await api('GET', '/api/state')).json;
    const batchOf = (s, code) => s.batches.find((b) => b.code === code);
    const trace = async (params) =>
      api('GET', '/api/trace/material-lot?' + new URLSearchParams(params).toString());

    // ---------- 1. 入参校验 ----------
    console.log('1) 清洗范围入参：空集/非字符串/空白/PROCESS 携带均拒绝；旧请求（省略）=全清');
    r = await cleanEvent('07:00', LINE, { clean_allergens: [] });
    check('显式空数组 → 400', r.status === 400, r.json);
    r = await cleanEvent('07:00', LINE, { clean_allergens: ['  '] });
    check('空白名称 → 400', r.status === 400, r.json);
    r = await cleanEvent('07:00', LINE, { clean_allergens: [3, '乳'] });
    check('非字符串 → 400', r.status === 400, r.json);
    r = await cleanEvent('07:00', LINE, { clean_allergens: '乳' });
    check('非数组 → 400', r.status === 400, r.json);
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: D + '07:00', equipment_id: LINE, batch_code: 'BX',
      material_ids: [SALT], clean_allergens: ['乳']
    });
    check('PROCESS 携带 clean_allergens → 400', r.status === 400, r.json);

    // ---------- 2. 部分清洗推导：只清指定过敏原 ----------
    console.log('2) B1 投乳/大豆/花生 → 部分清洗仅去乳 → B2（盐）只继承花生+大豆残留');
    await procEvent('08:00', LINE, 'B1', [
      { material_id: MILK, lot_id: LOT }, { material_id: PNT }
    ]);
    r = await cleanEvent('09:00', LINE, { note: '部分清洗-乳', clean_allergens: [' 乳 ', '乳'] });
    check('重复/带空格名称按一个处理（200）', r.status === 200, r.json);
    await procEvent('10:00', LINE, 'B2', [{ material_id: SALT }]);
    let s = await state();
    check('B2 推导不含乳、仍含花生/大豆',
      JSON.stringify(batchOf(s, 'B2').allergens) === JSON.stringify(['大豆', '花生']),
      batchOf(s, 'B2').allergens);
    const clean9 = s.events.find((e) => e.note === '部分清洗-乳');
    check('state 清洗事件 clean_allergens=["乳"]',
      JSON.stringify(clean9.clean_allergens) === JSON.stringify(['乳']), clean9);
    check('state 清洗事件 clean_scope_full=false / clean_partial=true',
      clean9.clean_scope_full === false && clean9.clean_partial === true, clean9);
    check('state 清洗事件 清洗后残留=[大豆,花生]',
      JSON.stringify(clean9.post_clean_residue) === JSON.stringify(['大豆', '花生']),
      clean9.post_clean_residue);
    const lineA = s.equipment.find((q) => q.code === 'LINE-A');
    check('设备最近清洗范围=[乳] 且标记部分清洗',
      lineA.last_clean_partial === true &&
      JSON.stringify(lineA.last_clean_allergens) === JSON.stringify(['乳']), lineA);
    check('清洗后花生残留路径来自设备残留',
      batchOf(s, 'B2').paths['花生'][0].includes('设备残留:LINE-A'),
      batchOf(s, 'B2').paths['花生']);

    // ---------- 3. 全清（省略范围）仍截断全部 ----------
    console.log('3) 11:00 全清（旧请求省略 clean_allergens）→ B3 无残留过敏原');
    await cleanEvent('11:00', LINE, { note: '班后全清' });
    await procEvent('12:00', LINE, 'B3', [{ material_id: SALT }]);
    s = await state();
    check('B3 无过敏原', batchOf(s, 'B3').allergens.length === 0, batchOf(s, 'B3').allergens);
    check('设备残留为空', lineA && s.equipment.find((q) => q.code === 'LINE-A').allergens.length === 0);

    // ---------- 4. 重算联动放行 / 标签卷 / 出货单 / 处置结论 ----------
    console.log('4) 放行/标签卷/出货后，把全清改为部分清洗，联动失效/停用/待评估');
    // LINE2 时间线：08:00 B6(花生) → 09:00 全清 → 10:00 B4(盐，无过敏原)。
    await procEvent('08:00', LINE2, 'B6', [{ material_id: PNT }]);
    await cleanEvent('09:00', LINE2, { note: 'B4 前清洗' });
    await procEvent('10:00', LINE2, 'B4', [{ material_id: SALT }]);
    s = await state();
    check('全清后 B4 无过敏原', batchOf(s, 'B4').allergens.length === 0, batchOf(s, 'B4').allergens);

    // 登记放行（快照空集）
    r = await api('POST', '/api/releases', {
      batch_id: batchOf(s, 'B4').id, released_at: D + '10:30', released_by: '质检'
    });
    check('B4 放行登记成功', r.status === 200, r.json);
    const releaseId = r.json.id;
    // 登记标签卷（空集合）并核销 10 张
    r = await api('POST', '/api/label-rolls', {
      batch_id: batchOf(s, 'B4').id, release_id: releaseId,
      allergens: [], print_qty: 100, registered_by: '包装'
    });
    check('标签卷登记成功', r.status === 200, r.json);
    const rollId = r.json.id;
    r = await api('POST', `/api/label-rolls/${rollId}/consume`, {
      expected_revision: 0, applied: 10, voided: 0, used_by: '包装工'
    });
    check('核销 10 张贴用', r.status === 200 && r.json.revision === 1, r.json);
    // 出货 10 张
    r = await api('POST', '/api/shipments', {
      batch_id: batchOf(s, 'B4').id, ship_qty: 10, shipped_by: '仓管',
      allocations: [{ roll_id: rollId, qty: 10 }]
    });
    check('出货单创建（SHIPPED）', r.status === 200 && r.json.status === 'SHIPPED', r.json);
    const shipCode = r.json.shipment_code;

    // 把 09:00 全清更正为部分清洗（只去乳；花生残留保留进入 B4）→ 重算联动
    const cleanBefore = (await state()).events.find((e) => e.note === 'B4 前清洗');
    r = await api('PUT', `/api/events/${cleanBefore.id}`, {
      type: 'CLEAN', event_time: D + '09:00', equipment_id: LINE2,
      note: 'B4 前清洗（改为只去乳）', clean_allergens: ['乳']
    });
    check('清洗更正为部分清洗 200', r.status === 200, r.json);
    check('联动：B4 原放行失效（新增花生）',
      (r.json.invalidated || []).some((x) => x.batch_code === 'B4'), r.json.invalidated);
    check('联动：标签卷永久停用',
      (r.json.retired_rolls || []).some((x) => x.id === rollId), r.json.retired_rolls);
    check('联动：出货单转待评估',
      (r.json.pending_shipments || []).some((x) => x.shipment_code === shipCode),
      r.json.pending_shipments);
    s = await state();
    check('重算后 B4 含花生', batchOf(s, 'B4').allergens.includes('花生'), batchOf(s, 'B4').allergens);

    // 处置结论登记（召回）→ 再把清洗改回全清 → 旧结论 STALE（不自动生效）
    let evView = await api('GET', `/api/shipments/${shipCode}/evaluation`);
    const ver = evView.json.version;
    r = await api('POST', `/api/shipments/${shipCode}/dispositions`, {
      decision: 'RECALL', decided_by: '质检', basis: '花生未声明，召回', version: ver
    });
    check('召回处置登记成功', r.status === 200, r.json);
    r = await api('PUT', `/api/events/${cleanBefore.id}`, {
      type: 'CLEAN', event_time: D + '09:00', equipment_id: LINE2,
      note: 'B4 前清洗（恢复全清）'
    });
    check('恢复全清后旧处置结论标 STALE（不自动生效）',
      (r.json.stale_dispositions || []).some((x) => x.shipment_code === shipCode),
      r.json.stale_dispositions);

    // ---------- 5. 追溯：未清除过敏原保留设备传播 ----------
    console.log('5) 批号追溯与部分清洗（在 LINE 上：L-100 乳+大豆）');
    // LINE 当前：B1(08:00 乳大豆花生) → 部分清洗去乳(09:00) → B2(10:00 盐) → 全清(11:00) → B3(12:00 盐)
    r = await trace({ material_id: MILK, lot_id: LOT });
    check('仅去乳后 L-100 仍命中 B1/B2（大豆残留未清）；全清后 B3 排除',
      JSON.stringify(r.json.confirmed_batches.map((b) => b.batch_code)) === JSON.stringify(['B1', 'B2']),
      r.json.confirmed_batches.map((b) => b.batch_code));
    check('B2 的设备残留依据链仍在',
      r.json.confirmed_batches.find((b) => b.batch_code === 'B2')
        .evidence.confirmed.routes.equipment_residue === true);

    // 顺序再加一次“去大豆”部分清洗（10:30，在 B2 之后、全清之前）→ 其后批次才排除
    await cleanEvent('10:30', LINE, { note: '补去大豆', clean_allergens: ['大豆'] });
    await procEvent('10:45', LINE, 'B2B', [{ material_id: SALT }]);
    r = await trace({ material_id: MILK, lot_id: LOT });
    check('乳、大豆分两次部分清洗后，10:45 的 B2B 排除 L-100（历史 B2 仍命中）',
      !r.json.confirmed_batches.some((b) => b.batch_code === 'B2B') &&
      r.json.confirmed_batches.some((b) => b.batch_code === 'B2'),
      r.json.confirmed_batches.map((b) => b.batch_code));

    // 无过敏原原料：部分清洗不能排除批号，全清才截断
    console.log('6) 无过敏原登记原料（盐 S-9）：部分清洗不能排除，只有全清截断');
    await procEvent('14:00', LINE2, 'B7', [{ material_id: SALT, lot_id: SALT_LOT }]);
    await cleanEvent('14:30', LINE2, { clean_allergens: ['乳', '花生'] });
    await procEvent('14:45', LINE2, 'B8', [{ material_id: SALT }]);
    r = await trace({ material_id: SALT, lot_id: SALT_LOT });
    check('部分清洗后 S-9 仍命中 B7/B8（原料无过敏原登记）',
      ['B7', 'B8'].every((c) => r.json.confirmed_batches.some((b) => b.batch_code === c)),
      r.json.confirmed_batches.map((b) => b.batch_code));
    await cleanEvent('14:50', LINE2, {}); // 省略范围 = 全清
    await procEvent('14:55', LINE2, 'B9', [{ material_id: SALT }]);
    r = await trace({ material_id: SALT, lot_id: SALT_LOT });
    check('全清后 B9 排除 S-9（直接投料的 B7/B8 仍命中）',
      !r.json.confirmed_batches.some((b) => b.batch_code === 'B9') &&
      r.json.confirmed_batches.some((b) => b.batch_code === 'B7'),
      r.json.confirmed_batches.map((b) => b.batch_code));

    // 清洗不抹去直接投料/批次引用
    console.log('7) 部分清洗不抹去已发生的直接投料与批次引用');
    const L4 = await newId('/api/equipment', { code: 'LINE-D', name: '四线' });
    await procEvent('08:00', L4, 'BR1', [{ material_id: MILK, lot_id: LOT }]);
    await cleanEvent('08:10', L4, { clean_allergens: ['乳', '大豆'] });
    await procEvent('08:20', L4, 'BR2', [{ material_id: SALT }]);
    // BR2 引用 BR1（引用传播不受清洗影响）
    const br1Id = (await state()).batches.find((b) => b.code === 'BR1').id;
    const br2Ev = (await state()).events.find((e) => e.batch_code === 'BR2');
    r = await api('PUT', `/api/events/${br2Ev.id}`, {
      type: 'PROCESS', event_time: D + '08:20', equipment_id: L4, batch_code: 'BR2',
      material_inputs: [{ material_id: SALT }], ref_batch_ids: [br1Id]
    });
    check('BR2 引用 BR1 更正成功', r.status === 200, r.json);
    r = await trace({ material_id: MILK, lot_id: LOT });
    check('BR2 经批次引用仍命中 L-100（清洗不截断直接投料/引用）',
      r.json.confirmed_batches.some((b) => b.batch_code === 'BR2') &&
      r.json.confirmed_batches.find((b) => b.batch_code === 'BR2')
        .evidence.confirmed.routes.batch_reference === true,
      r.json.confirmed_batches.map((b) => b.batch_code));
    check('BR2 不经设备残留命中（乳/大豆残留已被部分清洗清除）',
      r.json.confirmed_batches.find((b) => b.batch_code === 'BR2')
        .evidence.confirmed.routes.equipment_residue === false);

    // ---------- 8. 整组换线：预演/确认支持清洗范围 ----------
    console.log('8) replan preview/apply 支持清洗范围（预演不改正式状态 + 版本校验）');
    // 新建设备时间线：C1(花生) → CLEAN(全清) → C2(盐)；预演把全清改部分清洗（去乳）
    const L3 = await newId('/api/equipment', { code: 'LINE-C', name: '三线' });
    await procEvent('08:00', L3, 'C1', [{ material_id: PNT }]);
    const cleanL3Id = (await (async () => {
      await cleanEvent('09:00', L3, { note: 'L3 全清' });
      return (await state()).events.find((e) => e.type === 'CLEAN' && e.equipment_id === L3).id;
    })());
    await procEvent('10:00', L3, 'C2', [{ material_id: SALT }]);
    const changes = [{
      op: 'update', event_id: cleanL3Id, type: 'CLEAN', event_time: D + '09:00',
      equipment_id: L3, note: 'L3 改部分清洗', clean_allergens: ['乳']
    }];
    r = await api('POST', '/api/replan/preview', { changes });
    check('预演 200 并回显部分清洗范围',
      r.status === 200 &&
      JSON.stringify(r.json.changes[0].clean_allergens) === JSON.stringify(['乳']), r.json);
    const l3diff = r.json.diff.equipment_residue.find((x) => x.equipment_code === 'LINE-C');
    check('预演差异含变化依据（before 全清 null → after [乳]，残留新增花生）',
      l3diff.before_last_clean_allergens === null &&
      JSON.stringify(l3diff.after_last_clean_allergens) === JSON.stringify(['乳']) &&
      l3diff.added.includes('花生'), l3diff);
    // 预演不改正式状态
    s = await state();
    check('预演后正式 C2 仍无花生（预演不落库）',
      !batchOf(s, 'C2').allergens.includes('花生'), batchOf(s, 'C2').allergens);
    // 预演阶段拒绝非法范围
    r = await api('POST', '/api/replan/preview', {
      changes: [{ ...changes[0], clean_allergens: [] }]
    });
    check('预演：显式空集 → 400 INVALID_REQUEST',
      r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    // insert_clean 支持部分清洗范围
    r = await api('POST', '/api/replan/preview', {
      changes: [{
        op: 'insert_clean', client_key: 'pc', event_time: D + '09:30',
        equipment_id: L3, clean_allergens: ['花生']
      }]
    });
    check('insert_clean 部分清洗预演 200', r.status === 200 &&
      r.json.inserted_clean_events[0].client_key === 'pc', r.json);
    // 正式写入使版本过期
    await api('POST', '/api/events', {
      type: 'CLEAN', event_time: D + '07:30', equipment_id: L3, note: '预演后插入的正式清洗'
    });
    // 用原预演版本 apply（预演后正式数据已变）→ VERSION_EXPIRED
    r = await api('POST', '/api/replan/preview', { changes });
    const ver2 = r.json.version;
    await api('POST', '/api/events', {
      type: 'CLEAN', event_time: D + '07:45', equipment_id: L3, note: '使版本过期的正式写入'
    });
    r = await api('POST', '/api/replan/apply', { version: ver2, changes });
    check('预演后正式写入 → apply 409 VERSION_EXPIRED 且原状态不变',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    s = await state();
    check('VERSION_EXPIRED 后正式 C2 仍无花生',
      !batchOf(s, 'C2').allergens.includes('花生'), batchOf(s, 'C2').allergens);
    // 重新预演并确认应用
    r = await api('POST', '/api/replan/preview', { changes });
    r = await api('POST', '/api/replan/apply', { version: r.json.version, changes });
    check('确认应用 200 且 C2 新增花生残留',
      r.status === 200 &&
      r.json.diff.equipment_residue.find((x) => x.equipment_code === 'LINE-C')
        .after_allergens.includes('花生'), r.json);
    s = await state();
    check('应用后正式 C2 含花生', batchOf(s, 'C2').allergens.includes('花生'));
    const l3State = s.equipment.find((q) => q.code === 'LINE-C');
    check('应用后设备最近清洗范围=[乳]（部分清洗）',
      l3State.last_clean_partial === true &&
      JSON.stringify(l3State.last_clean_allergens) === JSON.stringify(['乳']));

    // changes 不一致 → 409
    r = await api('POST', '/api/replan/preview', { changes });
    const ver3 = r.json.version;
    r = await api('POST', '/api/replan/apply', {
      version: ver3,
      changes: [{ ...changes[0], clean_allergens: ['大豆'] }]
    });
    check('apply changes 与预演不一致 → 409 CHANGES_MISMATCH',
      r.status === 409 && r.json.code === 'CHANGES_MISMATCH', r.json);
  } finally {
    proc.kill();
  }

  if (failures) {
    console.error(`\n${failures} 项未通过`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
