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

当前共 27 条：阻断 21 条、提示 6 条。

## 速查表

| 编号 | 规则 | 严重度 | 由谁执行 |
|---|---|---|---|
| SR-G1 | Components stay within wall-run length | 🚫 阻断 | 交付前审核 |
| SR-G2 | No overlap within the same wall run and layer | 🚫 阻断 | 交付前审核 |
| SR-G3 | No overlapping footprints across wall runs | 🚫 阻断 | 交付前审核 |
| SR-G4 | Clearance beside openings for countertop overhang | 🚫 阻断 | 交付前审核 |
| SR-G5 | Inside corners must yield or use a corner cabinet | 🚫 阻断 | 排布层 |
| SR-G6 | Tall appliances clear door and window openings | 🚫 阻断 | 交付前审核 |
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

**判据**：Each component's [x, x+width] must fall within [0, run.length].

**为什么**：A cabinet that overhangs the wall run cannot be installed on site. This is the most basic rule, but it only holds within a single wall run—cross-run issues are covered by SR-G3.

#### SR-G2　No overlap within the same wall run and layer

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts geometryProblems`） |

**判据**：Components on the same wallRunId and layer must not have both horizontal and height intervals intersecting at once (0.01" tolerance). Stacked wall cabinets that share a horizontal span but are offset in height via `stackBase` do not count as overlapping.

**为什么**：Two cabinets occupying the same wall face means one of them cannot fit at install time.

#### SR-G3　No overlapping footprints across wall runs

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts interferenceProblems`） |

**判据**：Place each component in plan-world coordinates (layout/plan-model.ts); two components that overlap vertically (e.g. a tall cabinet that occupies both base and wall layers) must not have intersecting footprints.

**为什么**：At an inside corner, cabinets on two wall runs can claim the same 24"×24" square even though they are not on the same run—exactly the blind spot of SR-G1/G2. Customers discover door-swing and interference problems only when the runs are joined.

#### SR-G4　Clearance beside openings for countertop overhang

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts doorClearanceProblems`） |

**判据**：Cabinet boxes must not intrude into the door opening's clear span. Clear span = opening width + on each side (countertop end overhang 1-1/2" + casing 1"); wall layers have no countertop, so only casing applies.

**为什么**：A countertop is not a cabinet projection—it overhangs the box on all sides. A layout that looks "within the wall" by box geometry can still put the countertop onto the casing so the door stops mid-swing. That "little bit of space" customers ask for is the overhang.

#### SR-G5　Inside corners must yield or use a corner cabinet

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 排布层（`layout/plan-model.ts buildKitchenPlan`） |

**判据**：Of two adjoining wall runs, the shorter run yields on the corner side by "corner block 24" + corner filler 3""; the longer run owns the corner and prefers a cornerAccess SKU.

**为什么**：Without a corner filler, doors and drawers on the yielding side hit the adjacent run's doors and pulls as soon as they open—each cabinet "stays within its wall," but together they cannot open.

#### SR-G6　Tall appliances clear door and window openings

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts tallApplianceOpeningProblems`） |

**判据**：Refrigerator and wall-oven openings must not overlap a door clear span (same as SR-G4) or a window opening on the same wall run.

**为什么**：A fridge under a window or into a doorway looks fine in a 2D base-only sketch but is unbuildable: the box blocks the sash or the door swing. Layout placement must refuse the spot; audit is the exit check.

## 人体工程与安全

NKBA 厨房规划指南的常见表述。⚠️ **这是种子数据，上线前必须核对现行版本**（见 PRE_LAUNCH_CHECKLIST）。

#### SR-E1　Sink landing zones 24" / 18"

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`layout/ergonomics.ts SINK_LANDING`） |

**判据**：Continuous countertop on both sides of the sink cabinet: one side ≥24", the other ≥18". Countertop above a dishwasher counts as continuous (it sits under the countertop).

**为什么**：Washing, draining, and prep all need a place to set things down. A kitchen short on both sides is awkward in daily use—and this is avoidable at layout time.

