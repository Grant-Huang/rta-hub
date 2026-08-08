# 合理性审查规范

> **这份文档由 `scripts/sanity-doc.mts` 从 `src/delivery/sanity-rules.ts` 生成。**
> 不要手改——改规则改那个文件，然后跑 `pnpm sanity:doc`。
> CI 会用 `--check` 校验两者一致（`test/sanity-rules.test.ts` 也会）。

## 这份规范是干什么的

把一份方案 / 一份报价交给客户之前，要过的全部检查，逐条列在这里。

以前这些检查散在四五个模块里：排布器判净空、BOM 判缺不缺料、
定价引擎判价格矩阵有没有洞。每一处都能跑，但**没有任何一处回答得了
「一份方案要过哪些关」**——要回答这个问题，得把五个文件读一遍，
而且读完还不确定有没有漏。于是产生两种事故，都很难发现：

1. 规范里写了、代码里没实现——「我们检查了」其实没检查；
2. 代码里加了检查、规范没更新——客户被拦下来，翻遍文档找不到依据。

所以规则表只有一份，文档是它的视图。

## 两档严重度，不设权重

- **🚫 阻断**：一条都不放行，**不参与权衡**。任何权重都能被
  「其他方面都很好」投票压过去，而一份缺料的报价单不会因为方案好看
  就变得能用。
- **⚠️ 提示**：不拦，但**必须显示给客户**。它们是交付物的一部分，
  不是服务端日志——「你选的组装方式有几个柜体不提供」只写进日志的话，
  客户永远不会知道。

当前共 26 条：阻断 20 条、提示 6 条。

## 速查表

| 编号 | 规则 | 严重度 | 由谁执行 |
|---|---|---|---|
| SR-G1 | Components stay within wall-run length | 🚫 阻断 | 交付前审核 |
| SR-G2 | No overlap within the same wall run and layer | 🚫 阻断 | 交付前审核 |
| SR-G3 | No overlapping footprints across wall runs | 🚫 阻断 | 交付前审核 |
| SR-G4 | Clearance beside openings for countertop overhang | 🚫 阻断 | 交付前审核 |
| SR-G5 | Inside corners must yield or use a corner cabinet | 🚫 阻断 | 排布层 |
| SR-E1 | Sink landing zones 24" / 18" | 🚫 阻断 | 交付前审核 |
| SR-E2 | Cooktop landing zones 15" / 12" | 🚫 阻断 | 交付前审核 |
| SR-E3 | Refrigerator landing ≥15" on handle side | 🚫 阻断 | 交付前审核 |
| SR-E4 | Dishwasher adjacent to sink (≤36") | 🚫 阻断 | 交付前审核 |
| SR-E5 | Island aisle ≥36" (prefer 42") | 🚫 阻断 | 交付前审核 |
| SR-E6 | Work triangle within recommended range | ⚠️ 提示 | 交付前审核 |
| SR-E7 | Blind-corner cabinets warn about reach | ⚠️ 提示 | 交付前审核 |
| SR-E8 | At least one ≥36" continuous prep counter | ⚠️ 提示 | 交付前审核 |
| SR-M1 | BOM has no missing parts | 🚫 阻断 | 交付前审核 |
| SR-M2 | Only real catalog SKUs and sizes | 🚫 阻断 | 交付前审核 |
| SR-M3 | Disclose assembly forms you do not offer | ⚠️ 提示 | 交付前审核 |
| SR-Q1 | Line totals reconcile with subtotal | 🚫 阻断 | 交付前审核 |
| SR-Q2 | Price snapshot recomputes consistently | 🚫 阻断 | 交付前审核 |
| SR-D1 | Assumed values must be disclosed in customer-facing text | 🚫 阻断 | 交付前审核 |
| SR-D2 | State customer requests that could not be applied | ⚠️ 提示 | 交付前审核 |
| SR-D3 | Deliverable is allowed at this stage | 🚫 阻断 | 交付前审核 |
| SR-D4 | Quote states which product the price covers | 🚫 阻断 | 交付前审核 |
| SR-V1 | Sink and every appliance opening has a text label | 🚫 阻断 | 渲染层 |
| SR-V2 | Legend matches what is actually drawn | 🚫 阻断 | 渲染层 |
| SR-V3 | Assumed sizes marked "assumed" on drawings | 🚫 阻断 | 渲染层 |
| SR-V4 | Disconnected overall plan views must be annotated | ⚠️ 提示 | 交付前审核 |

