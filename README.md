# 食品加工换线 · 过敏原追踪与放行系统

本地运行的食品加工过敏原追溯网页：录入**原料过敏原、设备、按时间排序的加工事件与已核实清洗事件**，
系统按时间顺序推导每个产出批次的过敏原集合及来源路径，管理设备残留，支持按**当时推导结果**登记批次放行，
并在**包装前按批次 + 有效放行登记过敏原标签卷**（按修订号核销贴用/作废，集合或放行变化时永久停用），
**包装出货时按批次把已贴用标签卷分配给出货单**（整单事务校验，卷停用时相关已出货单转待评估、不自动恢复），
**待评估出货单由质检按整单登记“准予继续流转/召回”处置**（凭查询状态版本事务核对，记录只增不改；
此后过敏原/有效放行/停卷信息变化时旧结论保留并标需重新评估、不自动生效）。
供应商通报某**原料供应批号**异常时，质检可按“原料 + 供应批号”做**流向追溯**：
每次加工的原料输入可登记所属批号（同原料一次加工可用多个批号；旧事件与只传 `material_ids`
的写入仍完全可用，其输入记为**批号未知**）；追溯沿直接投料、前序批次引用、同设备残留
逐时传播，**全清截断全部设备残留；部分清洗按来源原料的过敏原逐项截断**（尚有未清除过敏原
或原料无过敏原登记时不能排除批号，只有全清截断）；结果分**确定命中**与**因批号未知无法排除**
两类并给出传播依据与关联出货单，事件更正/删除后按最新合法时间线更新。**追溯仅供查询，不自动改变放行、卷、出货与处置结论。**
设备断网期间的加工/清洗日志可用**补录批号整包补录**（整包事务、同号同内容幂等、外部记录号复用、按批号对账）。
**设备检修停机窗口**按设备登记/调整/取消（起止时间、原因、操作人；左闭右开、同设备不重叠、相邻允许）：
**检修期间不能记录加工或清洗**——登记/调整窗口覆盖已有事件、或在窗口内新增/更正事件、断网补录、
换线预演与确认，均按最终设备和时间核对并整次拒绝；**停机不等于清洗**，不改变设备残留或过敏原推导。

- 后端：Node.js + Express
- 数据库：SQLite（[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)，数据文件本地保存）
- 前端：浏览器单页应用（原生 HTML/CSS/JS，无需构建）

## 功能与规则

### 推导规则

- **批次产出过敏原** = 全部原料输入过敏原 ∪ 引用的此前批次产出 ∪ **设备当前残留**，并集计算。
- **设备残留更新**：每次加工后，该设备残留更新为本次产出的过敏原集合；新鲜来源路径会追加“设备残留”标记，
  已在残留中的路径原样保留（可追溯残留自哪次加工带入）。
- **已核实清洗**（CLEAN 事件）记录本次**已核实去除的过敏原集合**：
  - **省略清洗范围**（不传 `clean_allergens`，既有 CLEAN 事件与旧请求均如此）= **全清**，
    清空该设备的全部残留；
  - **部分清洗**：`clean_allergens` 传非空过敏原名称数组，只清除这些过敏原的设备残留**及其来源路径**，
    其余过敏原残留原样保留，继续并入该设备上清洗之后的每次加工。
  - **显式空集、非字符串或空白名称一律拒绝**（`400`）；重复名称按一个处理。
- 每个批次的每个过敏原都展示**来源路径链**，例如：
  `原料:全脂奶粉(MILK-01) → 批次引用:BATCH-002 → 设备残留:LINE-A`
- 更正/删除早期事件（含清洗范围变更）后，系统**全量重算**所有受影响的后续批次与设备残留，
  并按既有规则联动放行失效、标签卷永久停用、出货单待评估与处置结论“需重新评估”。

### 放行

- 放行以登记时刻的过敏原集合作为**快照**保存。
- 早期事件更正后重算：某条放行登记时的集合与新结果**不同**，该放行自动置为**已失效**，
  页面红色标注并给出具体原因（新增了哪些过敏原 / 移除了哪些过敏原）；失效为终态，需重新登记放行。
- 集合相同则放行保持有效。

### 提交约束（整次提交事务化，违反任意一条则整单回滚拒绝）

- 加工只能引用**产出时间严格更早**的批次——引用未来批次被拒绝。
- 批次引用关系**形成循环**被拒绝。
- **同一设备同一时刻**存在多条事件（时间冲突）被拒绝。
- 同一批次不能被两次加工产出。

### 部分清洗（CLEAN 事件携带已核实去除过敏原集合）

CLEAN 事件可记录本次**已核实去除的过敏原集合**（字段 `clean_allergens`），支持“只清指定过敏原”的部分清洗：

- **省略该字段或传 `null` = 全清**：既有 CLEAN 事件与旧请求的语义完全不变（清空该设备全部残留）；旧库自动补列，历史清洗一律为全清。
- **传非空数组 = 部分清洗**：只清除所列过敏原的设备残留及其来源路径；其余过敏原残留继续进入后续批次。数组顺序不敏感，**重复名称按一个处理**。
- **显式空集 `[]`、任一名称为非字符串或纯空白一律拒绝**（`400 INVALID_REQUEST`）；加工事件（PROCESS）携带该字段同样拒绝。
- 更正/删除早期清洗（全清↔部分清洗、范围调整、时间移动）后沿时间线**全量重算**，并按既有规则联动
  **放行失效、标签卷永久停用、出货单待评估、质量处置结论需重新评估**。
- **清洗不抹去已发生的直接投料和批次引用**：部分/全清只作用于“同设备残留”这一传播途径。
- **供应批号追溯按来源原料涉及的过敏原保留设备传播**：
  - 部分清洗只清除“**来源原料的全部已登记过敏原均已被去除**”的批号设备传播；
    **尚有任一未清除过敏原时，不能排除该批号或批号未知的流向**；多次部分清洗按过敏原逐次截断（如先去“乳”再去“大豆”，两次之后才截断同时携带乳/大豆的批号残留）；
  - **来源原料未登记过敏原时**（如食用盐），部分清洗无法据此排除批号，**只有全清截断设备传播**。

### HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/events` / `PUT /api/events/:id` | CLEAN 事件新增/全量更正，新增可选 `clean_allergens:["花生","乳"]`；省略=`null` 即全清；非法形态 400 拒绝。响应形状不变（仍含 `invalidated`/`retired_rolls`/`pending_shipments`/`stale_dispositions`） |
| `POST /api/replan/preview`、`POST /api/replan/apply` | `update` CLEAN 变更与 `insert_clean` 均支持同一 `clean_allergens` 形态；预演差异 `equipment_residue[]` 另含 `before/after_last_clean_allergens`（变化依据） |
| `GET /api/state` | CLEAN 事件另含 `clean_allergens`（`null`=全清）、`clean_scope_full`、`clean_partial`、`post_clean_residue`（**清洗后残留**）；设备另含 `last_clean_allergens`/`last_clean_partial`（最近一次清洗范围） |

CLEAN 请求体示例：

```json
// 部分清洗：仅核实去除“花生”（设备上其它过敏原残留保留并继续传播）
{ "type": "CLEAN", "event_time": "2026-10-01T09:00",
  "equipment_id": 2, "note": "换线间局部清洗：花生工位",
  "clean_allergens": ["花生"] }

// 全清（旧请求原样可用）：省略 clean_allergens
{ "type": "CLEAN", "event_time": "2026-10-01T15:00", "equipment_id": 2, "note": "班后 CIP" }
```

#### 调用示例（curl）

```bash
# 1) 部分清洗（只去花生；重复名去重）
curl -s -X POST http://localhost:3000/api/events \
  -H 'Content-Type: application/json' -d '{
    "type":"CLEAN","event_time":"2026-10-01T09:00","equipment_id":2,
    "note":"局部清洗","clean_allergens":["花生","花生"]
  }'
# -> { id:..., invalidated:[...], retired_rolls:[...], pending_shipments:[...], stale_dispositions:[...] }

# 2) 非法形态均拒绝（400）
curl -s -X POST http://localhost:3000/api/events -H 'Content-Type: application/json' \
  -d '{"type":"CLEAN","event_time":"2026-10-01T09:00","equipment_id":2,"clean_allergens":[]}'
# -> { error:"清洗范围不能为空数组：显式空集表示本次未去除任何过敏原，…" }

# 3) 页面/程序读取清洗范围、清洗后残留与变化依据
curl -s http://localhost:3000/api/state | node -e 'let d="";process.stdin.on("data",c=>d+=c)
  .on("end",()=>{for(const e of JSON.parse(d).events.filter(e=>e.type==="CLEAN"))
    console.log(e.event_time, e.clean_partial ? "部分清洗 "+e.clean_allergens.join("/") : "全清",
                "清洗后残留:", e.post_clean_residue);})'

# 4) 整组换线预演：把一次全清更正为部分清洗（差异含 before/after_last_clean_allergens）
curl -s -X POST http://localhost:3000/api/replan/preview \
  -H 'Content-Type: application/json' -d '{
    "changes": [
      {"op":"update","event_id":7,"type":"CLEAN","event_time":"2026-09-30T13:00",
       "equipment_id":2,"note":"改部分清洗","clean_allergens":["花生"]}
    ]
  }'
# -> diff.equipment_residue:[{ equipment_code:"FRYER-B",
#      before_allergens:[], after_allergens:["大豆","含麸质的谷物"], added:[...],
#      before_last_cleaned_at:"2026-09-30T13:00", after_last_cleaned_at:"2026-09-30T13:00",
#      before_last_clean_allergens:null, after_last_clean_allergens:["花生"] }]
# 确认应用仍须原样回传 version 与同一份 changes（版本校验、CHANGES_MISMATCH/VERSION_EXPIRED 语义不变）。
```

| 场景 | HTTP | `code` |
| --- | --- | --- |
| 显式空集、非数组、名称非字符串或空白、PROCESS 携带清洗范围 | 400 | `INVALID_REQUEST` |
| 整组预演/确认中清洗范围非法 | 400 | `INVALID_REQUEST` / `REPLAN_REJECTED` |
| 其余事件/版本错误 | 沿用原语义 | （与既有事件、换线接口一致） |

## 换线整组预演与确认应用（本轮新增）

