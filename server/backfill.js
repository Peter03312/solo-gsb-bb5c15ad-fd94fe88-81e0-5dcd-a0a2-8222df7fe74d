'use strict';
// 断网期间日志整包补录。
//
// 设备断网期间发生的加工（PROCESS）与已核实清洗（CLEAN）事件，恢复联网后可用一个
// 补录批号（backfill_code）整包补录：
//   - 每条记录含外部记录号（external_ref，断网日志原始记录号）、时间与设备；
//     加工记录含产出批次、原料输入（供应批号可未知）和/或引用批次；
//     清洗记录省略 clean_allergens 表示全清，非空集合表示部分清洗。
//   - 包内引用只可指向“有序记录中更早产出”的批次。
//   - 整包事务化：未知对象、空清洗集合、时间冲突、未来/循环引用、外部记录号与已入库
//     内容冲突等一律整包回滚，不留部分事件。
// 幂等：
//   - 相同补录批号 + 相同内容重试 -> 返回首次成功的原结果（不重复写入）；
//   - 相同补录批号 + 不同内容 -> 整包拒绝（409 BACKFILL_CODE_CONFLICT）。
// 外部记录号：
//   - 同号同内容的既有记录复用其事件（不重复写入），新包记录仍指向该既有事件；
//   - 同号不同内容（与已入库内容冲突）-> 整包拒绝（409 BACKFILL_EXTERNAL_REF_CONFLICT）。
// 成功后按既有时间线规则全量重算：设备残留及放行、标签卷、出货单、质量处置结论联动，
// 返回外部记录号 -> 事件号映射与影响摘要；可按补录批号查询对账结果。

const crypto = require('crypto');
const { validateAll } = require('./validation');
const { recompute } = require('./recompute');

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

class BackfillError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'BackfillError';
    this.code = code;
    this.details = details || [];
  }
}