## 几何与干涉

装得进去、彼此不打架。这一组全部是阻断项——几何不成立的方案，后面所有的好看与便宜都没有意义。

#### SR-G1　Components stay within wall-run length

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts geometryProblems`） |

**判据**：每个构件的 [x, x+width] 必须落在 [0, run.length] 内。

**为什么**：超出墙长的柜子现场装不进去。这是最基本的一条，但它只在单段墙内成立——跨墙段的问题要靠 SR-G3。

#### SR-G2　No overlap within the same wall run and layer

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts geometryProblems`） |

**判据**：同一 wallRunId、同一 layer 的构件，横向区间与**高度区间**不同时相交（容差 0.01"）。叠装吊柜的上下两段共用一个横向区间、靠 `stackBase` 在高度上错开，不算重叠。

**为什么**：两个柜子占同一段墙面，装的时候必然有一个放不下。

#### SR-G3　No overlapping footprints across wall runs

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts interferenceProblems`） |

**判据**：把每个构件放到平面世界坐标（layout/plan-model.ts），竖直方向重叠的两个构件（高柜同时占地柜层与吊柜层）足迹不得相交。

**为什么**：内墙角处两段墙的柜子会占同一块 24"×24"，而它们**不在同一段墙上**——SR-G1/G2 的盲区正好在这里。客户的原话：「只有把它们连起来的时候，才会发现开关门的问题、干涉的问题」。

#### SR-G4　Clearance beside openings for countertop overhang

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts doorClearanceProblems`） |

**判据**：柜体箱体不得侵入门洞的净空区间。净空 = 门洞宽度 + 每侧（台面端头外伸 1-1/2" + 门套线 1"）；吊柜层没有台面，只让门套线。

**为什么**：台面不是柜体的投影，它四周比箱体大出一圈。按柜体判「没超墙」的方案，现场台面会压在门套线上，门开到一半就顶住。客户的说法是「至少要让出一点点距离」——那一点就是台面外伸。

#### SR-G5　Inside corners must yield or use a corner cabinet

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 排布层（`layout/plan-model.ts buildKitchenPlan`） |

**判据**：相接的两段墙中，短的那一段在墙角一侧让开「转角方块 24" + 转角填缝条 3"」；长的那一段拥有墙角，优先排 cornerAccess 型号。

**为什么**：不留转角填缝条的话，让位侧的门与抽屉一拉出来就撞上相邻墙柜体的门和拉手——两个柜子各自「没超墙」，合起来开不了。

## 人体工程与安全

NKBA 厨房规划指南的常见表述。⚠️ **这是种子数据，上线前必须核对现行版本**（见 PRE_LAUNCH_CHECKLIST）。

#### SR-E1　Sink landing zones 24" / 18"

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`layout/ergonomics.ts SINK_LANDING`） |

**判据**：水槽柜两侧连续台面，一侧 ≥24"、另一侧 ≥18"。洗碗机上方算连续台面（它在台面**底下**）。

**为什么**：洗菜、沥水、备餐都要放东西。两侧都不够的厨房用起来处处别扭，而这是排布阶段就能避免的。

#### SR-E2　Cooktop landing zones 15" / 12"

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`layout/ergonomics.ts COOKTOP_LANDING`） |

**判据**：灶具/嵌入式灶台两侧连续台面，一侧 ≥15"、另一侧 ≥12"。

**为什么**：**这是安全要求**：端下来的热锅要有地方放。不够就是烫伤风险，不是「用起来不方便」。

#### SR-E3　Refrigerator landing ≥15" on handle side

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`layout/ergonomics.ts REFRIGERATOR_LANDING`） |

**判据**：冰箱位任一侧有 ≥15" 的连续台面。

**为什么**：从冰箱里拿出来的东西要有地方搁，否则只能端着走。

#### SR-E4　Dishwasher adjacent to sink (≤36")

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`layout/ergonomics.ts DISHWASHER_TOO_FAR`） |