车间调整加工顺序时，可**一次提交多条既有事件的更正（PROCESS/CLEAN）与拟插入的清洗事件**：

- `POST /api/replan/preview` 在**内存影子库**上应用整组变更，按整组变更后的时间线
  全量校验（引用先后、引用环、设备时间冲突、批次唯一产出）并重算，返回应用前后
  **每批过敏原、设备残留、将失效的放行记录**差异；**不修改正式事件、推导结果或放行状态**。
- **单条更正单独看暂时冲突、但整组最终合法时仍可预演**（例如交换两个事件的时间）。
- 预演返回业务版本 `version`（签名令牌，30 分钟有效；服务重启后旧版本作废）。
- `POST /api/replan/apply` 确认应用：**必须携带预演版本及与预演完全相同的 changes**，
  在**一次事务**中重新校验版本、重新做全量校验并重算落库。
- **预演后任何会影响这些结果的正式写入**（新增/更正/删除事件、改原料过敏原、登记/删除放行等）
  **均使该版本过期**：应用返回 `409 VERSION_EXPIRED` 且**原状态不变**，需重新预演。
- 以下情况在预演阶段即明确拒绝（HTTP 400，`details` 给出逐条中文原因，预演失败可见原因）：
  未知事件、同一事件被重复更正、设备不存在、拟插入的清洗事件缺少时间、
  整组后时间线非法（未来引用 / 引用环 / 时间冲突 / 批次重复产出）等。

> 既有单条事件接口（`POST/PUT/DELETE /api/events/...`）与放行接口（`/api/releases`）
> 的语义完全保持不变；新接口只做“整组预演 + 确认应用”。

#### 变更项格式（`changes` 数组，顺序无关）

更正既有事件（字段与单条 `PUT /api/events/:id` 相同，必须带 `type`；加工事件为全量覆盖输入/引用）：

```json
{
  "op": "update",
  "event_id": 1,
  "type": "PROCESS",
  "event_time": "2026-09-30T09:00",
  "equipment_id": 1,
  "note": "早班面团（改到清洗后）",
  "batch_code": "BATCH-001",
  "material_ids": [1, 7],
  "ref_batch_ids": []
}
```

拟插入的清洗事件（`client_key` 可选，便于多条时对应预演返回的新事件 id）：

```json
{ "op": "insert_clean", "client_key": "mid-wash", "event_time": "2026-09-30T09:30",
  "equipment_id": 1, "note": "换线中间追加一次已核实清洗" }
```

#### 调用示例（curl，基于演示数据）

```bash
# 1) 预演：交换 LINE-A 上 BATCH-001(08:00) 与清洗(09:00) 的时间
curl -s -X POST http://localhost:3000/api/replan/preview \
  -H 'Content-Type: application/json' -d '{
    "changes": [
      {"op":"update","event_id":1,"type":"PROCESS","event_time":"2026-09-30T09:00",
       "equipment_id":1,"note":"早班面团","batch_code":"BATCH-001",
       "material_ids":[1,7],"ref_batch_ids":[]},
      {"op":"update","event_id":2,"type":"CLEAN","event_time":"2026-09-30T08:00",
       "equipment_id":1,"note":"换线前已核实清洗"}
    ]
  }'
# -> { ok:true, phase:"PREVIEW", version:"<业务版本令牌>", business_version:"...",
#      changes:[...规范化回显...], inserted_clean_events:[],
#      diff:{ summary:{ batches_changed, equipment_residue_changed,
#                       releases_will_invalidate, releases_changed },
#             batches:[{batch_id,code,produced_at,
#                       before_allergens,after_allergens,added,removed}],
#             equipment_residue:[{equipment_id,equipment_code,
#                       before_allergens,after_allergens,added,removed,
#                       before_last_cleaned_at,after_last_cleaned_at}],
#             releases:[{release_id,batch_code,before_status,after_status:"INVALIDATED",
#                       after_invalid_reason,...}] } }

# 2) 确认应用：原样回传 version 与同一份 changes（事务内重新校验+重算）
curl -s -X POST http://localhost:3000/api/replan/apply \
  -H 'Content-Type: application/json' -d '{
    "version": "<上一步返回的 version>",
    "changes": [ ...与预演完全相同的内容... ]
  }'
# -> { ok:true, phase:"APPLIED", applied_version, business_version,
#      inserted_clean_events:[{client_key,event_id}], invalidated:[...],
#      diff:{ ...与预演同结构的实际落库差异... } }
```

预演失败示例（整组后时间线非法，HTTP 400）：

```json
{ "error": "整组变更应用后的时间线校验未通过",
  "code": "REPLAN_REJECTED",
  "details": ["事件 #3（2026-09-30T11:30）引用了未来或同时刻批次 #4（产出时间 2026-09-30T11:00），不允许引用未来批次"] }
```

| 场景 | HTTP | `code` |
| --- | --- | --- |
| 请求体/变更内容问题（非数组、缺时间、未知事件、重复更正、设备不存在…） | 400 | `INVALID_REQUEST` / `REPLAN_REJECTED` |
| 整组后时间线校验失败（未来引用/环/时间冲突/批次重复产出） | 400 | `REPLAN_REJECTED` |
| 版本签名损坏或格式非法 | 400 | `VERSION_INVALID` |
| apply 的 changes 与预演不一致 | 409 | `CHANGES_MISMATCH` |
| 预演后正式数据已变更导致版本过期（含重复应用同一版本、版本过期） | 409 | `VERSION_EXPIRED` |

## 过敏原标签卷（包装前登记 → 核销贴用/作废）

包装前，按**现有批次**与其**有效放行记录**登记一卷过敏原标签：

- 登记必须录入**拟印过敏原集合**、**正整数印量（张）**与**操作人**；
  拟印集合必须与①该批次**当前推导结果**、②所选**放行快照****完全一致**（三方一致，顺序/重复不敏感），
  否则整次拒绝。登记成功返回**卷号**（`LABEL-0001` 起）与**可用张数**。
- 每卷凭**预期修订号**（`expected_revision`，登记时为 0，每次核销 +1）核销**贴用**与**作废**张数；
  累计贴用 + 作废不得超过印量。**旧修订号、负数、超量均整次拒绝**（事务回滚，修订号不前进）。
- **永久停用（终态）**：原料或加工事件变更、整组换线确认应用使该批次集合改变，
  或绑定的放行记录失效、被删除时，该卷立即永久停用——
  **余量不可再贴，已贴数量标记“待复核”**；即使过敏原集合后来恢复一致，**也不会自动解冻**，
  需在新的有效放行下登记新卷。
- “过敏原标签卷”页按**批次分组**显示每卷的**印量、贴用、作废、剩余**及**停用原因**；
  批次卡片上也有该批标签卷数量摘要，可一键跳转。
- 整组预演返回的 `diff.label_rolls_will_retire` 会列出应用后**将被永久停用**的卷（含待复核张数），
  预演本身不停用任何正式卷；确认应用的响应 `retired_rolls` 为实际停用的卷。

### HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/label-rolls` | 登记一卷（三方一致校验），返回卷对象（含 `roll_code`、`remaining_qty`） |
| `POST /api/label-rolls/:id/consume` | 按预期修订号核销贴用/作废，返回更新后的卷对象（含新 `revision`） |
| `GET /api/state` | 顶层含 `label_rolls` 数组（既有字段不变），按批次含卷号/印量/贴用/作废/剩余/修订号/状态/停用原因；每项另含 `allocated_qty`/`shippable_qty`，顶层另含 `shipments`（见下节） |
| `DELETE /api/releases/:id` | 语义不变（仍返回 `ok:true`），另附 `retired_rolls`：其名下有效卷被永久停用 |
| 事件 `POST/PUT/DELETE`、原料 `PUT` | 响应形状不变，另附 `retired_rolls`（本次重算导致停用的卷） |

登记请求体：

```json
{ "batch_id": 3, "release_id": 1,
  "allergens": ["乳", "蛋", "芝麻"],
  "print_qty": 500,
  "registered_by": "包装组长-李雷",
  "registered_at": "2026-09-30T12:10" }
```

核销请求体（`applied`/`voided` 也可写作 `used`/`void_qty`；`expected_revision` 必传）：

```json
{ "expected_revision": 0, "applied": 100, "voided": 3,
  "used_by": "包装工-赵强", "used_at": "2026-09-30T13:05" }
```

#### 调用示例（curl，基于演示数据；演示库自带 BATCH-003 的一卷 LABEL-0001：印 500 / 贴 120 / 作废 5 / 剩 375）

```bash
# 1) 登记一卷：集合必须同时等于当前推导与放行快照
curl -s -X POST http://localhost:3000/api/label-rolls \
  -H 'Content-Type: application/json' -d '{
    "batch_id": 3, "release_id": 1,
    "allergens": ["乳","蛋","芝麻"],
    "print_qty": 500, "registered_by": "包装组长-李雷"
  }'
# -> { id:2, roll_code:"LABEL-0002", print_qty:500, applied_qty:0, void_qty:0,
#      remaining_qty:500, revision:0, status:"ACTIVE", active:true, ... }

# 2) 按修订号 0 核销 100 贴用 + 3 作废 -> 剩 397，修订号前进到 1
curl -s -X POST http://localhost:3000/api/label-rolls/2/consume \
  -H 'Content-Type: application/json' \
  -d '{"expected_revision":0,"applied":100,"voided":3,"used_by":"赵强"}'

# 3) 再用旧修订号 0 核销 -> 409 REVISION_MISMATCH，整次拒绝、数量不变
curl -s -X POST http://localhost:3000/api/label-rolls/2/consume \
  -H 'Content-Type: application/json' -d '{"expected_revision":0,"applied":5,"voided":0}'
# -> { error:"修订号已过期：卷当前修订号为 1，提交的预期修订号为 0；整次拒绝",
#      code:"REVISION_MISMATCH" }

# 4) 负数 / 超量 -> 400 INVALID_REQUEST / 409 OVER_LIMIT
curl -s -X POST http://localhost:3000/api/label-rolls/2/consume \
  -H 'Content-Type: application/json' -d '{"expected_revision":1,"applied":-1,"voided":0}'
curl -s -X POST http://localhost:3000/api/label-rolls/2/consume \
  -H 'Content-Type: application/json' -d '{"expected_revision":1,"applied":99999,"voided":0}'

# 5) 集合改变 / 放行失效后：卷 RETIRED，余量冻结、已贴待复核，再核销 -> 409 ROLL_RETIRED
#    （例如到“事件时间线”给 BATCH-002 加入花生原料，BATCH-003 推导集合变化）
curl -s http://localhost:3000/api/state | node -e 'let d="";process.stdin.on("data",c=>d+=c)
  .on("end",()=>{for(const r of JSON.parse(d).label_rolls)
    console.log(r.batch_code,r.roll_code,r.status,r.print_qty,r.applied_qty,r.void_qty,
      r.remaining_qty,r.retired_reason);})'

# 6) 删除放行 -> 其名下有效卷立即永久停用（响应附 retired_rolls）
curl -s -X DELETE http://localhost:3000/api/releases/1
```