// ---------- 稳定序列化 / 哈希 ----------
// 规范化记录仅含会决定事件内容的字段（解析为档案 id 之后），顺序无关的集合先排序。
function canonicalString(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalString).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalString(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
function hashOf(canonical) {
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// 记录的规范化内容（解析为 id 后；external_ref 不参与“事件内容”哈希，
// 但参与整包内容哈希——同一批内容换了外部记录号属于不同的补录请求）。
function recordCanonical(rec, { withExternalRef }) {
  const base = {
    type: rec.type,
    event_time: rec.event_time,
    equipment_id: rec.equipment_id,
    note: rec.note
  };
  if (withExternalRef) base.external_ref = rec.external_ref;
  if (rec.type === 'CLEAN') {
    // null=全清；非空数组=部分清洗（写入前已去重，这里再排序保证稳定）。
    base.clean_allergens = rec.clean_allergens
      ? rec.clean_allergens.slice().sort((a, b) => a.localeCompare(b, 'zh'))
      : null;
  } else {
    base.batch_code = rec.batch_code;
    base.material_inputs = (rec.material_inputs || [])
      .slice()
      .sort((a, b) =>
        a.material_id - b.material_id ||
        (a.material_lot_id == null ? -1 : b.material_lot_id == null ? 1
          : a.material_lot_id - b.material_lot_id))
      .map((x) => ({ material_id: x.material_id, material_lot_id: x.material_lot_id }));
    base.ref_batch_codes = (rec.ref_batch_codes || []).slice().sort();
  }
  return canonicalString(base);
}

// 外部形态规范化（id/code 解析前；仅供“相同补录批号重试”提前判定，
// 使重试无需通过档案解析——首次提交后产出批次已在库，解析会误报批次已存在）。
// 引用解析仅按 id/code 做等价转换，不改变外部形态语义；同内容重试时本哈希稳定。
function externalCanonicalRecord(rec) {
  const ref = (x) => x.kind === 'id' ? { id: x.value } : { code: x.value };
  const base = {
    external_ref: rec.external_ref,
    type: rec.type,
    event_time: rec.event_time,
    equipment: ref(rec.equipment),
    note: rec.note
  };
  if (rec.type === 'CLEAN') {
    base.clean_allergens = rec.clean_allergens
      ? rec.clean_allergens.slice().sort((a, b) => a.localeCompare(b, 'zh'))
      : null;
  } else {
    base.batch_code = rec.batch_code;
    base.material_inputs = (rec.material_inputs || []).map((x) => ({
      material: ref(x.material),
      lot_id: x.lot_id,
      lot_code: x.lot_code
    }));
    base.ref_batches = (rec.ref_batches || []).map(ref);
  }
  return base;
}

// ---------- 请求体规范化（只做形状校验；档案解析在后续阶段） ----------
function normalizeRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BackfillError('INVALID_REQUEST', '请求体必须是对象');
  }
  const backfill_code = String(body.backfill_code || body.batch_code || '').trim();
  if (!backfill_code) {
    throw new BackfillError('INVALID_REQUEST', '补录批号 backfill_code 不能为空');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(backfill_code)) {
    throw new BackfillError(
      'INVALID_REQUEST',
      '补录批号仅允许字母、数字、点、下划线、冒号与连字符，且以字母或数字开头'
    );
  }
  const rawRecords = body.records;
  if (!Array.isArray(rawRecords)) {
    throw new BackfillError('INVALID_REQUEST', 'records 必须是有序数组，每项为一条补录记录');
  }
  if (rawRecords.length === 0) {
    throw new BackfillError('INVALID_REQUEST', '补录包至少包含一条记录');
  }

  const records = [];
  const seenRef = new Set();
  const errors = [];
  rawRecords.forEach((raw, idx) => {
    const where = `records[${idx}]`;
    const r = raw && typeof raw === 'object' ? raw : null;
    if (!r) { errors.push(`${where}：记录必须是对象`); return; }

    const external_ref = String(r.external_ref != null ? r.external_ref : r.external_record_no || '').trim();
    if (!external_ref) { errors.push(`${where}：缺少外部记录号 external_ref`); }
    else if (seenRef.has(external_ref)) {
      errors.push(`${where}：外部记录号 "${external_ref}" 在补录包内重复`);
    } else {
      seenRef.add(external_ref);
    }

    const type = String(r.type || '').toUpperCase();
    if (type !== 'PROCESS' && type !== 'CLEAN') {
      errors.push(`${where}：记录类型必须为 PROCESS 或 CLEAN`);
    }
    const event_time = String(r.event_time || '').trim();
    if (!event_time) errors.push(`${where}：缺少事件时间 event_time`);
    else if (!TIME_RE.test(event_time)) {
      errors.push(`${where}：事件时间格式应为 YYYY-MM-DDTHH:MM，例如 2026-09-30T08:00`);
    }
    const equipment = parseRef(r.equipment_id, r.equipment_code, '设备');
    if (equipment && equipment.error) errors.push(`${where}：${equipment.error}`);

    const note = String(r.note || '').trim();
    const rec = {
      seq: idx,
      external_ref,
      type,
      event_time,
      equipment,
      note
    };

    if (type === 'CLEAN') {
      // 清洗范围：省略/null = 全清；非空数组 = 部分清洗；显式空集/非字符串/空白拒绝。
      const rawScope = r.clean_allergens;
      if (rawScope !== undefined && rawScope !== null) {
        if (!Array.isArray(rawScope)) {
          errors.push(`${where}：清洗范围 clean_allergens 必须是过敏原名称数组（省略该字段表示全清）`);
        } else if (rawScope.length === 0) {
          errors.push(`${where}：清洗范围不能为空数组：显式空集表示本次未去除任何过敏原，应省略 clean_allergens 或按实际去除项填写`);
        } else {
          const bad = rawScope.filter((a) => typeof a !== 'string' || !a.trim());
          if (bad.length) {
            errors.push(`${where}：清洗范围中的过敏原名称必须是非空白字符串，不允许显式空集或空白名称`);
          } else {
            rec.clean_allergens = [...new Set(rawScope.map((a) => a.trim()))];
          }
        }
      } else {
        rec.clean_allergens = null; // 全清
      }
      if (r.batch_code !== undefined || r.material_inputs !== undefined ||
          r.material_ids !== undefined || r.ref_batch_codes !== undefined ||
          r.ref_batch_ids !== undefined) {
        errors.push(`${where}：清洗（CLEAN）记录不携带产出批次、原料输入或引用批次`);
      }
    }

    if (type === 'PROCESS') {
      if (r.clean_allergens !== undefined && r.clean_allergens !== null) {
        errors.push(`${where}：clean_allergens 清洗范围仅适用于 CLEAN 清洗记录，加工记录不携带该字段`);
      }
      const batch_code = String(r.batch_code || '').trim();
      if (!batch_code) errors.push(`${where}：加工记录缺少产出批次 batch_code`);
      rec.batch_code = batch_code;

      // 原料输入：新形态 material_inputs:[{material_id|material_code, lot_id?|lot_code?}]
      // 与旧形态 material_ids:[...]（全部记为批号未知）。
      rec.material_inputs = [];
      if (r.material_inputs !== undefined) {
        if (!Array.isArray(r.material_inputs)) {
          errors.push(`${where}：material_inputs 必须是数组，每项为 {material_id|material_code, lot_id?|lot_code?}`);
        } else {
          r.material_inputs.forEach((inp, j) => {
            const w = `${where}.material_inputs[${j}]`;
            if (!inp || typeof inp !== 'object') {
              errors.push(`${w} 必须是对象`);
              return;
            }
            const mat = parseRef(inp.material_id, inp.material_code, '原料');
            if (!mat || mat.error) {
              errors.push(`${w}：${mat ? mat.error : '缺少合法的 material_id/material_code'}`);
              return;
            }
            const hasLotId = inp.lot_id !== undefined && inp.lot_id !== null && inp.lot_id !== '';
            const hasLotCode = inp.lot_code !== undefined && inp.lot_code !== null && inp.lot_code !== '';
            if (hasLotId && hasLotCode) {
              errors.push(`${w}：lot_id 与 lot_code 只能提供其一`);
              return;
            }
            let lotId = null;
            let lotCode = null;
            if (hasLotId) {
              const n = parseInt(inp.lot_id, 10);
              if (!Number.isInteger(n)) { errors.push(`${w}：lot_id 不合法`); return; }
              lotId = n;
            } else if (hasLotCode) {
              lotCode = String(inp.lot_code).trim();
              if (!lotCode) { errors.push(`${w}：lot_code 不能为空`); return; }
            }
            rec.material_inputs.push({ material: mat, lot_id: lotId, lot_code: lotCode });
          });
        }
      }
      if (Array.isArray(r.material_ids)) {
        r.material_ids.forEach((mid, j) => {
          const n = parseInt(mid, 10);
          if (!Number.isInteger(n)) {
            errors.push(`${where}.material_ids[${j}]：原料 id 不合法`);
            return;
          }
          if (!rec.material_inputs.some((x) => x.material.kind === 'id' && x.material.value === n)) {
            rec.material_inputs.push({ material: { kind: 'id', value: n }, lot_id: null, lot_code: null });
          }
        });
      }

      // 引用批次：新形态 ref_batch_codes（可引用包内更早产出的批次）与旧形态 ref_batch_ids。
      rec.ref_batches = [];
      const addRef = (key, raw2) => {
        if (raw2 === undefined) return;
        if (!Array.isArray(raw2)) { errors.push(`${where}：${key} 必须是数组`); return; }
        raw2.forEach((x, j) => {
          const ref = parseBatchRef(x);
          if (ref.error) { errors.push(`${where}.${key}[${j}]：${ref.error}`); return; }
          rec.ref_batches.push(ref);
        });
      };
      addRef('ref_batch_codes', r.ref_batch_codes);
      addRef('ref_batch_ids', r.ref_batch_ids);
    }

    records.push(rec);
  });

  if (errors.length) {
    throw new BackfillError('INVALID_REQUEST', '补录请求内容校验未通过', errors);
  }
  return { backfill_code, records };
}

