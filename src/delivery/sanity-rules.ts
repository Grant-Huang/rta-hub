/**
 * 合理性审查规则表 —— **文档与执行同源的那一份**。
 *
 * ## 为什么规则要单独列成一张表
 *
 * 交付前的检查散在四五个模块里：`ergonomics.ts` 判净空、`bom.ts` 判缺不缺料、
 * `validation.ts` 判型号在不在规格库里、`audit.ts` 把它们汇总。每一处都能跑，
 * 但**没有任何一处回答得了「一份方案要过哪些关」**——要回答这个问题，
 * 得把五个文件读一遍，而且读完还不确定有没有漏。
 *
 * 于是产生两种事故，都很难发现：
 *
 *   - 规则写在文档里，代码里没有对应实现（"我们检查了"其实没检查）；
 *   - 代码里加了检查，文档没更新（客户被拦下来，翻遍文档找不到依据）。
 *
 * 这张表把两边钉死：**`docs/SANITY_RULES.md` 的每一条都必须在这里出现，
 * 反过来也一样**（`test/sanity-rules.test.ts` 逐条比对）。改规则只改一处。
 *
 * ## 严重度只有两档，不设权重
 *
 * 与 FR-4.1 的三层结构同源：`blocking` 一条都不放行、不参与权衡——任何权重
 * 都能被"其他方面都很好"投票压过去，而一份缺料的报价单不会因为方案好看
 * 就变得能用。`advisory` 不拦，但**必须显示给客户**：它们是交付物的一部分，
 * 不是服务端日志。
 *
 * ## `enforcedBy` 是一句承诺
 *
 * 每条规则都写明**谁执行**。写 `audit` 的，`auditDeliverable` 必须真的跑到；
 * 写别的层的，那一层必须真的有断言。没人执行的规则不许留在表里——
 * 那正是"我们检查了"其实没检查的来源。
 */

/** 规则编号。与 `docs/SANITY_RULES.md` 的小节号一一对应。 */
export type SanityRuleId =
  // 几何与干涉
  | "SR-G1" | "SR-G2" | "SR-G3" | "SR-G4" | "SR-G5" | "SR-G6"
  // 人体工程与安全
  | "SR-E1" | "SR-E2" | "SR-E3" | "SR-E4" | "SR-E5" | "SR-E6" | "SR-E7" | "SR-E8"
  // 物料与规格
  | "SR-M1" | "SR-M2" | "SR-M3"
  // 报价
  | "SR-Q1" | "SR-Q2"
  // 披露与阶段
  | "SR-D1" | "SR-D2" | "SR-D3" | "SR-D4"
  // 图纸
  | "SR-V1" | "SR-V2" | "SR-V3" | "SR-V4";

export type SanitySeverity = "blocking" | "advisory";

/**
 * 这条规则由哪一层执行。
 *
 * `audit` = 交付前审核闸门（`auditDeliverable`），是唯一能**拦住交付**的地方；
 * 其余几层在更早的位置把问题挡掉，审核只是最后一道复核。
 */
export type EnforcedBy = "audit" | "layout" | "render" | "pricing";

export interface SanityRule {
  id: SanityRuleId;
  /** 一句话说清查什么。客户看得懂的话，不是实现细节。 */
  title: string;
  severity: SanitySeverity;
  /** 判据——具体到能照着写断言。 */
  criterion: string;
  /** 为什么要有这条。不写清楚的话，下一个人会以为它可以放宽。 */
  why: string;
  enforcedBy: EnforcedBy;
  /** 执行它的那段代码。审核时报出来，方便定位。 */
  implementedIn: string;
}