| 场景 | HTTP | `code` |
| --- | --- | --- |
| 拟印集合与当前推导/放行快照不一致、印量非正整数、批次或放行缺失、放行不属于该批次、放行已失效 | 400 | `ALLERGENS_MISMATCH` / `INVALID_REQUEST` / `BATCH_NOT_FOUND` / `BATCH_NOT_PRODUCED` / `RELEASE_NOT_FOUND` / `RELEASE_BATCH_MISMATCH` / `RELEASE_INACTIVE` |
| 核销：旧修订号 / 累计超印量 / 卷已停用 | 409 | `REVISION_MISMATCH` / `OVER_LIMIT` / `ROLL_RETIRED` |
| 核销：负数、全零、缺少修订号、卷号不合法 | 400 | `INVALID_REQUEST` |
| 核销不存在的卷 | 404 | `ROLL_NOT_FOUND` |

## 包装出货（按批次把已贴用标签分配给出货单）

包装出货时，按**批次**把若干**已贴用标签卷**的张数一次性分配给一张出货单：

- 出货确认必须录入：**批次**、**正整数出货量（张）**、**各卷分配张数**与**操作人**（出货时间可选，默认当前）。
- 每个被分配的卷必须同时满足：
  1. **属于该批次**；
  2. **未停用**（仍为 `ACTIVE`，未因集合改变 / 放行失效或删除而永久停用）；
  3. **绑定有效放行**（其放行记录仍存在且为 `ACTIVE`）。
- 各卷分配张数之和**必须恰好等于出货量**；每卷**累计已分配数 + 本次分配不得超过该卷已贴用数**（作废张数不算贴用）。
- **任一条件不满足，整单拒绝并事务回滚、不占用任何数量**（哪怕其中一卷合法，另一卷超量也全部回滚）。
- 成功返回**出货单号**（`SHIP-0001` 起）与**状态**（`SHIPPED` 已出货）；
  每条分配明细都保存出货**当时的放行标识（release_id 及放行时间/人快照）、过敏原集合、卷号与修订号**。
- **出货记录不可因后续更正消失**：批次行被连带删除时单据保留（批次置空、编码快照保留）；
  放行被删除时，明细里的放行标识与放行快照仍保留。
- **待评估（终态，不自动恢复）**：原料或事件变更、整组换线确认应用、或放行删除导致某卷停用时，
  **分配过该卷的已出货单全部标记为 `PENDING_REVIEW`（待评估）并显示逐卷原因**；
  即使过敏原集合后来恢复一致，单据**也不会自动恢复**为已出货（需线下质量评估，系统不提供自动回改）。
- 卷停用后，其**尚未分配的已贴张数也不得再出货**（出货只接受 `ACTIVE` 卷，余额查询中停卷可出货恒为 0）。
- 可查询**批次可出货余额**（该批所有未停用卷的「已贴用 − 累计已分配」之和）与**出货单状态/明细**。
- 已出货/待评估单据占用的分配数量始终计入「累计已分配」，不会因单据转待评估而退回重复使用。

### HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/shipments` | 出货确认（整单事务化），返回出货单（含 `shipment_code`、`status`、各卷快照 `items`） |
| `GET /api/shipments` | 出货单列表，可按 `?batch_id=`、`?status=SHIPPED|PENDING_REVIEW` 过滤 |
| `GET /api/shipments/:idOrCode` | 单张出货单（数字 id 或 `SHIP-0001` 单号），含状态、原因与明细快照 |
| `GET /api/batches/:id/shipment-balance` | 单个批次可出货余额（逐卷列出 印量/已贴/作废/已分配/可出） |
| `GET /api/shipment-balances` | 全部批次可出货余额 |
| `GET /api/state` | 顶层新增 `shipments` 数组；`label_rolls` 每项另含 `allocated_qty`（累计已分配）与 `shippable_qty`（可出货余额） |
| 事件 `POST/PUT/DELETE`、原料 `PUT`、换线 `apply`、放行 `DELETE` | 响应形状不变，另附 `pending_shipments`（本次新转入待评估的出货单） |
| 换线 `preview` 的 `diff` | 另含 `shipments_will_pending`（应用后将转待评估的出货单）与 `summary.shipments_will_pending` |

出货请求体：

```json
{ "batch_id": 3, "ship_qty": 120, "shipped_by": "仓管-周杰",
  "shipped_at": "2026-09-30T14:20",
  "allocations": [
    { "roll_id": 1, "qty": 100 },
    { "roll_id": 2, "qty": 20 }
  ] }
```

`items[]` 明细快照字段：`roll_id` / `roll_code`（当时卷号）、`release_id`（当时放行标识）、
`release_at` / `release_by`（放行快照）、`allergens`（当时过敏原集合）、
`roll_revision`（当时卷修订号）、`qty`（本卷分配张数）。

#### 调用示例（curl，基于演示数据）

演示库自带 `BATCH-003` 的一卷 `LABEL-0001`：印 500 / 贴 120 / 作废 5 / 剩 375，
以及一张演示出货单 `SHIP-0001`（从该卷分配 100 张，修订号 2）。因此该卷**可出货余额 = 120 − 100 = 20**。

```bash
# 1) 查询批次可出货余额（逐卷：已贴/已分配/可出）
curl -s http://localhost:3000/api/batches/3/shipment-balance
# -> { batch_id:3, batch_code:"BATCH-003", shippable_qty:20,
#      applied_qty:120, allocated_qty:100,
#      rolls:[{ roll_code:"LABEL-0001", status:"ACTIVE",
#               applied_qty:120, allocated_qty:100, available_qty:20, ... }] }

# 2) 出货确认：把剩余 20 张分配给一张出货单（整单事务）
curl -s -X POST http://localhost:3000/api/shipments \
  -H 'Content-Type: application/json' -d '{
    "batch_id": 3, "ship_qty": 20, "shipped_by": "仓管-周杰",
    "allocations": [ { "roll_id": 1, "qty": 20 } ]
  }'
# -> { shipment_code:"SHIP-0002", status:"SHIPPED", ship_qty:20, allocated_qty:20,
#      allergens:["蛋","乳","芝麻"],
#      items:[{ roll_code:"LABEL-0001", release_id:1,
#               release_at:"2026-09-30T11:30", release_by:"质检员-王敏",
#               allergens:["蛋","乳","芝麻"], roll_revision:2, qty:20 }] }

# 3) 余额已为 0，再分配 → 409 OVER_APPLIED，整单拒绝、不占用
curl -s -X POST http://localhost:3000/api/shipments \
  -H 'Content-Type: application/json' -d '{
    "batch_id": 3, "ship_qty": 1, "shipped_by": "仓管-周杰",
    "allocations": [ { "roll_id": 1, "qty": 1 } ]
  }'
# -> { error:"卷 LABEL-0001 可出货（已贴用）120 张，此前累计已分配 120 张，本次再分配 1 张后为 121 张，超过已贴用数；整单拒绝、不占用数量",
#      code:"OVER_APPLIED" }

# 4) 各卷之和 ≠ 出货量 → 400 ALLOCATION_MISMATCH（同样不占用）
curl -s -X POST http://localhost:3000/api/shipments \
  -H 'Content-Type: application/json' -d '{
    "batch_id": 3, "ship_qty": 21, "shipped_by": "周杰",
    "allocations": [ { "roll_id": 1, "qty": 20 } ]
  }'

# 5) 查询出货单状态：按单号 / 按状态 / 按批次
curl -s http://localhost:3000/api/shipments/SHIP-0001
curl -s 'http://localhost:3000/api/shipments?status=PENDING_REVIEW'
curl -s 'http://localhost:3000/api/shipments?batch_id=3'

# 6) 原料/事件变更或删除放行导致卷停用后：相关已出货单 PENDING_REVIEW（不自动恢复）
#    例如到“事件时间线”给 BATCH-002 加入花生原料（经设备残留/引用传播到 BATCH-003），
#    事件更正响应会附 pending_shipments；再查 SHIP-0001：
curl -s http://localhost:3000/api/shipments/SHIP-0001
# -> { status:"PENDING_REVIEW", pending_review:true,
#      review_reason:"出货所用标签卷已停用，相关已出货标签需质量评估：卷 LABEL-0001：批次过敏原集合已改变（新增：花生）…",
#      items:[ ...快照仍在... ] }
# 该卷尚未分配的已贴张数此时余额为 0，不可再出货；撤销改动集合恢复后单据仍为 PENDING_REVIEW。
```

| 场景 | HTTP | `code` |
| --- | --- | --- |
| 缺批次 / 出货量或分配张数非正整数 / 缺操作人 / 空分配 / 同一卷重复分配 / 出货时间格式错 | 400 | `INVALID_REQUEST` |
| 批次不存在（出货 / 余额查询） | 400 | `BATCH_NOT_FOUND` |
| 卷不属于该批次 | 400 | `ROLL_BATCH_MISMATCH` |
| 各卷分配之和 ≠ 出货量 | 400 | `ALLOCATION_MISMATCH` |
| 卷已停用（含其未分配已贴张数再出货） | 409 | `ROLL_RETIRED` |
| 卷绑定的放行已失效 / 已删除 | 409 | `RELEASE_INACTIVE` |
| 某卷累计已分配将超过已贴用数 | 409 | `OVER_APPLIED` |
| 被分配的卷不存在 | 404 | `ROLL_NOT_FOUND` |
| 出货单不存在（按 id / 单号查询） | 404 | `SHIPMENT_NOT_FOUND` |
| 列表 `status` 取值非法 | 400 | `INVALID_REQUEST` |

## 待评估出货单的质量处置（整单结论，本轮新增）