#### SR-E2　Cooktop landing zones 15" / 12"

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`layout/ergonomics.ts COOKTOP_LANDING`） |

**判据**：Continuous countertop on both sides of a range/cooktop: one side ≥15", the other ≥12".

**为什么**：This is a safety requirement: a hot pan needs somewhere to land. Falling short is a burn risk, not merely inconvenience.

#### SR-E3　Refrigerator landing ≥15" on handle side

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`layout/ergonomics.ts REFRIGERATOR_LANDING`） |

**判据**：At least one side of the fridge opening has ≥15" of continuous countertop.

**为什么**：Items leaving the fridge need a place to rest, otherwise they have to be carried.

#### SR-E4　Dishwasher adjacent to sink (≤36")

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`layout/ergonomics.ts DISHWASHER_TOO_FAR`） |

**判据**：Distance from dishwasher edge to nearest sink edge ≤36".

**为什么**：Every load means carrying dripping dishes across a gap.

#### SR-E5　Island aisle ≥36" (prefer 42")

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`layout/ergonomics.ts AISLE_TOO_NARROW`） |

**判据**：Distance between island countertop outer edge and facing run countertop outer edge ≥36"; warn if <42". Measure between countertop outer edges, not box faces.

**为什么**：<36" is impassable. Measuring boxes invents a clear aisle that does not exist—each side overhangs 1-1/2", which lands exactly on the boundary.

#### SR-E6　Work triangle within recommended range

| | |
|---|---|
| 严重度 | ⚠️ 提示 |
| 由谁执行 | 交付前审核（`layout/ergonomics.ts WORK_TRIANGLE`） |

**判据**：Each leg sink↔cooktop↔fridge is 4–9 ft; total ≤26 ft.

**为什么**：Out of range only means more walking—it does not block usability, so this is advisory. The three points must come from one connected plan, or the distances are fictional.

#### SR-E7　Blind-corner cabinets warn about reach

| | |
|---|---|
| 严重度 | ⚠️ 提示 |
| 由谁执行 | 交付前审核（`layout/ergonomics.ts UNREACHABLE_BLIND_CORNER`） |

**判据**：When a blind-corner cabinet is placed, advise the customer to add a pull-out or switch to a corner cabinet.

**为什么**：Deep blind corners are inherent to the SKU, not a layout mistake—but customers need to know, or they discover contents are unreachable after install.

#### SR-E8　At least one ≥36" continuous prep counter

| | |
|---|---|
| 严重度 | ⚠️ 提示 |
| 由谁执行 | 交付前审核（`layout/ergonomics.ts NO_CONTINUOUS_PREP`） |

**判据**：Longest continuous countertop along any wall run ≥36".

**为什么**：Chopping and dough need an unbroken stretch. Falling short is inconvenience, not an order blocker.

## 物料与规格

照这份清单下单，东西要能装完整，且每一项都真实存在。

#### SR-M1　BOM has no missing parts

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts BOM_INCOMPLETE`） |

**判据**：BOM `missing` is empty—toe kicks, fillers, moldings, and connectors are all present.

**为什么**：One missing toe kick and the customer cannot install. Looks do not matter then.

#### SR-M2　Only real catalog SKUs and sizes

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts specProblems`） |

**判据**：Every SKU id and width/height/depth on the list exists in that company's published catalog.

**为什么**：A size not in the catalog fails the price matrix and rejects the whole quote—the customer only sees "quote validation failed," with the root cause hundreds of lines away.

#### SR-M3　Disclose assembly forms you do not offer

| | |
|---|---|
| 严重度 | ⚠️ 提示 |
| 由谁执行 | 交付前审核（`delivery/audit.ts UNAPPLIED_PREFERENCE`） |

**判据**：If the customer chose assembled but some SKUs ship flat-pack only, list each one.

**为什么**：Most companies assemble base cabinets only. Without disclosure, the customer assumes the whole order arrives built, then finds wall cabinets need assembly.

## 报价