// 档案引用：优先数字 id；同时给 id 与 code 时要求二者择一。返回 {kind,value} 或 {error}。
function parseRef(idRaw, codeRaw, label) {
  const hasId = idRaw !== undefined && idRaw !== null && idRaw !== '';
  const hasCode = codeRaw !== undefined && codeRaw !== null && codeRaw !== '';
  if (hasId && hasCode) return { error: `${label} 的 id 与编码只能提供其一` };
  if (!hasId && !hasCode) return { error: `缺少 ${label} id 或编码` };
  if (hasId) {
    const n = parseInt(idRaw, 10);
    if (!Number.isInteger(n)) return { error: `${label} id 不合法` };
    return { kind: 'id', value: n };
  }
  const code = String(codeRaw).trim();
  if (!code) return { error: `${label} 编码不能为空` };
  return { kind: 'code', value: code };
}

// 引用批次条目：数字（含数字字符串）按批次 id，其余按批次编码。
function parseBatchRef(x) {
  if (typeof x === 'number' && Number.isInteger(x)) return { kind: 'id', value: x };
  if (typeof x === 'string' && /^\d+$/.test(x.trim())) {
    return { kind: 'id', value: parseInt(x.trim(), 10) };
  }
  if (typeof x === 'string' && x.trim()) return { kind: 'code', value: x.trim() };
  return { error: '引用批次必须是批次 id（整数）或批次编码（字符串）' };
}