已转为**待评估（PENDING_REVIEW）**的出货单，质检人员按**整单**登记处置结论：
**准予继续流转（CONTINUE）**或**召回（RECALL）**。

- 提交必须录入：**处置结论**、**操作人**、**依据**，以及**查询评估视图时取得的状态版本**（处置时间可选，默认当前）。
- 评估查询同时呈现：
  - **出货当时**：过敏原集合、**逐卷分配明细与放行快照**（卷号/修订号/放行标识/放行人/时间）；
  - **当前**：批次过敏原、**当前有效放行**列表、**所用各卷当前状态与停用原因**；
  - **准予条件判定**：三条条件逐项 ✓/✗ 及未覆盖的过敏原。
- **准予继续流转仅在三条同时成立时允许**：① 批次仍存在且可重新推导；② 当前有有效放行；
  ③ **出货快照覆盖当前过敏原**（当前集合是出货声明集合的子集，未声明项会逐条列出）。任一不满足，只能**召回**。
- 提交在**一次事务**内重新核对：版本签名与有效期、该单**最新状态版本**、**最新上下文指纹**
  （批次过敏原/有效放行/所用卷停用）。过期或查询后已被改动 → `409 VERSION_EXPIRED`，**拒绝且不产生记录**。
- **记录只增不改**：同一单已有**有效（ACTIVE）结论**时重复提交一律拒绝
  （`409 DISPOSITION_EXISTS`，**用旧版本也不能覆盖新结论**）；处置行从不修改结论内容。
- 此后**批次过敏原、有效放行或所用卷停用信息变化**时（事件/原料更正、整组换线确认应用、放行新增或删除），
  系统把仍为 ACTIVE 的旧结论标为 **STALE（需重新评估）**并给出具体原因：
  **旧结论与依据原样保留、不自动生效**，需重新查询、重新登记；STALE 后允许提交新结论（新记录另增一行）。