**判据**：洗碗机边缘距水槽最近边 ≤36"。

**为什么**：每次装碗都要端着滴水的餐具走一段。

#### SR-E5　Island aisle ≥36" (prefer 42")

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`layout/ergonomics.ts AISLE_TOO_NARROW`） |

**判据**：岛台台面外沿与正对着的柜列台面外沿之间 ≥36"；<42" 出提示。量的是**台面外沿之间**，不是柜体箱体之间。

**为什么**：<36" 人过不去。按箱体量会算出一条实际上并不存在的合格过道——两边台面各外伸 1-1/2"，正好卡在分界上。

#### SR-E6　Work triangle within recommended range

| | |
|---|---|
| 严重度 | ⚠️ 提示 |
| 由谁执行 | 交付前审核（`layout/ergonomics.ts WORK_TRIANGLE`） |

**判据**：水槽↔灶具↔冰箱三边各 4-9 英尺，总和 ≤26 英尺。

**为什么**：超出范围只是走动多，不影响能不能用——所以是提示不是阻断。三点坐标必须来自同一份连通平面，否则算出来的距离是假的。

#### SR-E7　Blind-corner cabinets warn about reach

| | |
|---|---|
| 严重度 | ⚠️ 提示 |
| 由谁执行 | 交付前审核（`layout/ergonomics.ts UNREACHABLE_BLIND_CORNER`） |

**判据**：排到盲角柜（blind corner）时提示客户配拉篮或换转角柜。

**为什么**：盲角深处够不着是这类柜体的固有特性，不是排布错了——但客户要知道，否则装完才发现里面的东西拿不出来。

#### SR-E8　At least one ≥36" continuous prep counter

| | |
|---|---|
| 严重度 | ⚠️ 提示 |
| 由谁执行 | 交付前审核（`layout/ergonomics.ts NO_CONTINUOUS_PREP`） |

**判据**：整段墙上最长的连续台面 ≥36"。

**为什么**：切菜和面需要一块完整的台面。达不到只是不好用，不影响下单。

## 物料与规格

照这份清单下单，东西要能装完整，且每一项都真实存在。

#### SR-M1　BOM has no missing parts

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts BOM_INCOMPLETE`） |

**判据**：BOM 的 missing 为空——踢脚、填缝、收口、连接件都齐。

**为什么**：缺一条踢脚板，客户就是装不上。方案再好看也没用。

#### SR-M2　Only real catalog SKUs and sizes

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts specProblems`） |

**判据**：清单里每个型号 id 与宽/高/深都能在该公司 published 规格里查到。

**为什么**：规格库里不存在的尺寸，定价时会在价格矩阵里查不到而整单拒绝——那时客户看到的只是一句「报价校验未通过」，根因在几百行之外。

#### SR-M3　Disclose assembly forms you do not offer

| | |
|---|---|
| 严重度 | ⚠️ 提示 |
| 由谁执行 | 交付前审核（`delivery/audit.ts UNAPPLIED_PREFERENCE`） |

**判据**：客户选了 assembled 但某些型号只发平板时，逐个列出来。

**为什么**：多数公司只对地柜提供组装服务。不说的话，客户以为整单都是装好的，货到了才发现吊柜要自己拼。

## 报价

客户拿着这个数去比价、去签合同。

#### SR-Q1　Line totals reconcile with subtotal

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts QUOTE_RECONCILIATION`） |

**判据**：报价清单每一行的金额加起来等于小计，小计加税费等于总价。

**为什么**：客户拿去跟别家比，比的是个错数。

#### SR-Q2　Price snapshot recomputes consistently

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts PRICE_SNAPSHOT`） |

**判据**：用快照里的价格表重算一遍，结果与报价单一致。

**为什么**：报价单是要发出去的承诺。价格表改了而快照没跟上，客户手里的单据与系统里的价格对不上。

## 披露与阶段

该说的话真的说了，该客户点头的地方真的等他点了头。