// ---------- 档案解析（id/code -> id；未知对象在此明确拒绝） ----------
// knownExternalRefs：外部记录号已在台账中（同号重试 或 同号同内容跨包复用）的记录集合。
// 这些记录不写入新事件，故其产出批次“已在库”是预期结果，不做“批次已存在”拦截；
// 内容一致性由 checkExternalRefs 按记录内容哈希强制。
function resolveReferences(db, records, knownExternalRefs) {
  const errors = [];

  const equipById = new Map(db.prepare('SELECT id, code FROM equipment').all().map((e) => [e.id, e]));
  const equipByCode = new Map(db.prepare('SELECT id, code FROM equipment').all().map((e) => [e.code, e]));
  const matById = new Map(db.prepare('SELECT id, code FROM materials').all().map((m) => [m.id, m]));
  const matByCode = new Map(db.prepare('SELECT id, code FROM materials').all().map((m) => [m.code, m]));
  const lotRows = db.prepare('SELECT id, material_id, lot_code FROM material_lots').all();
  const lotById = new Map(lotRows.map((l) => [l.id, l]));
  const lotByCode = new Map(lotRows.map((l) => [`${l.material_id}|${l.lot_code}`, l]));

  const resolveOne = (ref, byId, byCode, label, where) => {
    if (ref.kind === 'id') {
      const row = byId.get(ref.value);
      if (!row) { errors.push(`${where}：${label} #${ref.value} 不存在，请先登记`); return null; }
      return row.id;
    }
    const row = byCode.get(ref.value);
    if (!row) { errors.push(`${where}：${label} "${ref.value}" 不存在，请先登记`); return null; }
    return row.id;
  };

  // 包内产出批次（batch_code -> seq），须唯一且不与库内既有批次编码冲突。
  // 外部记录号已在台账中的记录（同号重试/同号复用）不产生新批次，豁免这两项检查。
  const producedInPackage = new Map();
  for (const rec of records) {
    if (rec.type !== 'PROCESS') continue;
    if (knownExternalRefs.has(rec.external_ref)) continue;
    if (producedInPackage.has(rec.batch_code)) {
      errors.push(`records[${rec.seq}]：产出批次 "${rec.batch_code}" 在补录包内被多次加工产出`);
    } else {
      producedInPackage.set(rec.batch_code, rec.seq);
    }
  }
  const existingBatchByCode = new Map(
    db.prepare('SELECT id, code FROM batches').all().map((b) => [b.code, b.id])
  );
  for (const [code, seq] of producedInPackage.entries()) {
    if (existingBatchByCode.has(code)) {
      // 断网补录只能补录“断网期间缺失”的加工；产出已在库的批次不属于补录范围。
      errors.push(`records[${seq}]：产出批次 "${code}" 已在时间线中存在，不能重复加工产出`);
    }
  }

  const resolved = [];
  for (const rec of records) {
    const where = `records[${rec.seq}]（外部记录号 ${rec.external_ref}）`;
    const equipment_id = resolveOne(rec.equipment, equipById, equipByCode, '设备', where);

    const out = {
      seq: rec.seq,
      external_ref: rec.external_ref,
      type: rec.type,
      event_time: rec.event_time,
      equipment_id,
      note: rec.note
    };

    if (rec.type === 'CLEAN') {
      out.clean_allergens = rec.clean_allergens;
      resolved.push(out);
      continue;
    }

    out.batch_code = rec.batch_code;

    // 原料输入解析（批号未知 material_lot_id=null；批号不存在/与原料不匹配在此拒绝）。
    out.material_inputs = [];
    for (const inp of rec.material_inputs) {
      const w = `${where} 原料输入`;
      const material_id = resolveOne(inp.material, matById, matByCode, '原料', w);
      let material_lot_id = null;
      if (material_id != null) {
        if (inp.lot_id != null) {
          const lot = lotById.get(inp.lot_id);
          if (!lot) {
            errors.push(`${w}：供应批号 #${inp.lot_id} 不存在，请先登记该批号`);
          } else if (lot.material_id !== material_id) {
            errors.push(
              `${w}：供应批号 ${lot.lot_code}（#${lot.id}）属于原料 #${lot.material_id}，与输入原料 #${material_id} 不匹配`
            );
          } else {
            material_lot_id = lot.id;
          }
        } else if (inp.lot_code != null) {
          const lot = lotByCode.get(`${material_id}|${inp.lot_code}`);
          if (!lot) {
            errors.push(`${w}：原料 #${material_id} 下不存在供应批号 "${inp.lot_code}"，请先登记该批号`);
          } else {
            material_lot_id = lot.id;
          }
        }
      }
      if (material_id != null) out.material_inputs.push({ material_id, material_lot_id });
    }

    // 引用批次解析：库内既有批次按 id/编码解析；包内更早产出的批次先放行，
    // “只可指向更早产出”（seq 更早 且 产出时间严格更早）在此逐项校验。
    out.ref_batch_codes = [];
    const refSeen = new Set();
    for (const ref of rec.ref_batches || []) {
      let batchCode = null;
      if (ref.kind === 'id') {
        const row = db.prepare('SELECT id, code FROM batches WHERE id = ?').get(ref.value);
        if (!row) { errors.push(`${where}：引用批次 #${ref.value} 不存在`); continue; }
        batchCode = row.code;
      } else {
        batchCode = ref.value;
      }
      if (refSeen.has(batchCode)) continue;
      refSeen.add(batchCode);

      if (producedInPackage.has(batchCode)) {
        const refSeq = producedInPackage.get(batchCode);
        if (refSeq >= rec.seq) {
          errors.push(`${where}：包内引用只可指向有序记录中更早产出的批次 "${batchCode}"（记录 #${refSeq} 不在本条之前）`);
        } else if (records[refSeq].event_time >= rec.event_time) {
          errors.push(`${where}：引用的包内批次 "${batchCode}" 产出时间 ${records[refSeq].event_time} 不早于本条 ${rec.event_time}`);
        }
      } else if (!existingBatchByCode.has(batchCode)) {
        errors.push(`${where}：引用批次 "${batchCode}" 既不在补录包内、也不在既有时间线中（未知对象）`);
      }
      out.ref_batch_codes.push(batchCode);
    }

    resolved.push(out);
  }

  if (errors.length) {
    throw new BackfillError('BACKFILL_REJECTED', '补录包引用的档案不存在或包内引用不合法', errors);
  }
  return resolved;
}