- 处置**不改变**出货单原状态（仍是待评估，不自动恢复为已出货）、**不退回数量占用**，停卷/余额规则保持不变。
- 页面“包装出货”页对待评估单显示当前结论徽标（准予/召回/**需重新评估**），
  点开可查看快照对比、条件判定、提交处置并浏览**当前结论与历史**。

### 状态版本（乐观并发）

- 状态版本为**每单单调递增整数**（出货时 0；转待评估 +1；每次登记处置 +1），
  评估视图同时返回一枚 **HMAC 签名令牌**（30 分钟有效；**服务重启后旧令牌作废**）与短码 `context_version`。
- 查询后若该单状态版本被推进（他人先处置、单据新转待评估）或上下文指纹变化，
  旧令牌提交即拒绝；处置成功后旧令牌立即失效。

### HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/shipments/:idOrCode/evaluation` | 评估视图：出货快照、当前状态、三条件判定、签名状态版本、当前结论与历史 |
| `POST /api/shipments/:idOrCode/dispositions` | 提交整单处置（事务内核版本与条件；过期不产生记录；只增不改） |
| `GET /api/shipments/:idOrCode`、`GET /api/shipments`、`GET /api/state` | 字段形状不变，出货单另附 `current_disposition`（当前结论摘要）与 `disposition_count` |
| 事件 `POST/PUT/DELETE`、原料 `PUT`、放行 `POST/DELETE`、换线 `apply` | 响应形状不变，另附 `stale_dispositions`（本次被标为需重新评估的结论） |
| 换线 `preview` 的 `diff` | 另含 `dispositions_will_stale`（应用后将需重评的结论）与 `summary.dispositions_will_stale` |

处置请求体：

```json
{ "decision": "CONTINUE", "decided_by": "质检员-陈静",
  "basis": "核实为误投料，现场复检过敏原为蛋/乳/芝麻，新放行 #2 有效，准予继续流转",
  "version": "<GET evaluation 返回的 version 令牌>",
  "decided_at": "2026-10-01T09:00" }
```

`decision` 取值：`CONTINUE`（准予继续流转）/ `RECALL`（召回，大写；时间可省略）。

#### 调用示例（curl，基于演示数据）

演示库的 `SHIP-0001` 为已出货状态；先让其转待评估（给 `BATCH-002` 加入花生原料，
`BATCH-003` 新增“花生”、原放行失效、`LABEL-0001` 停用，出货单转待评估），再评估：

```bash
# 1) 查询评估视图：取得状态版本、看三条件与所用卷停用原因
curl -s http://localhost:3000/api/shipments/SHIP-0001/evaluation
# -> { shipment:{...}, review:{pending_review:true, review_reason:"..."},
#      shipment_snapshot:{ allergens:["蛋","乳","芝麻"], items:[{roll_code:"LABEL-0001",
#          roll_revision:2, release_id:1, release_at, release_by, qty:100, ...}] },
#      current_state:{ batch_exists:true, batch_code:"BATCH-003",
#          batch_allergens:["蛋","花生","乳","芝麻"], active_releases:[],
#          used_rolls:[{roll_code:"LABEL-0001", status:"RETIRED",
#                       retired_reason:"绑定放行已失效：…（新增：花生）…",
#                       release_exists:true, release_active:false}] },
#      conditions:{ batch_exists:true, has_active_release:false,
#          snapshot_covers_current:false, uncovered_allergens:["花生"],
#          can_continue:false, only_recall:true, blockers:[...] },
#      status_version:1, context_version:"8a2ca8bc70ee", version:"<签名令牌>",
#      current_disposition:null, history:[] }

# 2) 条件不满足时尝试 CONTINUE → 409 CONTINUE_NOT_ALLOWED（details 逐条中文原因）
VER=$(curl -s http://localhost:3000/api/shipments/SHIP-0001/evaluation \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).version')
curl -s -X POST http://localhost:3000/api/shipments/SHIP-0001/dispositions \
  -H 'Content-Type: application/json' -d "{\"decision\":\"CONTINUE\",\"decided_by\":\"陈静\",\"basis\":\"复检无异常\",\"version\":\"$VER\"}"
# -> { error:"当前不满足“准予继续流转”的条件，只能登记召回（RECALL）",
#      code:"CONTINUE_NOT_ALLOWED",
#      details:["出货快照未覆盖当前批次过敏原（当前新增未声明：花生），…","当前没有有效放行记录，…"] }

# 3) 召回：提交操作人、依据与查询版本 → 落账（只增），出货单仍待评估、数量仍占用
curl -s -X POST http://localhost:3000/api/shipments/SHIP-0001/dispositions \
  -H 'Content-Type: application/json' \
  -d "{\"decision\":\"RECALL\",\"decided_by\":\"质检员-陈静\",
       \"basis\":\"新增花生未在出货标签声明且原放行失效，整批召回\",\"version\":\"$VER\"}"
# -> { ok:true, disposition:{id:1, decision:"RECALL", life_status:"ACTIVE",
#                             expected_version:1, status_version:2, decided_by, basis, decided_at},
#      evaluation:{...最新评估视图...} }

# 4) 重复提交（即便重新查询拿到新版本，或复用旧版本）→ 409，不能覆盖
curl -s -X POST http://localhost:3000/api/shipments/SHIP-0001/dispositions \
  -H 'Content-Type: application/json' -d "{\"decision\":\"RECALL\",\"decided_by\":\"另一人\",\"basis\":\"覆盖\",\"version\":\"$VER\"}"
# -> { error:"该出货单已存在有效的质量处置结论（召回，记录 #1）；处置记录只增不改，…",
#      code:"DISPOSITION_EXISTS" }      # 旧版本则为 VERSION_EXPIRED

# 5) 此后撤销花生改动（过敏原恢复）：旧召回结论保留并标“需重新评估”，不自动生效
#    事件更正响应附 stale_dispositions；再查评估视图：
curl -s http://localhost:3000/api/shipments/SHIP-0001/evaluation
# -> current_disposition:{ decision:"RECALL", life_status:"STALE", needs_review:true,
#                          stale_reason:"批次过敏原集合已变化（移除：花生）" }
#    history:[{id:1, decision:"RECALL", life_status:"STALE", decided_by:"质检-陈静", basis:"..."}]
#    登记新有效放行后三条件齐全 → 重新查询取新版本，可提交 CONTINUE（新增第 2 条记录，#1 原样保留）
```

| 场景 | HTTP | `code` |
| --- | --- | --- |
| 结论非法 / 缺操作人 / 缺依据 / 处置时间格式错 | 400 | `INVALID_REQUEST` |
| 版本缺失、签名损坏、与本单不匹配 | 400 | `VERSION_INVALID` |
| 出货单不存在（评估/处置） | 404 | `SHIPMENT_NOT_FOUND` |
| 非待评估单提交处置 | 409 | `SHIPMENT_NOT_REVIEWABLE` |
| 条件不满足仍提交 CONTINUE | 409 | `CONTINUE_NOT_ALLOWED`（`details` 逐条原因） |
| 版本过期（TTL/状态版本已前进/查询后上下文变化），**不产生记录** | 409 | `VERSION_EXPIRED` |
| 已有有效结论，重复提交（含旧版本）不得覆盖 | 409 | `DISPOSITION_EXISTS` |

## 原料供应批号与流向追溯（本轮新增）

供应商通报某原料的某个**供应批号**异常时，质检需要查清该批号“可能流向了哪些产出批次与出货单”。

### 批号登记与投料归属

- **供应批号档案**（`material_lots`）：批号挂在所属原料下，**同一原料下批号唯一**；
  可记录供应商与备注。供应商通报异常时可把批号标记为 `FLAGGED`
  （**仅留痕/提示，不自动改变任何放行、标签卷、出货与处置结论**），事后可解除；
  已被投料记录引用的批号不可删除（保证追溯证据完整）。
- **每次加工的原料输入可记录所属供应批号**：加工事件新增请求字段 `material_inputs`，
  每项 `{ "material_id", "lot_id" }`（或用 `lot_code` 按批号号传入）；
  **同一种原料允许在一次加工中使用多个批号**（同原料多条投料行）。
- 条目**省略批号（或给 null）= 批号未知**。
- **旧写入完全兼容、旧记录不丢失**：只传 `material_ids: [1,2]` 的事件写入（`POST/PUT /api/events`）
  与整组换线更正仍可用，其全部原料输入记为**批号未知**；旧库启动时自动补列，
  历史投料一律为批号未知。
- 投料时**批号不存在、或批号与原料不匹配一律明确拒绝**（`400`，`LOT_NOT_FOUND` /
  `LOT_MATERIAL_MISMATCH`），不会把批号静默记错到别的原料上。
- 整组换线预演/确认应用（`/api/replan/preview|apply`）的 `update` 变更同样支持 `material_inputs`
  全量覆盖输入；批号在影子库校验阶段即核对，非法批号预演即拒绝。

### 追溯规则（只读，按最新合法时间线逐时回放）

`GET /api/trace/material-lot?material_id=&lot_id=`（或 `&lot_code=`）沿当前最新时间线传播：

1. **直接投料**：加工事件直接使用了该批号原料；
2. **前序批次引用**：后续加工引用了已命中批次，按引用链逐跳传播（可跨设备）；
3. **同设备未清洗残留**：批号随加工留在设备残留中，被该设备**之后、下一次清洗之前**
   的每次加工并入；**全清（CLEAN 省略清洗范围）截断设备残留**；**部分清洗**只清除
   “来源原料的全部已登记过敏原均已被本次清洗去除”的设备传播——尚有任一未清除过敏原即
   不能排除该批号/批号未知流向；来源原料无过敏原登记时部分清洗不截断，只有全清截断；
   多次部分清洗按过敏原逐次截断。直接投料与批次引用不受任何清洗影响。

结果分两类（互不重叠；受影响对象**不漏报，也不把无法排除的对象误列为安全**）：

- `confirmed_batches`（**确定命中**）：存在可核实传播链，起点是“该原料 + 该批号”的直接投料；
- `unresolved_batches`（**因该原料批号未知而无法排除**）：传播链起点是“该原料批号未知”的投料，
  未知证据同样沿前序引用与设备残留继续传播。一个批次没有确定证据、但存在未知证据时必须列入此类；
  批号未知**不等同于安全**。
- 省略批号参数（只给 `material_id`）= 查询“**该原料批号未知**”而无法排除的全部流向。
- 每个批次给出 `evidence.confirmed` / `evidence.unresolved` 的**传播依据链**，并按进入该批次的
  **最后一跳**标注 `routes: { direct, batch_reference, equipment_residue }`；
  同时返回 `equipment_residue`（最后一次已核实清洗后批号仍可能滞留的设备）。
- 每个批次附**关联出货单** `shipments`（单号、状态、数量、待评估原因、当前质量处置摘要），
  顶层 `shipments.confirmed/unresolved` 为按类别汇总的出货单。
- **路径展示可限量**：`path_limit`（默认 30，1~200）只限制每类依据展示的链条数，超出给截断标记；
  **受影响批次/出货单的判定与数量不受限制，不会漏报**。
- 事件**更正或删除**后，既有“校验 + 全量重算”保证时间线合法，追溯始终按**最新合法时间线**重新计算
  （追溯结果不持久化）。
- **追溯只供查询**：不自动改变放行、标签卷、出货单与处置结论；需要处置时仍走既有
  放行登记/删除、出货质量评估等流程并留痕。

### HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/material-lots` | 登记供应批号（`material_id`、`lot_code`、`supplier?`、`note?`），返回批号对象 |
| `GET /api/material-lots` | 批号列表，可 `?material_id=` 过滤 |
| `POST /api/material-lots/:id/flag` | 供应商通报异常：标记 `FLAGGED`（body 可带 `flagged_reason`，仅留痕） |
| `POST /api/material-lots/:id/unflag` | 解除异常标记，恢复 `ACTIVE` |
| `DELETE /api/material-lots/:id` | 删除批号（已被投料引用 → `400 LOT_IN_USE`） |
| `GET /api/trace/material-lot` | 流向追溯：`?material_id=&lot_id=` 或 `&lot_code=`；省略批号 = 查“批号未知”；可加 `&path_limit=` |
| `POST /api/events`、`PUT /api/events/:id` | 加工事件新增/全量更正，新增可选 `material_inputs:[{material_id, lot_id?\|lot_code?}]`；旧 `material_ids` 语义不变（记批号未知） |
| `POST /api/replan/preview`、`POST /api/replan/apply` | `update` 变更支持同一 `material_inputs` 形态 |
| `GET /api/state` | `materials[].lots` 含各原料批号；事件 `inputs[]` 每项另含 `material_lot_id`/`lot_known`/`material_lot_code`/`material_lot_status` |

批号对象字段：`id`、`material_id`、`material_code`、`material_name`、`lot_code`、`supplier`、
`note`、`status`（`ACTIVE`/`FLAGGED`）、`flagged`、`flagged_reason`。

### 调用示例（curl，基于演示数据）

演示库已登记：全脂奶粉 `SUP-MILK-20260925-A`（正常）与 `SUP-MILK-20260926-B`（**已通报 FLAGGED**），
`BATCH-002`(10:00, LINE-A) 同时投入这两个牛奶批号，`BATCH-003`(11:00) 引用 `BATCH-002`；
`LABEL-0001`/`SHIP-0001` 属于 `BATCH-003`。另在 FRYER-B 上 `BATCH-004`(12:00) 投花生批号
`SUP-PNT-20260928-3`，12:30 有一次**部分清洗（仅去花生）**，13:00 再做**全清**，
之后 `BATCH-005` 为空白验证批。

```bash
# 1) 登记一个新供应批号（也可标记供应商/备注）
curl -s -X POST http://localhost:3000/api/material-lots \
  -H 'Content-Type: application/json' -d '{
    "material_id": 3, "lot_code": "SUP-MILK-20260927-C",
    "supplier": "诚信乳业", "note": "9/27 到货批"
  }'
# -> { id:5, material_code:"MILK-01", lot_code:"SUP-MILK-20260927-C",
#      status:"ACTIVE", flagged:false, ... }

# 2) 供应商通报异常：标记批号（仅留痕，不改变任何放行/卷/出货/处置结论）
curl -s -X POST http://localhost:3000/api/material-lots/2/flag \
  -H 'Content-Type: application/json' -d '{"flagged_reason":"供应商通报该批可能混入异常原料"}'

# 3) 加工录入：同一次加工中同种原料使用多个批号 + 一个批号未知
#    （省略 lot_id/lot_code 即批号未知；旧 material_ids 写法仍可用）
curl -s -X POST http://localhost:3000/api/events \
  -H 'Content-Type: application/json' -d '{
    "type":"PROCESS","event_time":"2026-10-01T08:00","equipment_id":1,
    "batch_code":"BATCH-006","note":"早班蛋糕糊",
    "material_inputs":[
      {"material_id":3,"lot_id":1},
      {"material_id":3,"lot_id":2},
      {"material_id":3}
    ],
    "ref_batch_ids":[]
  }'
# -> { id:..., invalidated:[], retired_rolls:[], pending_shipments:[], stale_dispositions:[] }

# 4) 追溯被通报的牛奶批号 B：直接投料 BATCH-002 →（前序引用 + 同设备残留）BATCH-003 → 出货单
curl -s 'http://localhost:3000/api/trace/material-lot?material_id=3&lot_id=2'
# -> { query:{ mode:"LOT", material:{code:"MILK-01",...},
#             lot:{lot_code:"SUP-MILK-20260926-B", status:"FLAGGED", flagged:true} },
#      summary:{ confirmed_batch_count:2, unresolved_batch_count:0,
#                confirmed_shipment_count:1, unresolved_shipment_count:0 },
#      confirmed_batches:[
#        { batch_code:"BATCH-002", classification:"CONFIRMED",
#          evidence:{ confirmed:{ routes:{direct:true,batch_reference:false,equipment_residue:false},
#            chains:["原料:全脂奶粉(MILK-01)[批号:SUP-MILK-20260926-B]"] }, unresolved:{...空} },
#          shipments:[] },
#        { batch_code:"BATCH-003", classification:"CONFIRMED",
#          evidence:{ confirmed:{ routes:{direct:false,batch_reference:true,equipment_residue:true},
#            chains:[
#              "原料:全脂奶粉(MILK-01)[批号:SUP-MILK-20260926-B] → 批次引用:BATCH-002",
#              "原料:全脂奶粉(MILK-01)[批号:SUP-MILK-20260926-B] → 设备残留:LINE-A" ] } },
#          shipments:[{ shipment_code:"SHIP-0001", status:"SHIPPED", ship_qty:100,
#                       current_disposition:null, ... }] } ],
#      unresolved_batches:[], equipment_residue:[],   # 15:00 班后清洗已截断 LINE-A 残留
#      notice:"本追溯结果仅供质检查询：不会自动改变批次放行、标签卷、出货单与质量处置结论；…" }

# 5) 只查该原料“批号未知”的无法排除流向（演示中全蛋液批号未知：BATCH-002 → BATCH-003）
curl -s 'http://localhost:3000/api/trace/material-lot?material_id=4'
# -> { query:{ mode:"UNKNOWN_LOT", ... },
#      unresolved_batches:[
#        { batch_code:"BATCH-002", classification:"UNRESOLVED",
#          evidence:{ unresolved:{ chains:["原料:全蛋液(EGG-01)[批号未知]"],
#                                  routes:{direct:true,...} } } },
#        { batch_code:"BATCH-003", ..., shipments:[{shipment_code:"SHIP-0001",...}] } ] }

# 6) 部分清洗（12:30 仅去花生）+ 全清（13:00）截断残留：花生批号只命中 BATCH-004，BATCH-005 安全排除
#    （花生在 12:30 部分清洗时已被去除；若改查“大豆”，12:30 不截断，13:00 全清才截断）
curl -s 'http://localhost:3000/api/trace/material-lot?material_id=6&lot_code=SUP-PNT-20260928-3'
# -> confirmed_batches:["BATCH-004"]；BATCH-005 不在 confirmed 也不在 unresolved

# 7) 路径限量（默认 30，最大 200）：只影响展示链数，受影响对象不漏
curl -s 'http://localhost:3000/api/trace/material-lot?material_id=3&lot_id=2&path_limit=1'
```

| 场景 | HTTP | `code` |
| --- | --- | --- |
| 批号不存在、原料不存在 | 404 | `LOT_NOT_FOUND` / `MATERIAL_NOT_FOUND` |
| 批号与指定原料不匹配（查询或投料/换线） | 400 | `LOT_MATERIAL_MISMATCH` |
| 同原料下批号重复 | 400 | `LOT_CODE_CONFLICT` |
| 批号已被投料引用仍删除 | 400 | `LOT_IN_USE` |
| 缺 `material_id`、`path_limit` 越界、`lot_id`/`lot_code` 同传、请求体形状错 | 400 | `INVALID_REQUEST` |

> 追溯是**只读**查询：重复调用不会停用标签卷、不会把出货单转待评估、不会失效放行或改动处置结论。

## 断网期间日志整包补录与对账

设备断网期间发生的**加工**与**已核实清洗**日志，恢复联网后可用一个**补录批号**整包补录：

- 提交时带**补录批号**（`backfill_code`）与**有序记录数组**（`records`，顺序即断网期间发生顺序）；
  每条记录必须含**外部记录号**（`external_ref`，断网日志中的原始记录号）、**时间**（`event_time`）与
  **设备**（`equipment_id` 或 `equipment_code`）。
- **加工记录**（`type:"PROCESS"`）还含：产出批次 `batch_code`、原料输入 `material_inputs`
  （每项 `{ material_id|material_code, lot_id?|lot_code? }`，**省略批号即批号未知**；
  旧式 `material_ids` 也仍可用）和/或引用批次 `ref_batch_codes`（亦兼容旧式 `ref_batch_ids`）。
- **清洗记录**（`type:"CLEAN"`）：**省略 `clean_allergens` 表示全清**，传**非空名称数组表示部分清洗**
  （语义、校验与单条 CLEAN 接口完全一致：显式空集、非字符串/空白名称拒绝）。
- **包内引用只可指向有序记录中更早产出的批次**（记录顺序更早且产出时间严格更早）；
  引用库内既有批次同样要求其产出时间严格更早。
- **整包事务化**：未知设备/原料/供应批号/引用批次、空清洗集合、同设备同时间冲突、
  未来/同时刻引用、循环引用、批次重复产出、外部记录号冲突等——**整包回滚，不留部分事件**。
- **幂等与冲突**：
  - **相同补录批号 + 相同内容重试**：返回首次成功的原结果（`idempotent:true`，事件号映射不变，不重复写入）；
    用 id 或编码引用同一档案视为同内容。
  - **相同补录批号 + 不同内容**：整包拒绝（`409 BACKFILL_CODE_CONFLICT`）。
  - **外部记录号与已入库记录同号同内容**：跨包提交时**复用其既有事件，不重复写入**
    （计入 `reused_events`，新包台账仍记录该外部记录号）；
    **同号不同内容**整包拒绝（`409 BACKFILL_EXTERNAL_REF_CONFLICT`）。
- 补录成功后按**现有时间线规则全量重算**：设备残留与批次过敏原、放行失效、标签卷永久停用、
  出货单转待评估、质量处置结论标需重新评估，与既有单条事件写入的联动完全相同。
- 响应返回 **外部记录号 → 事件号映射**（`event_mapping`）与**影响摘要**（`impact_summary`，
  另以既有形状平铺 `invalidated`/`retired_rolls`/`pending_shipments`/`stale_dispositions`）。
- 可按补录批号**查询对账结果**：逐条与当前时间线比对——`OK`（内容一致）、
  `MISMATCH`（事件后经单条接口更正，附字段差异）、`DELETED`（事件已被删除，台账记录保留）。
- 既有单条事件接口（`POST/PUT/DELETE /api/events`）的请求、响应与错误约定**完全保持不变**；
  补录产生的事件在 `/api/state` 中另附只读的 `external_ref` 与 `backfill_code`。

### HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/backfills` | 整包提交补录（整包事务化校验 + 重算）；同号同内容重试幂等返回原结果 |
| `GET /api/backfills` | 补录批号列表（记录数、新写入/复用数、已删除事件数） |
| `GET /api/backfills/:code` | 按补录批号查询对账结果（逐条 `OK`/`MISMATCH`/`DELETED` 与首次结果） |
| `GET /api/state` | 补录产生的事件另附只读 `external_ref`、`backfill_code`（既有字段不变） |

请求体（加工 + 全清/部分清洗混排；`records` 顺序即时间线顺序）：

```json
{
  "backfill_code": "BF-LINEA-20261001",
  "records": [
    { "external_ref": "DEV-A-20261001-001", "type": "PROCESS",
      "event_time": "2026-10-01T08:00", "equipment_code": "LINE-A",
      "batch_code": "BATCH-OFF-001", "note": "断网早班：蛋糕糊",
      "material_inputs": [
        { "material_code": "MILK-01", "lot_code": "SUP-MILK-20260925-A" },
        { "material_id": 4 }
      ],
      "ref_batch_codes": [] },
    { "external_ref": "DEV-A-20261001-002", "type": "CLEAN",
      "event_time": "2026-10-01T09:00", "equipment_code": "LINE-A",
      "note": "换线全清（省略 clean_allergens 即全清）" },
    { "external_ref": "DEV-A-20261001-003", "type": "PROCESS",
      "event_time": "2026-10-01T10:00", "equipment_id": 1,
      "batch_code": "BATCH-OFF-002", "note": "部分清洗演示前序批",
      "material_inputs": [{ "material_code": "PEANUT-01" }] },
    { "external_ref": "DEV-A-20261001-004", "type": "CLEAN",
      "event_time": "2026-10-01T10:30", "equipment_id": 1,
      "clean_allergens": ["花生"], "note": "部分清洗：仅核实去花生" },
    { "external_ref": "DEV-A-20261001-005", "type": "PROCESS",
      "event_time": "2026-10-01T11:00", "equipment_id": 1,
      "batch_code": "BATCH-OFF-003",
      "material_inputs": [{ "material_code": "EGG-01" }],
      "ref_batch_codes": ["BATCH-OFF-001"] }
  ]
}
```

成功响应（外部记录号 → 事件号映射 + 影响摘要 + 既有形状的平铺联动结果）：

```json
{
  "ok": true,
  "backfill_code": "BF-LINEA-20261001",
  "backfill_id": 3,
  "idempotent": false,
  "record_count": 5,
  "events": [{ "external_ref": "DEV-A-20261001-001", "event_id": 10 }],
  "event_mapping": {
    "DEV-A-20261001-001": 10, "DEV-A-20261001-002": 11,
    "DEV-A-20261001-003": 12, "DEV-A-20261001-004": 13,
    "DEV-A-20261001-005": 14
  },
  "produced_batches": [
    { "external_ref": "DEV-A-20261001-001", "batch_code": "BATCH-OFF-001", "batch_id": 6, "event_id": 10 }
  ],
  "impact_summary": {
    "inserted_events": 5, "reused_events": 0, "produced_batches": 3,
    "invalidated_releases": 1, "retired_label_rolls": 1,
    "pending_shipments": 1, "stale_dispositions": 0
  },
  "invalidated": [ { "id": 1, "batch_code": "BATCH-003", "reason": "早期事件更正后重算，…" } ],
  "retired_rolls": [ { "id": 1, "roll_code": "LABEL-0001", "reason": "…", "applied_pending_review": 120 } ],
  "pending_shipments": [ { "shipment_code": "SHIP-0001", "status": "PENDING_REVIEW", "items": [ /*快照*/ ] } ],
  "stale_dispositions": []
}
```

#### 调用示例（curl）

```bash
# 1) 整包补录断网期间的两条加工与一次全清（含批号未知输入与包内引用）
curl -s -X POST http://localhost:3000/api/backfills \
  -H 'Content-Type: application/json' -d '{
    "backfill_code":"BF-LINEA-20261001",
    "records":[
      {"external_ref":"DEV-A-001","type":"PROCESS","event_time":"2026-10-01T08:00",
       "equipment_code":"LINE-A","batch_code":"BATCH-OFF-001",
       "material_inputs":[{"material_code":"MILK-01"}]},
      {"external_ref":"DEV-A-002","type":"CLEAN","event_time":"2026-10-01T09:00",
       "equipment_code":"LINE-A","note":"换线全清"},
      {"external_ref":"DEV-A-003","type":"PROCESS","event_time":"2026-10-01T10:00",
       "equipment_code":"LINE-A","batch_code":"BATCH-OFF-002",
       "material_inputs":[{"material_code":"EGG-01"}],
       "ref_batch_codes":["BATCH-OFF-001"]}
    ]
  }'
