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
  | "SR-G1" | "SR-G2" | "SR-G3" | "SR-G4" | "SR-G5"
  // 人体工程与安全
  | "SR-E1" | "SR-E2" | "SR-E3" | "SR-E4" | "SR-E5" | "SR-E6" | "SR-E7" | "SR-E8"
  // 物料与规格
  | "SR-M1" | "SR-M2" | "SR-M3"
  // 报价
  | "SR-Q1" | "SR-Q2"
  // 披露与阶段
  | "SR-D1" | "SR-D2" | "SR-D3"
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
    id: "SR-G1", title: "构件不超出墙段长度", severity: "blocking",
    criterion: "每个构件的 [x, x+width] 必须落在 [0, run.length] 内。",
    why: "超出墙长的柜子现场装不进去。这是最基本的一条，但它只在单段墙内成立——"
      + "跨墙段的问题要靠 SR-G3。",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts geometryProblems",
  },
  {
    id: "SR-G2", title: "同段墙同一层内构件不重叠", severity: "blocking",
    criterion: "同一 wallRunId、同一 layer 的构件，横向区间与**高度区间**"
      + "不同时相交（容差 0.01\"）。叠装吊柜的上下两段共用一个横向区间、"
      + "靠 `stackBase` 在高度上错开，不算重叠。",
    why: "两个柜子占同一段墙面，装的时候必然有一个放不下。",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts geometryProblems",
  },
  {
    id: "SR-G3", title: "跨墙段构件足迹不重叠", severity: "blocking",
    criterion: "把每个构件放到平面世界坐标（layout/plan-model.ts），"
      + "竖直方向重叠的两个构件（高柜同时占地柜层与吊柜层）足迹不得相交。",
    why: "内墙角处两段墙的柜子会占同一块 24\"×24\"，而它们**不在同一段墙上**——"
      + "SR-G1/G2 的盲区正好在这里。客户的原话：「只有把它们连起来的时候，"
      + "才会发现开关门的问题、干涉的问题」。",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts interferenceProblems",
  },
  {
    id: "SR-G4", title: "门洞旁留出台面外伸的距离", severity: "blocking",
    criterion: "柜体箱体不得侵入门洞的净空区间。净空 = 门洞宽度 + 每侧"
      + "（台面端头外伸 1-1/2\" + 门套线 1\"）；吊柜层没有台面，只让门套线。",
    why: "台面不是柜体的投影，它四周比箱体大出一圈。按柜体判「没超墙」的方案，"
      + "现场台面会压在门套线上，门开到一半就顶住。客户的说法是"
      + "「至少要让出一点点距离」——那一点就是台面外伸。",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts doorClearanceProblems",
  },
  {
    id: "SR-G5", title: "内墙角必须让位或用转角柜", severity: "blocking",
    criterion: "相接的两段墙中，短的那一段在墙角一侧让开「转角方块 24\" + 转角填缝条 3\"」；"
      + "长的那一段拥有墙角，优先排 cornerAccess 型号。",
    why: "不留转角填缝条的话，让位侧的门与抽屉一拉出来就撞上相邻墙柜体的门和拉手——"
      + "两个柜子各自「没超墙」，合起来开不了。",
    enforcedBy: "layout", implementedIn: "layout/plan-model.ts buildKitchenPlan",
  },

  // ── 人体工程与安全（NKBA）──────────────────────────────────────────────
  {
    id: "SR-E1", title: "水槽两侧工作台面 24\" / 18\"", severity: "blocking",
    criterion: "水槽柜两侧连续台面，一侧 ≥24\"、另一侧 ≥18\"。"
      + "洗碗机上方算连续台面（它在台面**底下**）。",
    why: "洗菜、沥水、备餐都要放东西。两侧都不够的厨房用起来处处别扭，"
      + "而这是排布阶段就能避免的。",
    enforcedBy: "audit", implementedIn: "layout/ergonomics.ts SINK_LANDING",
  },
  {
    id: "SR-E2", title: "灶具两侧落台区 15\" / 12\"", severity: "blocking",
    criterion: "灶具/嵌入式灶台两侧连续台面，一侧 ≥15\"、另一侧 ≥12\"。",
    why: "**这是安全要求**：端下来的热锅要有地方放。不够就是烫伤风险，"
      + "不是「用起来不方便」。",
    enforcedBy: "audit", implementedIn: "layout/ergonomics.ts COOKTOP_LANDING",
  },
  {
    id: "SR-E3", title: "冰箱把手侧落台区 ≥15\"", severity: "blocking",
    criterion: "冰箱位任一侧有 ≥15\" 的连续台面。",
    why: "从冰箱里拿出来的东西要有地方搁，否则只能端着走。",
    enforcedBy: "audit", implementedIn: "layout/ergonomics.ts REFRIGERATOR_LANDING",
  },
  {
    id: "SR-E4", title: "洗碗机紧邻水槽（≤36\"）", severity: "blocking",
    criterion: "洗碗机边缘距水槽最近边 ≤36\"。",
    why: "每次装碗都要端着滴水的餐具走一段。",
    enforcedBy: "audit", implementedIn: "layout/ergonomics.ts DISHWASHER_TOO_FAR",
  },
  {
    id: "SR-E5", title: "岛台过道 ≥36\"（建议 42\"）", severity: "blocking",
    criterion: "岛台台面外沿与正对着的柜列台面外沿之间 ≥36\"；<42\" 出提示。"
      + "量的是**台面外沿之间**，不是柜体箱体之间。",
    why: "<36\" 人过不去。按箱体量会算出一条实际上并不存在的合格过道——"
      + "两边台面各外伸 1-1/2\"，正好卡在分界上。",
    enforcedBy: "audit", implementedIn: "layout/ergonomics.ts AISLE_TOO_NARROW",
  },
  {
    id: "SR-E6", title: "工作三角在建议范围内", severity: "advisory",
    criterion: "水槽↔灶具↔冰箱三边各 4-9 英尺，总和 ≤26 英尺。",
    why: "超出范围只是走动多，不影响能不能用——所以是提示不是阻断。"
      + "三点坐标必须来自同一份连通平面，否则算出来的距离是假的。",
    enforcedBy: "audit", implementedIn: "layout/ergonomics.ts WORK_TRIANGLE",
  },
  {
    id: "SR-E7", title: "盲角柜要提示可达性", severity: "advisory",
    criterion: "排到盲角柜（blind corner）时提示客户配拉篮或换转角柜。",
    why: "盲角深处够不着是这类柜体的固有特性，不是排布错了——但客户要知道，"
      + "否则装完才发现里面的东西拿不出来。",
    enforcedBy: "audit", implementedIn: "layout/ergonomics.ts UNREACHABLE_BLIND_CORNER",
  },
  {
    id: "SR-E8", title: "至少一段 ≥36\" 的连续备餐台面", severity: "advisory",
    criterion: "整段墙上最长的连续台面 ≥36\"。",
    why: "切菜和面需要一块完整的台面。达不到只是不好用，不影响下单。",
    enforcedBy: "audit", implementedIn: "layout/ergonomics.ts NO_CONTINUOUS_PREP",
  },

  // ── 物料与规格 ────────────────────────────────────────────────────────
  {
    id: "SR-M1", title: "物料清单不缺件", severity: "blocking",
    criterion: "BOM 的 missing 为空——踢脚、填缝、收口、连接件都齐。",
    why: "缺一条踢脚板，客户就是装不上。方案再好看也没用。",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts BOM_INCOMPLETE",
  },
  {
    id: "SR-M2", title: "只用规格库里真实存在的型号与尺寸", severity: "blocking",
    criterion: "清单里每个型号 id 与宽/高/深都能在该公司 published 规格里查到。",
    why: "规格库里不存在的尺寸，定价时会在价格矩阵里查不到而整单拒绝——"
      + "那时客户看到的只是一句「报价校验未通过」，根因在几百行之外。",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts specProblems",
  },
  {
    id: "SR-M3", title: "不提供的组装形式要说明", severity: "advisory",
    criterion: "客户选了 assembled 但某些型号只发平板时，逐个列出来。",
    why: "多数公司只对地柜提供组装服务。不说的话，客户以为整单都是装好的，"
      + "货到了才发现吊柜要自己拼。",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts UNAPPLIED_PREFERENCE",
  },

  // ── 报价 ─────────────────────────────────────────────────────────────
  {
    id: "SR-Q1", title: "逐行合计与小计一致", severity: "blocking",
    criterion: "报价清单每一行的金额加起来等于小计，小计加税费等于总价。",
    why: "客户拿去跟别家比，比的是个错数。",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts QUOTE_RECONCILIATION",
  },
  {
    id: "SR-Q2", title: "价格快照复算一致", severity: "blocking",
    criterion: "用快照里的价格表重算一遍，结果与报价单一致。",
    why: "报价单是要发出去的承诺。价格表改了而快照没跟上，"
      + "客户手里的单据与系统里的价格对不上。",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts PRICE_SNAPSHOT",
  },

  // ── 披露与阶段 ────────────────────────────────────────────────────────
  {
    id: "SR-D1", title: "推定值必须在交给客户的文字里披露", severity: "blocking",
    criterion: "任何 provenance = \"assumed\" 的家电尺寸，"
      + "都要在交付文字里出现「推定」或等价说明。",
    why: "查的是**文字，不是数据字段**。`provenance` 存在数据里，"
      + "但客户读到的是文字——两者可能脱节，而脱节的那一次正是出事的那一次："
      + "客户按图订柜，冰箱塞不进去。",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts UNDISCLOSED_ASSUMPTION",
  },
  {
    id: "SR-D2", title: "客户提了但落不下去的要求要说明", severity: "advisory",
    criterion: "客户的偏好项没能落到排布或报价上时，逐条说明。",
    why: "「整体看着大气一点」这类话落不到具体参数上。系统要说「这一版与上一版相同」，"
      + "而不是重画一张一样的图假装改过。",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts UNAPPLIED_PREFERENCE",
  },
  {
    id: "SR-D3", title: "这个阶段该不该出这份东西", severity: "blocking",
    criterion: "交付物种类必须在当前 DesignStage 允许的清单里。",
    why: "客户还没看过全局排布就拿到报价单，等于跳过了他确认的那一步。",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts STAGE",
  },

  // ── 图纸 ─────────────────────────────────────────────────────────────
  {
    id: "SR-V1", title: "水槽与每个家电位都有文字标签", severity: "blocking",
    criterion: "每张图上，水槽与每个家电位必须有文字标签（型号或名称 + 尺寸）。",
    why: "只靠颜色区分，客户分不清哪块是冰箱位哪块是烤箱位。",
    enforcedBy: "render", implementedIn: "render/kernel/annotate.ts annotationFor",
  },
  {
    id: "SR-V2", title: "图例与图上实际画出的元素一致", severity: "blocking",
    criterion: "图例只列图上出现过的元素，且图上出现的都在图例里。",
    why: "图例里有图上没有的东西，客户会在图上找一个不存在的构件；"
      + "反过来则是看到一个不认识的颜色。",
    enforcedBy: "render", implementedIn: "render/kernel/legend.ts renderLegend",
  },
  {
    id: "SR-V3", title: "推定尺寸在图上标「推定」", severity: "blocking",
    criterion: "按常见款猜的家电尺寸，图上的标签要带「（推定）」。",
    why: "与 SR-D1 同一条原则的图纸侧：等到装不进去才发现就晚了。",
    enforcedBy: "render", implementedIn: "render/kernel/annotate.ts annotationFor",
  },
  {
    id: "SR-V4", title: "全局俯视图连不起来时必须标注", severity: "advisory",
    criterion: "墙段之间拼不上时，图上注明「示意排列，实际方位请以现场为准」。",
    why: "推不出方位就不假装知道。但也不能不画——不画客户就什么都看不到。",
    enforcedBy: "audit", implementedIn: "delivery/audit.ts planNoteProblems",
  },
];

const BY_ID = new Map(SANITY_RULES.map((r) => [r.id, r]));

export function ruleFor(id: SanityRuleId): SanityRule {
  const rule = BY_ID.get(id);
  // 编号是联合类型，取不到只可能是表本身漏了一条——早点炸，别静默返回 undefined
  if (!rule) throw new Error(`合理性规则 ${id} 不在 SANITY_RULES 里`);
  return rule;
}

/** 由交付前审核执行的那些。`auditDeliverable` 必须每一条都真的跑到。 */
export function auditEnforcedRules(): SanityRule[] {
  return SANITY_RULES.filter((r) => r.enforcedBy === "audit");
}