// ---------- 外部记录号冲突核对 ----------
// 同号同内容的既有记录复用其事件（不重复写入）；同号不同内容整包拒绝。
function checkExternalRefs(db, resolved) {
  const errors = [];
  const reused = new Map();
  for (const rec of resolved) {
    const ledgerRows = db.prepare(
      'SELECT * FROM backfill_records WHERE external_ref = ? ORDER BY id'
    ).all(rec.external_ref);
    if (!ledgerRows.length) continue;
    const first = ledgerRows[0];
    const myContentHash = hashOf(recordCanonical(rec, { withExternalRef: false }));
    if (first.content_hash !== myContentHash) {
      errors.push(
        `外部记录号 "${rec.external_ref}" 与已入库内容冲突（既有内容为 ${first.event_type} @ ${first.event_time}，` +
        `设备 #${first.equipment_id}）：外部记录号已使用且内容不同，整包拒绝`
      );
      continue;
    }
    if (first.event_id == null) {
      errors.push(
        `外部记录号 "${rec.external_ref}" 的既有事件已被删除，无法按同内容复用；请核对外部记录号`
      );
      continue;
    }
    const ev = db.prepare('SELECT id, type, event_time, equipment_id, batch_id FROM events WHERE id = ?')
      .get(first.event_id);
    if (!ev) {
      errors.push(`外部记录号 "${rec.external_ref}" 对应的既有事件 #${first.event_id} 已不存在`);
      continue;
    }
    reused.set(rec.external_ref, ev);
  }
  if (errors.length) {
    throw new BackfillError('BACKFILL_EXTERNAL_REF_CONFLICT', '外部记录号与已入库内容冲突', errors);
  }
  return reused;
}

// 对解析后的记录做集合规范化（顺序无关项排序），保证同内容不同提交顺序的哈希一致。
function normalizeResolvedRecord(rec) {
  const out = {
    seq: rec.seq,
    external_ref: rec.external_ref,
    type: rec.type,
    event_time: rec.event_time,
    equipment_id: rec.equipment_id,
    note: rec.note
  };
  if (rec.type === 'CLEAN') {
    out.clean_allergens = rec.clean_allergens
      ? [...new Set(rec.clean_allergens)].sort((a, b) => a.localeCompare(b, 'zh'))
      : null;
  } else {
    out.batch_code = rec.batch_code;
    // 同 (原料, 批号) 的重复投料行按一行计（与单条事件接口的去重口径一致，
    // 避免补录后经单条接口重写产生的行差异被误判为内容不符）。
    const inputKeys = new Set();
    out.material_inputs = [];
    for (const x of (rec.material_inputs || [])) {
      const key = `${x.material_id}|${x.material_lot_id == null ? '' : x.material_lot_id}`;
      if (inputKeys.has(key)) continue;
      inputKeys.add(key);
      out.material_inputs.push({ material_id: x.material_id, material_lot_id: x.material_lot_id });
    }
    out.material_inputs.sort((a, b) =>
      a.material_id - b.material_id ||
      ((a.material_lot_id || 0) - (b.material_lot_id || 0)));
    out.ref_batch_codes = [...new Set(rec.ref_batch_codes || [])].sort();
  }
  return out;
}

// ---------- 提交补录（整包事务化） ----------
// 外部记录号已在台账中（本包首次提交后重试，或跨包同号复用）的记录集合。
function collectKnownExternalRefs(db, normalized) {
  const known = new Set();
  const stmt = db.prepare('SELECT COUNT(*) AS c FROM backfill_records WHERE external_ref = ?');
  for (const rec of normalized) {
    if (stmt.get(rec.external_ref).c > 0) known.add(rec.external_ref);
  }
  return known;
}