# -> { ok:true, idempotent:false, event_mapping:{"DEV-A-001":10,"DEV-A-002":11,"DEV-A-003":12},
#      impact_summary:{ inserted_events:3, reused_events:0, invalidated_releases:0, ... },
#      invalidated:[], retired_rolls:[], pending_shipments:[], stale_dispositions:[] }

# 2) 网络重试：相同补录批号 + 相同内容（即使设备/原料改用 id 形式）-> 原结果，不重复写入
curl -s -X POST http://localhost:3000/api/backfills -H 'Content-Type: application/json' -d '{
  "backfill_code":"BF-LINEA-20261001",
  "records":[
    {"external_ref":"DEV-A-001","type":"PROCESS","event_time":"2026-10-01T08:00",
     "equipment_id":1,"batch_code":"BATCH-OFF-001","material_inputs":[{"material_id":3}]},
    {"external_ref":"DEV-A-002","type":"CLEAN","event_time":"2026-10-01T09:00","equipment_id":1},
    {"external_ref":"DEV-A-003","type":"PROCESS","event_time":"2026-10-01T10:00",
     "equipment_id":1,"batch_code":"BATCH-OFF-002",
     "material_inputs":[{"material_id":4}],"ref_batch_codes":["BATCH-OFF-001"]}
  ]
}'
# -> { ok:true, idempotent:true, event_mapping:{...同上，事件号不变...}, impact_summary:{...首次结果...} }

# 3) 非法整包（时间冲突 / 引用包内更晚产出 / 空清洗集合 / 未知对象）-> 400，整包回滚不留事件
curl -s -X POST http://localhost:3000/api/backfills -H 'Content-Type: application/json' -d '{
  "backfill_code":"BF-BAD",
  "records":[
    {"external_ref":"B1","type":"PROCESS","event_time":"2026-10-01T13:00","equipment_id":1,
     "batch_code":"BATCH-BAD-1","material_inputs":[],
     "ref_batch_codes":["BATCH-BAD-2"]},
    {"external_ref":"B2","type":"PROCESS","event_time":"2026-10-01T14:00","equipment_id":1,
     "batch_code":"BATCH-BAD-2","material_inputs":[]}
  ]
}'
# -> { error:"补录包引用的档案不存在或包内引用不合法", code:"BACKFILL_REJECTED",
#      details:["records[0]（外部记录号 B1）：包内引用只可指向有序记录中更早产出的批次 …"] }