export const SANITY_RULES: readonly SanityRule[] = [
  // ── 几何与干涉 ────────────────────────────────────────────────────────
  {
    id: "SR-G1", title: "Components stay within wall-run length", severity: "blocking",
    criterion: "Each component's [x, x+width] must fall within [0, run.length].",
    why: "A cabinet that overhangs the wall run cannot be installed on site. This is the most basic rule, but it only holds within a single wall run—"
      + "cross-run issues are covered by SR-G3.",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts geometryProblems",
  },
  {
    id: "SR-G2", title: "No overlap within the same wall run and layer", severity: "blocking",
    criterion: "Components on the same wallRunId and layer must not have both horizontal and height intervals "
      + "intersecting at once (0.01\" tolerance). Stacked wall cabinets that share a horizontal span but are "
      + "offset in height via `stackBase` do not count as overlapping.",
    why: "Two cabinets occupying the same wall face means one of them cannot fit at install time.",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts geometryProblems",
  },
  {
    id: "SR-G3", title: "No overlapping footprints across wall runs", severity: "blocking",
    criterion: "Place each component in plan-world coordinates (layout/plan-model.ts); "
      + "two components that overlap vertically (e.g. a tall cabinet that occupies both base and wall layers) must not have intersecting footprints.",
    why: "At an inside corner, cabinets on two wall runs can claim the same 24\"×24\" square even though they are not on the same run—"
      + "exactly the blind spot of SR-G1/G2. Customers discover door-swing and interference problems only when the runs are joined.",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts interferenceProblems",
  },
  {
    id: "SR-G4", title: "Clearance beside openings for countertop overhang", severity: "blocking",
    criterion: "Cabinet boxes must not intrude into the door opening's clear span. Clear span = opening width + on each side "
      + "(countertop end overhang 1-1/2\" + casing 1\"); wall layers have no countertop, so only casing applies.",
    why: "A countertop is not a cabinet projection—it overhangs the box on all sides. A layout that looks \"within the wall\" by box geometry "
      + "can still put the countertop onto the casing so the door stops mid-swing. That \"little bit of space\" customers ask for is the overhang.",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts doorClearanceProblems",
  },
  {
    id: "SR-G5", title: "Inside corners must yield or use a corner cabinet", severity: "blocking",
    criterion: "Of two adjoining wall runs, the shorter run yields on the corner side by \"corner block 24\" + corner filler 3\"\"; "
      + "the longer run owns the corner and prefers a cornerAccess SKU.",
    why: "Without a corner filler, doors and drawers on the yielding side hit the adjacent run's doors and pulls as soon as they open—"
      + "each cabinet \"stays within its wall,\" but together they cannot open.",
    enforcedBy: "layout", implementedIn: "layout/plan-model.ts buildKitchenPlan",
  },
  {
    id: "SR-G6", title: "Tall appliances clear door and window openings", severity: "blocking",
    criterion: "Refrigerator and wall-oven openings must not overlap a door clear span (same as SR-G4) or a window opening on the same wall run.",
    why: "A fridge under a window or into a doorway looks fine in a 2D base-only sketch but is unbuildable: "
      + "the box blocks the sash or the door swing. Layout placement must refuse the spot; audit is the exit check.",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts tallApplianceOpeningProblems",
  },

  // ── 人体工程与安全（NKBA）──────────────────────────────────────────────
  {
    id: "SR-E1", title: "Sink landing zones 24\" / 18\"", severity: "blocking",
    criterion: "Continuous countertop on both sides of the sink cabinet: one side ≥24\", the other ≥18\". "
      + "Countertop above a dishwasher counts as continuous (it sits under the countertop).",
    why: "Washing, draining, and prep all need a place to set things down. A kitchen short on both sides is awkward in daily use—"
      + "and this is avoidable at layout time.",
    enforcedBy: "audit", implementedIn: "layout/ergonomics.ts SINK_LANDING",
  },
  {
    id: "SR-E2", title: "Cooktop landing zones 15\" / 12\"", severity: "blocking",
    criterion: "Continuous countertop on both sides of a range/cooktop: one side ≥15\", the other ≥12\".",
    why: "This is a safety requirement: a hot pan needs somewhere to land. Falling short is a burn risk, "
      + "not merely inconvenience.",
    enforcedBy: "audit", implementedIn: "layout/ergonomics.ts COOKTOP_LANDING",
  },
  {
    id: "SR-E3", title: "Refrigerator landing ≥15\" on handle side", severity: "blocking",
    criterion: "At least one side of the fridge opening has ≥15\" of continuous countertop.",
    why: "Items leaving the fridge need a place to rest, otherwise they have to be carried.",
    enforcedBy: "audit", implementedIn: "layout/ergonomics.ts REFRIGERATOR_LANDING",
  },
  {
    id: "SR-E4", title: "Dishwasher adjacent to sink (≤36\")", severity: "blocking",
    criterion: "Distance from dishwasher edge to nearest sink edge ≤36\".",
    why: "Every load means carrying dripping dishes across a gap.",
    enforcedBy: "audit", implementedIn: "layout/ergonomics.ts DISHWASHER_TOO_FAR",
  },
  {
    id: "SR-E5", title: "Island aisle ≥36\" (prefer 42\")", severity: "blocking",
    criterion: "Distance between island countertop outer edge and facing run countertop outer edge ≥36\"; warn if <42\". "
      + "Measure between countertop outer edges, not box faces.",
    why: "<36\" is impassable. Measuring boxes invents a clear aisle that does not exist—"
      + "each side overhangs 1-1/2\", which lands exactly on the boundary.",
    enforcedBy: "audit", implementedIn: "layout/ergonomics.ts AISLE_TOO_NARROW",
  },
  {
    id: "SR-E6", title: "Work triangle within recommended range", severity: "advisory",
    criterion: "Each leg sink↔cooktop↔fridge is 4–9 ft; total ≤26 ft.",
    why: "Out of range only means more walking—it does not block usability, so this is advisory. "
      + "The three points must come from one connected plan, or the distances are fictional.",
    enforcedBy: "audit", implementedIn: "layout/ergonomics.ts WORK_TRIANGLE",
  },
  {
    id: "SR-E7", title: "Blind-corner cabinets warn about reach", severity: "advisory",
    criterion: "When a blind-corner cabinet is placed, advise the customer to add a pull-out or switch to a corner cabinet.",
    why: "Deep blind corners are inherent to the SKU, not a layout mistake—but customers need to know, "
      + "or they discover contents are unreachable after install.",
    enforcedBy: "audit", implementedIn: "layout/ergonomics.ts UNREACHABLE_BLIND_CORNER",
  },
  {
    id: "SR-E8", title: "At least one ≥36\" continuous prep counter", severity: "advisory",
    criterion: "Longest continuous countertop along any wall run ≥36\".",
    why: "Chopping and dough need an unbroken stretch. Falling short is inconvenience, not an order blocker.",
    enforcedBy: "audit", implementedIn: "layout/ergonomics.ts NO_CONTINUOUS_PREP",
  },

  // ── 物料与规格 ────────────────────────────────────────────────────────
  {
    id: "SR-M1", title: "BOM has no missing parts", severity: "blocking",
    criterion: "BOM `missing` is empty—toe kicks, fillers, moldings, and connectors are all present.",
    why: "One missing toe kick and the customer cannot install. Looks do not matter then.",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts BOM_INCOMPLETE",
  },
  {
    id: "SR-M2", title: "Only real catalog SKUs and sizes", severity: "blocking",
    criterion: "Every SKU id and width/height/depth on the list exists in that company's published catalog.",
    why: "A size not in the catalog fails the price matrix and rejects the whole quote—"
      + "the customer only sees \"quote validation failed,\" with the root cause hundreds of lines away.",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts specProblems",
  },
  {
    id: "SR-M3", title: "Disclose assembly forms you do not offer", severity: "advisory",
    criterion: "If the customer chose assembled but some SKUs ship flat-pack only, list each one.",
    why: "Most companies assemble base cabinets only. Without disclosure, the customer assumes the whole order arrives built, "
      + "then finds wall cabinets need assembly.",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts UNAPPLIED_PREFERENCE",
  },

  // ── 报价 ─────────────────────────────────────────────────────────────
  {
    id: "SR-Q1", title: "Line totals reconcile with subtotal", severity: "blocking",
    criterion: "Sum of each quote line equals the subtotal; subtotal plus tax/fees equals the total.",
    why: "Customers compare quotes against competitors using a wrong number.",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts QUOTE_RECONCILIATION",
  },
  {
    id: "SR-Q2", title: "Price snapshot recomputes consistently", severity: "blocking",
    criterion: "Recompute with the snapshot price table; result must match the quote.",
    why: "A quote is a commitment you send out. If the price table changed and the snapshot did not follow, "
      + "the customer's document disagrees with system prices.",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts PRICE_SNAPSHOT",
  },

  // ── 披露与阶段 ────────────────────────────────────────────────────────
  {
    id: "SR-D1", title: "Assumed values must be disclosed in customer-facing text", severity: "blocking",
    criterion: "Any appliance size with provenance = \"assumed\" "
      + "must appear in deliverable text with \"assumed\" or an equivalent disclosure.",
    why: "We check the text, not a data field. `provenance` lives in data, "
      + "but customers read words—those can diverge, and divergence is when things go wrong: "
      + "cabinets ordered to the drawing, fridge will not fit.",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts UNDISCLOSED_ASSUMPTION",
  },
  {
    id: "SR-D2", title: "State customer requests that could not be applied", severity: "advisory",
    criterion: "When a preference does not land on the layout or quote, explain each one.",
    why: "Vague asks like \"make it feel more spacious\" do not map to parameters. The system should say \"this revision matches the last,\" "
      + "not redraw the same plan and pretend it changed.",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts UNAPPLIED_PREFERENCE",
  },
  {
    id: "SR-D3", title: "Deliverable is allowed at this stage", severity: "blocking",
    criterion: "Deliverable kind must be on the current DesignStage allow-list.",
    why: "Handing a quote before the customer has reviewed the overall layout skips the confirmation step they need.",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts STAGE",
  },
  {
    id: "SR-D4", title: "Quote states which product the price covers", severity: "blocking",
    criterion: "Quote text must state: (1) this is RTA (flat-pack panels, assembly required, install not included); "
      + "(2) which box-material tier applies (when the merchant offers more than one).",
    why: "Customers compare this sheet to another shop that may quote fully custom or particle-board boxes—"
      + "without disclosure the two numbers look like two prices for the same thing, and they can differ by more than half. "
      + "This is not \"the customer didn't ask\": they cannot ask about dimensions they do not know exist.",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts UNDISCLOSED_PRODUCT_SCOPE",
  },

  // ── 图纸 ─────────────────────────────────────────────────────────────
  {
    id: "SR-V1", title: "Sink and every appliance opening has a text label", severity: "blocking",
    criterion: "On every drawing, the sink and each appliance opening must have a text label (SKU or name + size).",
    why: "Color alone does not tell the customer which block is the fridge vs the oven.",
    enforcedBy: "render", implementedIn: "render/kernel/annotate.ts annotationFor",
  },
  {
    id: "SR-V2", title: "Legend matches what is actually drawn", severity: "blocking",
    criterion: "The legend lists only elements that appear on the drawing, and every drawn element appears in the legend.",
    why: "A legend entry with nothing on the drawing sends the customer hunting for a missing piece; "
      + "the reverse leaves an unrecognized color.",
    enforcedBy: "render", implementedIn: "render/kernel/legend.ts renderLegend",
  },
  {
    id: "SR-V3", title: "Assumed sizes marked \"assumed\" on drawings", severity: "blocking",
    criterion: "Appliance sizes guessed from common models must carry \"(assumed)\" on the drawing label.",
    why: "Same principle as SR-D1 on the drawing side: discovering a fit problem at install is too late.",
    enforcedBy: "render", implementedIn: "render/kernel/annotate.ts annotationFor",
  },
  {
    id: "SR-V4", title: "Disconnected overall plan views must be annotated", severity: "advisory",
    criterion: "When wall runs cannot be joined, the drawing notes \"schematic arrangement; verify orientation on site.\"",
    why: "If orientation cannot be inferred, do not pretend to know it—but still draw something, or the customer sees nothing.",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts planNoteProblems",
  },
];

const BY_ID = new Map(SANITY_RULES.map((r) => [r.id, r]));

export function ruleFor(id: SanityRuleId): SanityRule {
  const rule = BY_ID.get(id);
  // 编号是联合类型，取不到只可能是表本身漏了一条——早点炸，别静默返回 undefined
  if (!rule) throw new Error(`Sanity rule ${id} is not in SANITY_RULES`);
  return rule;
}

/** 由交付前审核执行的那些。`auditDeliverable` 必须每一条都真的跑到。 */
export function auditEnforcedRules(): SanityRule[] {
  return SANITY_RULES.filter((r) => r.enforcedBy === "audit");
}