function submitBackfill(db, rawBody) {
  const { backfill_code, records: normalized } = normalizeRequest(rawBody);

  // 补录批号存在时：同内容重试返回原结果，不同内容整包拒绝。
  // 先用解析前的外部形态哈希快速判定；不一致时再解析为档案 id 后比对——
  // 同一对象用编码或 id 提交（equipment_id/equipment_code、material_id/material_code）
  // 视为同内容。首次提交后产出批次已在库，需豁免本批/台账已知外部记录号的“批次已存在”检查。
  const existingBatch = db.prepare('SELECT * FROM backfill_batches WHERE backfill_code = ?')
    .get(backfill_code);
  if (existingBatch) {
    const externalHash = hashOf(canonicalString(
      normalized.map((r) => canonicalString(externalCanonicalRecord(r)))
    ));
    let sameContent = externalHash === existingBatch.external_hash;
    if (!sameContent) {
      try {
        const knownRefs = collectKnownExternalRefs(db, normalized);
        const retryResolved = resolveReferences(db, normalized, knownRefs)
          .map(normalizeResolvedRecord);
        const retryHash = hashOf(canonicalString(retryResolved.map((r) =>
          recordCanonical(r, { withExternalRef: true }))));
        sameContent = retryHash === existingBatch.content_hash;
      } catch (_) {
        // 解析失败（未知对象等）即不可能是同内容重试，落入下方整包拒绝。
        sameContent = false;
      }
    }
    if (!sameContent) {
      throw new BackfillError(
        'BACKFILL_CODE_CONFLICT',
        `补录批号 "${backfill_code}" 已使用且提交内容与首次不同：补录批号内容不可变更，请使用新的补录批号；` +
        '相同补录批号与相同内容的重试将返回原结果',
        [`首次提交记录数 ${existingBatch.record_count}，本次记录数 ${normalized.length}`]
      );
    }
    // 同内容（外部形态一致，或解析为档案 id 后一致）：幂等返回首次结果，不再次写入。
    // 注意 idempotent 放在 Object.assign 最后，避免被首次结果中持久化的 idempotent:false 覆盖。
    const stored = JSON.parse(existingBatch.result_json || '{}');
    return Object.assign({ backfill_code }, stored, { idempotent: true });
  }

  // 收集“外部记录号已在台账中”的集合（供解析阶段豁免其产出批次的“已存在”检查）。
  const knownExternalRefs = collectKnownExternalRefs(db, normalized);

  const resolvedRaw = resolveReferences(db, normalized, knownExternalRefs);
  const resolved = resolvedRaw.map(normalizeResolvedRecord);
  const packageHash = hashOf(canonicalString(resolved.map((r) =>
    recordCanonical(r, { withExternalRef: true }))));
  const externalHash = hashOf(canonicalString(
    normalized.map((r) => canonicalString(externalCanonicalRecord(r)))
  ));
  const reused = checkExternalRefs(db, resolved);

  let response;
  db.transaction(() => {
    // 事务内复查补录批号（better-sqlite3 同步串行，这里为同进程并发的显式兜底）。
    const dup = db.prepare('SELECT id, external_hash FROM backfill_batches WHERE backfill_code = ?')
      .get(backfill_code);
    if (dup) {
      if (dup.external_hash !== externalHash) {
        throw new BackfillError('BACKFILL_CODE_CONFLICT', `补录批号 "${backfill_code}" 已被另一内容的补录占用`);
      }
      throw new BackfillError('BACKFILL_CODE_CONFLICT', `补录批号 "${backfill_code}" 正在被提交，请稍后重试查询`);
    }

    const insBatch = db.prepare('INSERT INTO batches (code) VALUES (?)');
    const insEvent = db.prepare(
      'INSERT INTO events (event_time, type, equipment_id, batch_id, clean_allergens, note) VALUES (?,?,?,?,?,?)'
    );
    const insMatInput = db.prepare(
      'INSERT INTO process_inputs (event_id, material_id, material_lot_id) VALUES (?,?,?)'
    );
    const insBatchInput = db.prepare('INSERT INTO process_inputs (event_id, batch_id) VALUES (?,?)');

    // 新产出批次编码 -> batch_id（含包内新批次；库内既有批次与复用批次用既有 id）。
    const batchIdByCode = new Map(
      db.prepare('SELECT id, code FROM batches').all().map((b) => [b.code, b.id])
    );
    const eventIdByRef = new Map(); // external_ref -> event_id（含复用的既有事件）
    for (const [external_ref, ev] of reused.entries()) {
      eventIdByRef.set(external_ref, ev.id);
      if (ev.type === 'PROCESS' && ev.batch_id != null) {
        const b = db.prepare('SELECT code FROM batches WHERE id = ?').get(ev.batch_id);
        if (b) batchIdByCode.set(b.code, ev.batch_id);
      }
    }

    const insertedEvents = [];
    for (const rec of resolved) {
      if (reused.has(rec.external_ref)) continue; // 同号同内容：复用既有事件，不重复写入
      let batchId = null;
      if (rec.type === 'PROCESS') {
        if (!batchIdByCode.has(rec.batch_code)) {
          batchIdByCode.set(rec.batch_code, insBatch.run(rec.batch_code).lastInsertRowid);
        }
        batchId = batchIdByCode.get(rec.batch_code);
      }
      const eid = insEvent.run(
        rec.event_time, rec.type, rec.equipment_id, batchId,
        rec.type === 'CLEAN' && rec.clean_allergens
          ? JSON.stringify(rec.clean_allergens) : null,
        rec.note
      ).lastInsertRowid;
      if (rec.type === 'PROCESS') {
        for (const inp of rec.material_inputs) {
          insMatInput.run(eid, inp.material_id, inp.material_lot_id);
        }
        for (const code of rec.ref_batch_codes) {
          insBatchInput.run(eid, batchIdByCode.get(code));
        }
      }
      eventIdByRef.set(rec.external_ref, eid);
      insertedEvents.push({ external_ref: rec.external_ref, event_id: eid });
    }

    // 全量时间线校验：时间冲突、未来/同时刻引用、引用环、批次重复产出等。
    const errors = validateAll(db);
    if (errors.length) {
      throw new BackfillError('BACKFILL_REJECTED', '补录包应用后的时间线校验未通过（整包回滚，不留部分事件）', errors);
    }

    // 既有规则全量重算：设备残留、放行失效、标签卷停用、出货单待评估、处置结论需重评。
    const recomputeResult = recompute(db);

    const event_mapping = {};
    resolved.forEach((rec) => {
      event_mapping[rec.external_ref] = eventIdByRef.get(rec.external_ref);
    });
    const produced_batches = resolved
      .filter((r) => r.type === 'PROCESS' && !reused.has(r.external_ref))
      .map((r) => ({
        external_ref: r.external_ref,
        batch_code: r.batch_code,
        batch_id: batchIdByCode.get(r.batch_code),
        event_id: eventIdByRef.get(r.external_ref)
      }));

    const impact = {
      invalidated: recomputeResult.invalidated,
      retired_rolls: recomputeResult.retiredRolls,
      pending_shipments: recomputeResult.pendingShipments,
      stale_dispositions: recomputeResult.staleDispositions
    };
    const impact_summary = {
      inserted_events: insertedEvents.length,
      reused_events: reused.size,
      produced_batches: produced_batches.length,
      invalidated_releases: impact.invalidated.length,
      retired_label_rolls: impact.retired_rolls.length,
      pending_shipments: impact.pending_shipments.length,
      stale_dispositions: impact.stale_dispositions.length
    };

    // 落补录台账（先写包头，再逐条写记录）。
    const backfillId = db.prepare(
      `INSERT INTO backfill_batches
         (backfill_code, content_hash, external_hash, record_count, inserted_count,
          reused_count, result_json)
       VALUES (?,?,?,?,?,?,?)`
    ).run(
      backfill_code, packageHash, externalHash, resolved.length,
      insertedEvents.length, reused.size, '{}'
    ).lastInsertRowid;
    const insLedger = db.prepare(
      `INSERT INTO backfill_records
         (backfill_id, seq, external_ref, event_type, event_time, equipment_id,
          event_id, content_hash, canonical_json)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    for (const rec of resolved) {
      const canonical = recordCanonical(rec, { withExternalRef: false });
      insLedger.run(
        backfillId, rec.seq, rec.external_ref, rec.type, rec.event_time, rec.equipment_id,
        eventIdByRef.get(rec.external_ref), hashOf(canonical), canonical
      );
    }

    const storedResponse = {
      ok: true,
      backfill_id: backfillId,
      idempotent: false,
      record_count: resolved.length,
      events: insertedEvents,
      event_mapping,
      produced_batches,
      impact_summary,
      invalidated: impact.invalidated,
      retired_rolls: impact.retired_rolls,
      pending_shipments: impact.pending_shipments,
      stale_dispositions: impact.stale_dispositions
    };

    // 回填完整响应供同号重试原样返回。
    db.prepare('UPDATE backfill_batches SET result_json = ? WHERE id = ?')
      .run(JSON.stringify(storedResponse), backfillId);

    response = Object.assign({ backfill_code }, storedResponse);
  })();

  return response;
}

// ---------- 对账查询 ----------
// GET /api/backfills/:code：按补录批号查询对账结果（记录与当前时间线比对）。
function getBackfill(db, code) {
  const batch = db.prepare('SELECT * FROM backfill_batches WHERE backfill_code = ?').get(code);
  if (!batch) {
    throw new BackfillError('BACKFILL_NOT_FOUND', `补录批号 "${code}" 不存在`);
  }
  const ledger = db.prepare(
    'SELECT * FROM backfill_records WHERE backfill_id = ? ORDER BY seq'
  ).all(batch.id);

  const records = ledger.map((row) => {
    const stored = JSON.parse(row.canonical_json || '{}');
    const base = {
      seq: row.seq,
      external_ref: row.external_ref,
      event_id: row.event_id,
      type: row.event_type,
      event_time: row.event_time,
      equipment_id: row.equipment_id
    };
    if (row.event_type === 'CLEAN') {
      base.clean_allergens = stored.clean_allergens || null;
      base.clean_scope_full = stored.clean_allergens == null;
    } else {
      base.batch_code = stored.batch_code;
      base.material_inputs = (stored.material_inputs || []).map((x) => ({
        material_id: x.material_id,
        material_lot_id: x.material_lot_id,
        lot_known: x.material_lot_id != null
      }));
      base.ref_batch_codes = stored.ref_batch_codes || [];
    }
    base.note = stored.note || '';

    // 与当前时间线对账：事件仍在且内容一致=OK；已被单条接口更正=MISMATCH；已删除=DELETED。
    const ev = row.event_id == null ? null
      : db.prepare('SELECT * FROM events WHERE id = ?').get(row.event_id);
    if (!ev) {
      base.reconcile_status = 'DELETED';
      base.reconcile_detail = '补录事件已被删除（经既有单条事件接口）';
      return base;
    }
    const currentCanon = currentCanonical(db, ev);
    if (currentCanon === row.content_hash) {
      base.reconcile_status = 'OK';
      base.reconcile_detail = '事件仍在，内容与补录一致';
    } else {
      base.reconcile_status = 'MISMATCH';
      base.reconcile_detail = '事件已被更正，内容与补录时不同（以当前时间线为准）';
      base.differences = diffCanonical(stored, ev, db);
    }
    return base;
  });

  const counts = records.reduce((acc, r) => {
    acc[r.reconcile_status.toLowerCase()] = (acc[r.reconcile_status.toLowerCase()] || 0) + 1;
    return acc;
  }, {});

  return {
    backfill_code: batch.backfill_code,
    backfill_id: batch.id,
    status: counts.mismatch || counts.deleted ? 'HAS_DRIFT' : 'OK',
    created_at: batch.created_at,
    record_count: batch.record_count,
    inserted_count: batch.inserted_count,
    reused_count: batch.reused_count,
    reconcile_summary: {
      ok: counts.ok || 0,
      mismatch: counts.mismatch || 0,
      deleted: counts.deleted || 0
    },
    records,
    result: JSON.parse(batch.result_json || '{}')
  };
}

// 计算当前事件的规范化内容（与补录记录同一形状，不含 external_ref），返回内容哈希。
function currentCanonical(db, ev) {
  const rec = {
    seq: 0,
    type: ev.type,
    event_time: ev.event_time,
    equipment_id: ev.equipment_id,
    note: ev.note || ''
  };
  if (ev.type === 'CLEAN') {
    rec.clean_allergens = ev.clean_allergens ? JSON.parse(ev.clean_allergens) : null;
  } else {
    const b = db.prepare('SELECT code FROM batches WHERE id = ?').get(ev.batch_id);
    rec.batch_code = b ? b.code : null;
    rec.material_inputs = db.prepare(
      'SELECT material_id, material_lot_id FROM process_inputs WHERE event_id = ? AND material_id IS NOT NULL'
    ).all(ev.id).map((x) => ({ material_id: x.material_id, material_lot_id: x.material_lot_id }));
    rec.ref_batch_codes = db.prepare(
      `SELECT b.code AS code FROM process_inputs pi
         JOIN batches b ON b.id = pi.batch_id
        WHERE pi.event_id = ? AND pi.batch_id IS NOT NULL ORDER BY b.code`
    ).all(ev.id).map((x) => x.code);
  }
  return hashOf(recordCanonical(normalizeResolvedRecord(rec), { withExternalRef: false }));
}

// 字段级差异（对账展示用，尽力而为）。
function diffCanonical(stored, ev, db) {
  const diffs = [];
  if (stored.event_time !== ev.event_time) {
    diffs.push({ field: 'event_time', backfilled: stored.event_time, current: ev.event_time });
  }
  if (stored.equipment_id !== ev.equipment_id) {
    diffs.push({ field: 'equipment_id', backfilled: stored.equipment_id, current: ev.equipment_id });
  }
  if ((stored.note || '') !== (ev.note || '')) {
    diffs.push({ field: 'note', backfilled: stored.note || '', current: ev.note || '' });
  }
  if (ev.type === 'CLEAN') {
    const curScope = ev.clean_allergens ? JSON.parse(ev.clean_allergens) : null;
    const oldScope = stored.clean_allergens || null;
    if (JSON.stringify((curScope || []).slice().sort()) !==
        JSON.stringify((oldScope || []).slice().sort())) {
      diffs.push({ field: 'clean_allergens', backfilled: oldScope, current: curScope });
    }
  } else {
    if (stored.batch_code) {
      const b = db.prepare('SELECT code FROM batches WHERE id = ?').get(ev.batch_id);
      const curCode = b ? b.code : null;
      if (stored.batch_code !== curCode) {
        diffs.push({ field: 'batch_code', backfilled: stored.batch_code, current: curCode });
      }
    }
  }
  return diffs;
}

// 全部补录批号列表（对账用）。
function listBackfills(db) {
  const rows = db.prepare(
    `SELECT b.id, b.backfill_code, b.record_count, b.inserted_count, b.reused_count,
            b.content_hash, b.created_at,
            (SELECT COUNT(*) FROM backfill_records r WHERE r.backfill_id = b.id AND r.event_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id = r.event_id)) AS deleted_events
       FROM backfill_batches b ORDER BY b.id`
  ).all();
  return rows.map((r) => ({
    backfill_id: r.id,
    backfill_code: r.backfill_code,
    record_count: r.record_count,
    inserted_count: r.inserted_count,
    reused_count: r.reused_count,
    deleted_events: r.deleted_events,
    created_at: r.created_at
  }));
}

module.exports = {
  BackfillError,
  submitBackfill,
  getBackfill,
  listBackfills
};