#### SR-D1　Assumed values must be disclosed in customer-facing text

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts UNDISCLOSED_ASSUMPTION`） |

**判据**：任何 provenance = "assumed" 的家电尺寸，都要在交付文字里出现「推定」或等价说明。

**为什么**：查的是**文字，不是数据字段**。`provenance` 存在数据里，但客户读到的是文字——两者可能脱节，而脱节的那一次正是出事的那一次：客户按图订柜，冰箱塞不进去。

#### SR-D2　State customer requests that could not be applied

| | |
|---|---|
| 严重度 | ⚠️ 提示 |
| 由谁执行 | 交付前审核（`delivery/audit.ts UNAPPLIED_PREFERENCE`） |

**判据**：客户的偏好项没能落到排布或报价上时，逐条说明。

**为什么**：「整体看着大气一点」这类话落不到具体参数上。系统要说「这一版与上一版相同」，而不是重画一张一样的图假装改过。

#### SR-D3　Deliverable is allowed at this stage

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts STAGE`） |

**判据**：交付物种类必须在当前 DesignStage 允许的清单里。

**为什么**：客户还没看过全局排布就拿到报价单，等于跳过了他确认的那一步。

#### SR-D4　Quote states which product the price covers

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts UNDISCLOSED_PRODUCT_SCOPE`） |

**判据**：报价清单文字里必须写明：(1) 这是 RTA（板件平装、需要组装、不含安装）；(2) 按的是哪一档箱体板材（商家给了多于一档时）。

**为什么**：客户拿这张单子去跟另一家比。那一家可能报的是全定制、或者是颗粒板箱体——不写清楚，两个数看起来就是同一件东西的两个价，而它们相差可能过半。这不是「客户没问」的问题：他不知道有这两个维度存在，所以问不出来。

## 图纸

客户看图做判断。图上少一个标签，判断依据就少一条。

#### SR-V1　Sink and every appliance opening has a text label

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 渲染层（`render/kernel/annotate.ts annotationFor`） |

**判据**：每张图上，水槽与每个家电位必须有文字标签（型号或名称 + 尺寸）。

**为什么**：只靠颜色区分，客户分不清哪块是冰箱位哪块是烤箱位。

#### SR-V2　Legend matches what is actually drawn

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 渲染层（`render/kernel/legend.ts renderLegend`） |

**判据**：图例只列图上出现过的元素，且图上出现的都在图例里。

**为什么**：图例里有图上没有的东西，客户会在图上找一个不存在的构件；反过来则是看到一个不认识的颜色。

#### SR-V3　Assumed sizes marked "assumed" on drawings

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 渲染层（`render/kernel/annotate.ts annotationFor`） |

**判据**：按常见款猜的家电尺寸，图上的标签要带「（推定）」。

**为什么**：与 SR-D1 同一条原则的图纸侧：等到装不进去才发现就晚了。

#### SR-V4　Disconnected overall plan views must be annotated

| | |
|---|---|
| 严重度 | ⚠️ 提示 |
| 由谁执行 | 交付前审核（`delivery/audit.ts planNoteProblems`） |

**判据**：墙段之间拼不上时，图上注明「示意排列，实际方位请以现场为准」。

**为什么**：推不出方位就不假装知道。但也不能不画——不画客户就什么都看不到。

---

## 审核结论怎么读

`renderAuditText` 把结论写成客户能读的话，每一条都带编号：

```
【这一版还不能用】
  ✗ [SR-E2] 灶具两侧的落台区不足（现为 0" / 57"，需要一侧 ≥15"、另一侧 ≥12"）——这是放置热锅的安全空间

【需要你知道的几点】
  ! [SR-D2] 这面墙的排布评分偏低（48/100）——柜宽跳动或有凑数窄柜，想更整齐的话可以让我再调一版。
```

带编号是为了让结论**可追溯**：客户能查到依据，运营能核对这一条是谁规定的。
没有编号的话，审核结论就只是一句系统自己说的话。

## 加一条规则要做什么

1. 在 `src/delivery/sanity-rules.ts` 的 `SanityRuleId` 里加编号，在 `SANITY_RULES` 里加条目；
2. **真的实现它**——`enforcedBy` 写 `audit` 的，`auditDeliverable` 里必须跑得到；
3. `pnpm sanity:doc` 重新生成本文档；
4. 加测试。`test/sanity-rules.test.ts` 会检查「声明由审核执行的规则，审核确实跑到了」，
   但它证明不了这条规则**判得对**——那需要一个会被它拦下来的用例。