# 4) 按补录批号对账：事件后经单条接口更正/删除会逐条标 MISMATCH/DELETED
curl -s http://localhost:3000/api/backfills/BF-LINEA-20261001
# -> { backfill_code, status:"OK" | "HAS_DRIFT",
#      reconcile_summary:{ ok:3, mismatch:0, deleted:0 },
#      records:[{ seq:0, external_ref:"DEV-A-001", event_id:10, type:"PROCESS",
#                 reconcile_status:"OK", reconcile_detail:"事件仍在，内容与补录一致", ... }],
#      result:{ ...首次提交返回的完整结果... } }

# 5) 补录批号列表
curl -s http://localhost:3000/api/backfills
# -> { backfills:[{ backfill_id, backfill_code, record_count, inserted_count,
#                   reused_count, deleted_events, created_at }] }
```

| 场景 | HTTP | `code` |
| --- | --- | --- |
| 请求体形状错（缺补录批号/空记录/缺外部记录号/包内外部记录号重复/时间格式错）、显式空清洗集合/非字符串空白名称、PROCESS 携带清洗范围 | 400 | `INVALID_REQUEST` |
| 未知设备/原料/供应批号/引用批次、批号与原料不匹配、包内引用指向更晚产出、产出批次已在库 | 400 | `BACKFILL_REJECTED` |
| 整包应用后时间线非法（时间冲突/未来或同时刻引用/引用环/批次重复产出） | 400 | `BACKFILL_REJECTED`（整包回滚，不留部分事件） |
| 相同补录批号内容不同 | 409 | `BACKFILL_CODE_CONFLICT` |
| 外部记录号与已入库内容冲突（同号不同内容；或同号的既有事件已删除无法复用） | 409 | `BACKFILL_EXTERNAL_REF_CONFLICT` |
| 按补录批号对账不存在 | 404 | `BACKFILL_NOT_FOUND` |


## 设备检修停机窗口（本轮新增）

设备检修期间**不能记录加工或清洗**。操作员可按设备**登记、调整、取消**停机窗口，
填写**起止时间、原因和操作人**，并查询窗口及其覆盖的冲突事件：

- 窗口为**左闭右开区间** `[start_time, end_time)`：事件时刻 `t` 命中窗口当且仅当 `start_time ≤ t < end_time`；
  **起点须早于终点**。
- **同设备窗口不可重叠，相邻允许**（一个窗口的终点可等于另一个的起点）；不同设备的窗口互不影响。
- **登记或调整若覆盖已有加工/清洗事件**：返回 `409 WINDOW_EVENT_CONFLICT` 与冲突事件明细（`conflicts`），
  **整次拒绝**（调整时原窗口保持不变）。
- 此后**单条事件新增或更正**（`POST/PUT /api/events`）、**断网整包补录**（`POST /api/backfills`）、
  **换线整组预演与确认应用**（`/api/replan/preview|apply`）均按**最终设备和时间**核对窗口：
  命中时在 `details` 中指出冲突的事件与窗口，**整次拒绝**——不改变现有事件、推导结果或补录台账，
  预演不写正式数据。
- **已成功补录的同号同内容重试仍返回原结果**（幂等优先：命中既有补录批号 + 相同内容时直接返回首次结果，
  不重新核对窗口、不重复写入）。
- **窗口变动后旧预演的确认也须重新核对**：窗口登记/调整/取消会使既有预演版本过期
  （`apply` 返回 `409 VERSION_EXPIRED`），需重新预演；重新预演即按最新窗口核对。
- **停机不等于清洗**：窗口不是事件，**不改变设备残留或过敏原推导**，不触发放行失效、
  标签卷停用、出货待评估或处置结论重评等重算联动；窗口接口响应不含这些联动字段。

### HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/downtime-windows` | 登记停机窗口（`equipment_id` 或 `equipment_code` 二选一 + `start_time`/`end_time`/`reason`/`operator`），返回窗口对象 |
| `GET /api/downtime-windows` | 窗口列表（可 `?equipment_id=` 过滤），每项含 `conflicting_events`（窗口当前覆盖的事件，正常恒为空） |
| `GET /api/downtime-windows/:id` | 单个窗口（含冲突事件） |
| `PUT /api/downtime-windows/:id` | 调整窗口（全量覆盖：设备/起止/原因/操作人）；冲突整次拒绝、原窗口不变 |
| `DELETE /api/downtime-windows/:id` | 取消窗口 |
| `GET /api/state` | 顶层另含 `downtime_windows` 数组（既有字段不变） |
| `POST/PUT /api/events`、`POST /api/backfills`、`POST /api/replan/preview|apply` | 请求/响应形状不变；命中窗口时按既有错误形状在 `details` 中给出冲突原因并整次拒绝 |

窗口对象字段：`id`、`equipment_id`、`equipment_code`、`equipment_name`、`start_time`、`end_time`、
`reason`、`operator`、`created_at`、`updated_at`、`conflicting_events[]`
（每项：`event_id`/`event_time`/`type`/`equipment_id`/`equipment_code`/`batch_code`/`note`）。

### 调用示例（curl，基于演示数据）

演示库自带 LINE-A 上两个**相邻**的检修窗口：`2026-10-09T08:00–10:00`（更换搅拌桨密封）与
`2026-10-09T10:00–12:00`（输送带张紧校准，起点=前一窗口终点，相邻允许）。

```bash
# 1) 查询窗口及冲突事件（可按设备过滤）
curl -s http://localhost:3000/api/downtime-windows
curl -s 'http://localhost:3000/api/downtime-windows?equipment_id=1'
# -> { windows:[{ id:1, equipment_code:"LINE-A", start_time:"2026-10-09T08:00",
#      end_time:"2026-10-09T10:00", reason:"月度检修：更换搅拌桨密封",
#      operator:"设备科-张工", conflicting_events:[] }, ...] }

# 2) 登记新窗口（检修期间不能记录加工或清洗）
curl -s -X POST http://localhost:3000/api/downtime-windows \
  -H 'Content-Type: application/json' -d '{
    "equipment_code":"FRYER-B","start_time":"2026-10-10T08:00","end_time":"2026-10-10T12:00",
    "reason":"季度大修","operator":"设备科-李工"
  }'

# 3) 同设备重叠 -> 409 WINDOW_OVERLAP（相邻不算重叠）
curl -s -X POST http://localhost:3000/api/downtime-windows \
  -H 'Content-Type: application/json' -d '{
    "equipment_id":1,"start_time":"2026-10-09T09:00","end_time":"2026-10-09T11:00",
    "reason":"x","operator":"y"
  }'
# -> { error:"…与已有停机窗口重叠：同设备窗口不可重叠（相邻允许），整次拒绝",
#      code:"WINDOW_OVERLAP", details:["窗口 #1 [2026-10-09T08:00, 2026-10-09T10:00)…", ...] }

# 4) 登记/调整覆盖已有事件 -> 409 WINDOW_EVENT_CONFLICT，返回冲突事件明细
curl -s -X POST http://localhost:3000/api/downtime-windows \
  -H 'Content-Type: application/json' -d '{
    "equipment_id":1,"start_time":"2026-09-30T07:00","end_time":"2026-09-30T09:00",
    "reason":"突发检修","operator":"张工"
  }'
# -> { code:"WINDOW_EVENT_CONFLICT",
#      conflicts:[{ event_id:1, event_time:"2026-09-30T08:00", type:"PROCESS",
#                   equipment_code:"LINE-A", batch_code:"BATCH-001", ... }] }

# 5) 窗口内新增/更正事件 -> 400，details 指出冲突的事件与窗口，整次回滚
curl -s -X POST http://localhost:3000/api/events \
  -H 'Content-Type: application/json' -d '{
    "type":"PROCESS","event_time":"2026-10-09T08:30","equipment_id":1,
    "batch_code":"BATCH-X","material_ids":[1]
  }'
# -> { error:"提交被拒绝（整次提交已回滚）",
#      details:["事件 #N（2026-10-09T08:30，设备 #1）落入设备检修停机窗口
#                [2026-10-09T08:00, 2026-10-09T10:00)（窗口 #1，原因：月度检修…）：检修期间不能记录加工或清洗"] }
#    事件时刻恰为窗口终点（右开）则允许；补录包内记录命中窗口 -> 400 BACKFILL_REJECTED（整包回滚，台账不写）；
#    换线预演命中窗口 -> 400 REPLAN_REJECTED（不写正式数据）。

# 6) 调整 / 取消窗口
curl -s -X PUT http://localhost:3000/api/downtime-windows/3 \
  -H 'Content-Type: application/json' -d '{
    "equipment_id":2,"start_time":"2026-10-10T08:00","end_time":"2026-10-10T14:00",
    "reason":"季度大修（延长）","operator":"设备科-李工"
  }'
curl -s -X DELETE http://localhost:3000/api/downtime-windows/3

# 7) 窗口变动后旧预演版本过期：先 preview 取 version，登记/调整/取消任一窗口后
#    再 apply 该 version -> 409 VERSION_EXPIRED，需重新预演（重新预演即按最新窗口核对）。
```

| 场景 | HTTP | `code` |
| --- | --- | --- |
| 缺设备/起止时间格式错/起点不早于终点/缺原因/缺操作人/id 与编码同传/过滤参数非法 | 400 | `INVALID_REQUEST` |
| 设备不存在 | 404 | `EQUIPMENT_NOT_FOUND` |
| 窗口不存在（查询/调整/取消） | 404 | `WINDOW_NOT_FOUND` |
| 同设备窗口重叠（登记或调整） | 409 | `WINDOW_OVERLAP` |
| 覆盖已有加工/清洗事件（登记或调整，附 `conflicts` 明细） | 409 | `WINDOW_EVENT_CONFLICT` |
| 事件新增/更正命中窗口 | 400 | （既有事件校验形状，`details` 指出冲突） |
| 补录命中窗口（整包回滚，不写台账） | 400 | `BACKFILL_REJECTED` |
| 换线预演/确认命中窗口 | 400 | `REPLAN_REJECTED` |
| 窗口变动后确认旧预演版本 | 409 | `VERSION_EXPIRED` |