客户拿着这个数去比价、去签合同。

#### SR-Q1　Line totals reconcile with subtotal

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts QUOTE_RECONCILIATION`） |

**判据**：Sum of each quote line equals the subtotal; subtotal plus tax/fees equals the total.

**为什么**：Customers compare quotes against competitors using a wrong number.

#### SR-Q2　Price snapshot recomputes consistently

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts PRICE_SNAPSHOT`） |

**判据**：Recompute with the snapshot price table; result must match the quote.

**为什么**：A quote is a commitment you send out. If the price table changed and the snapshot did not follow, the customer's document disagrees with system prices.

## 披露与阶段

该说的话真的说了，该客户点头的地方真的等他点了头。

#### SR-D1　Assumed values must be disclosed in customer-facing text

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts UNDISCLOSED_ASSUMPTION`） |

**判据**：Any appliance size with provenance = "assumed" must appear in deliverable text with "assumed" or an equivalent disclosure.

**为什么**：We check the text, not a data field. `provenance` lives in data, but customers read words—those can diverge, and divergence is when things go wrong: cabinets ordered to the drawing, fridge will not fit.

#### SR-D2　State customer requests that could not be applied

| | |
|---|---|
| 严重度 | ⚠️ 提示 |
| 由谁执行 | 交付前审核（`delivery/audit.ts UNAPPLIED_PREFERENCE`） |

**判据**：When a preference does not land on the layout or quote, explain each one.

**为什么**：Vague asks like "make it feel more spacious" do not map to parameters. The system should say "this revision matches the last," not redraw the same plan and pretend it changed.

#### SR-D3　Deliverable is allowed at this stage

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts STAGE`） |

**判据**：Deliverable kind must be on the current DesignStage allow-list.

**为什么**：Handing a quote before the customer has reviewed the overall layout skips the confirmation step they need.

#### SR-D4　Quote states which product the price covers

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 交付前审核（`delivery/audit.ts UNDISCLOSED_PRODUCT_SCOPE`） |

**判据**：Quote text must state: (1) this is RTA (flat-pack panels, assembly required, install not included); (2) which box-material tier applies (when the merchant offers more than one).

**为什么**：Customers compare this sheet to another shop that may quote fully custom or particle-board boxes—without disclosure the two numbers look like two prices for the same thing, and they can differ by more than half. This is not "the customer didn't ask": they cannot ask about dimensions they do not know exist.

## 图纸

客户看图做判断。图上少一个标签，判断依据就少一条。

#### SR-V1　Sink and every appliance opening has a text label

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 渲染层（`render/kernel/annotate.ts annotationFor`） |

**判据**：On every drawing, the sink and each appliance opening must have a text label (SKU or name + size).

**为什么**：Color alone does not tell the customer which block is the fridge vs the oven.

#### SR-V2　Legend matches what is actually drawn

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 渲染层（`render/kernel/legend.ts renderLegend`） |

**判据**：The legend lists only elements that appear on the drawing, and every drawn element appears in the legend.

**为什么**：A legend entry with nothing on the drawing sends the customer hunting for a missing piece; the reverse leaves an unrecognized color.

#### SR-V3　Assumed sizes marked "assumed" on drawings

| | |
|---|---|
| 严重度 | 🚫 阻断 |
| 由谁执行 | 渲染层（`render/kernel/annotate.ts annotationFor`） |

**判据**：Appliance sizes guessed from common models must carry "(assumed)" on the drawing label.

**为什么**：Same principle as SR-D1 on the drawing side: discovering a fit problem at install is too late.

#### SR-V4　Disconnected overall plan views must be annotated

| | |
|---|---|
| 严重度 | ⚠️ 提示 |
| 由谁执行 | 交付前审核（`delivery/audit.ts planNoteProblems`） |

**判据**：When wall runs cannot be joined, the drawing notes "schematic arrangement; verify orientation on site."

**为什么**：If orientation cannot be inferred, do not pretend to know it—but still draw something, or the customer sees nothing.

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