## 一键启动（Docker，从空环境开始）

要求安装 Docker 与 Docker Compose（v2）。在项目目录执行：

```bash
docker compose up --build -d
```

该命令会依次完成：构建镜像 → 安装 npm 依赖 → 初始化 SQLite 库与表结构 →
首次启动写入演示数据 → 启动 Web 服务。

查看日志 / 停止：

```bash
docker compose logs -f
docker compose down            # 停止（保留数据卷）
docker compose down -v         # 停止并删除本地数据（恢复空白/演示初始状态）
```

## 本地直接运行（无 Docker）

要求 Node.js 20+：

```bash
npm install
npm start                      # 自动创建 data/allergen.db、建表并写入演示数据
```

可选单独初始化数据库：`npm run init-db`。

测试（不依赖外部框架，直接在临时库上跑）：

```bash
npm test             # 校验引擎：无环/成环用例
npm run test:replan  # 启动临时端口的真实服务，端到端验证整组预演/确认应用全部语义
npm run test:labels  # 启动临时端口的真实服务，端到端验证标签卷登记/核销/永久停用全部语义
npm run test:shipments # 端到端验证包装出货：余额、整单事务拒绝、快照、待评估联动与换线预测
npm run test:evaluations # 端到端验证待评估单质量处置：评估视图/版本并发/CONTINUE 条件/只增不改/需重新评估
npm run test:trace       # 端到端验证供应批号登记/投料批号/追溯传播（直接/引用/残留/清洗截断/未知无法排除）/更正删除更新/换线带批号/只读不改动
npm run test:partial-clean # 端到端验证部分清洗：入参校验/只清指定过敏原/重算联动（放行/卷/出货/处置）/追溯按过敏原保留设备传播/全清与无过敏原原料/换线预演确认
npm run test:backfill     # 端到端验证断网日志整包补录：整包事务/包内引用/幂等重试/外部记录号复用与冲突/重算联动（放行/卷/出货/处置）/对账（OK/MISMATCH/DELETED）/旧接口兼容
npm run test:downtime     # 端到端验证设备检修停机窗口：登记/调整/取消/查询、左闭右开与相邻允许、覆盖事件整次拒绝、事件/补录/换线核对、幂等重试优先、停机不等于清洗
```

## 访问地址与端口

启动后浏览器打开：

- **http://localhost:3000**

端口可通过环境变量 `PORT` 修改；使用 Compose 时可在宿主机设置
`PORT=8080 docker compose up --build`（容器内仍监听 3000，宿主机映射变为 8080，
届时访问 http://localhost:8080 ）。

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Web 服务监听端口（容器内） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `data/allergen.db`（本地）/ `/app/data/allergen.db`（容器） | SQLite 数据文件路径 |
| `SEED_DEMO` | `true` | 首次启动（库为空）时是否写入演示数据；`false` 则得到空白库 |

数据保存在 SQLite 文件中：本地运行位于项目 `data/` 目录；Docker 运行位于
名为 `allergen-data` 的数据卷（容器内 `/app/data`），重启与重建镜像均不丢失。

## 页面说明

- **批次与放行**：设备当前残留（含来源路径）、每个批次的推导过敏原与逐条来源路径、
  放行记录（绿色“放行有效”/红色“已失效”及失效原因），可在此登记放行；
  批次卡片底部显示该批标签卷摘要，点击直达标签卷页。
- **过敏原标签卷**：按批次分组展示每卷印量、贴用、作废、剩余及当前修订号；
  可在此包装前登记新卷、按修订号核销贴用/作废；停用卷红色标注并给出具体停用原因，
  已贴数量标注“待复核”、余量标注“冻结”。
- **包装出货**：展示各批次**可出货余额**（未停用卷的「已贴用 − 累计已分配」，点击卡片即可出货）；
  可在此录入批次、正整数出货量、各卷分配张数与操作人做整单出货确认（失败整单拒绝、不占数量），
  并列出全部出货单及其状态、逐卷明细快照（放行标识 / 过敏原 / 卷号 / 修订号）；
  **待评估**单据黄色标注并给出逐卷停用原因，不自动恢复；
  点击「质量评估处置」可查看**出货快照与当前状态对比、准予条件判定**，
  按整单提交**准予继续流转/召回**（操作人、依据、查询状态版本；过期拒绝、记录只增不改），
  页面可查**当前结论（含“需重新评估”标记）与全部历史**。
- **事件时间线**：按时间排列全部加工/清洗事件，展示输入（含每个原料输入的供应批号，未知批号明确标注）、引用批次与推导结果；
  清洗事件展示**清洗范围**（全清 / 部分清洗去除的过敏原集合）与**清洗后残留**（部分清洗后仍滞留、将继续进入后续批次的过敏原）；
  “更正”可修改早期事件（原料可逐行选择批号，同原料可“＋ 同原料再加批号”录入多个批号；清洗可切换全清/部分清洗并填写已去除过敏原），保存时整单校验并触发重算。
- **原料批号追溯**：选择原料与供应批号（或“批号未知”）查询流向，分区展示**确定命中**与**因批号未知无法排除**
  的批次（各自传播依据链、传播方式与关联出货单）以及最后清洗后仍可能滞留批号的设备残留；可从“原料与设备”
  页的批号行一键“追溯流向”。追溯只读，不改动任何业务结论。
- **检修停机**：按设备登记/调整/取消停机窗口（起止时间、原因、操作人），列表展示各窗口
  （左闭右开区间、冲突事件数）；登记或调整覆盖已有加工/清洗事件时整次拒绝并列出冲突事件；
  窗口内不能记录加工或清洗（停机不等于清洗，不改变设备残留或推导）。
- **原料与设备**：维护原料档案（编码、名称、过敏原标签）、设备档案与**原料供应批号**（登记/通报异常 FLAGGED/解除/删除）。

## 快速体验失效场景

1. 打开“批次与放行”，可以看到演示数据中 `BATCH-003` 已登记放行（放行有效），
   “过敏原标签卷”页有其演示卷 `LABEL-0001`（印 500、贴 120、作废 5、剩 375）。
2. 到“事件时间线”，找到 `BATCH-002`（10:00 蛋糕糊），点击“更正”并加入原料 **花生碎(PEANUT-01)**，提交。
3. 由于设备残留沿时间线传播并经 `BATCH-002` 被 `BATCH-003` 引用，重算后 `BATCH-003`
   新增过敏原“花生”，原放行记录自动变为**已失效**，`LABEL-0001` **永久停用**：
   剩余 375 张冻结不可再贴，已贴 120 张标记待复核；撤销改动使集合恢复后，该卷也不会自动解冻。
4. 在“过敏原标签卷”页尝试对停用卷核销，会收到 `ROLL_RETIRED` 拒绝；
   重新登记放行后可登记新卷继续包装。

## 目录结构

```
server/
  db.js          # SQLite 连接与表结构（导出 initSchema 供内存影子库复用）
  validation.js  # 全量校验（未来批次/循环/时间冲突/重复产出/事件落入停机窗口）
  downtime.js    # 设备检修停机窗口：登记/调整/取消/查询（左闭右开、同设备不重叠相邻允许、覆盖事件整次拒绝）；事件落窗核对供全量校验复用
  recompute.js   # 推导引擎：回放事件、批次并集、设备残留（全清/部分清洗按过敏原清除）、放行核对、标签卷停用核对、出货单待评估核对
  labels.js      # 过敏原标签卷：三方一致登记、按修订号核销、永久停用
  shipments.js   # 包装出货：整单事务分配、快照保存、可出货余额、待评估联动（不自动恢复）
  evaluation.js  # 待评估单质量处置：评估视图、签名状态版本、整单结论事务提交、旧结论需重评核对
  lots.js        # 原料供应批号：档案登记/标记/删除、投料批号解析（不存在/不匹配明确拒绝）
  trace.js       # 批号流向追溯：逐时回放（直接投料/前序引用/设备残留；全清截断、部分清洗按来源过敏原逐次截断）、确定命中与批号未知无法排除、关联出货单
  backfill.js    # 断网日志整包补录：有序记录（外部记录号/时间/设备，加工含产出批次/原料批号可未知/引用批次，清洗省略范围=全清非空=部分）；整包事务校验+重算；同批号同内容幂等、同号复用/冲突拒绝；补录批号对账（OK/MISMATCH/DELETED）
  replan.js      # 整组换线：影子库预演、业务版本签名令牌、事务确认应用（update/insert_clean 支持 clean_allergens 清洗范围；update 支持 material_inputs 带批号）
  seed.js        # 首次启动演示数据（含供应批号、同原料多批号投料、一卷演示标签卷与一张演示出货单、两个相邻检修停机窗口）
  server.js      # Express API 与静态页面（含 /api/material-lots、/api/trace/material-lot、/api/label-rolls、/api/shipments、/api/replan/preview|apply、/api/shipments/:id/evaluation|dispositions、/api/backfills 补录与对账、/api/downtime-windows 停机窗口）
public/
  index.html  styles.css  app.js
scripts/
  test-cycle.js      # 校验引擎单测
  test-replan.js     # 整组预演/确认应用端到端测试
  test-labels.js     # 标签卷登记/核销/停用端到端测试
  test-shipments.js  # 包装出货：余额/整单事务/快照/待评估联动端到端测试
  test-evaluations.js # 出货质量处置：评估视图/版本并发/CONTINUE 条件/只增不改/需重新评估端到端测试
  test-trace.js       # 供应批号与流向追溯：档案/投料批号/三路径传播/清洗截断/未知无法排除/更正删除/换线带批号/只读 端到端测试
  test-partial-clean.js # 部分清洗：入参校验/部分清除推导/重算联动/追溯过敏原级截断/换线预演确认 端到端测试
  test-backfill.js   # 断网日志整包补录：整包事务/包内引用/幂等/外部记录号复用与冲突/重算联动/对账/旧接口兼容 端到端测试
  test-downtime.js   # 设备检修停机窗口：登记/调整/取消/查询、重叠与相邻、覆盖事件整次拒绝、事件/补录/换线核对、幂等重试优先、停机不等于清洗 端到端测试
Dockerfile  docker-compose.yml
```
