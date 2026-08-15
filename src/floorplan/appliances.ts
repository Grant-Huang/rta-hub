/**
 * 家电规格 —— 客户提供的**输入**，不是系统写死的常数（APPLIANCES.md 第 2 节）。
 *
 * ## 改造前的两个问题
 *
 * 1. **尺寸写死**：冰箱一律按 36"、灶台 30"、洗碗机 24" 留空。客户的冰箱是
 *    33" + 两侧各 1" 通风 = 35"，按 36" 留就浪费 1"；是 36" 对开门的，按 36"
 *    留就**装不进去**（少了通风间隙）。图是对的，柜子装上去是错的。
 * 2. **从不问**：家电位只在户型图上识别出对应特征（强电/燃气）时才留。
 *    没识别到就**根本不排冰箱位**——而没有哪家厨房是没冰箱的。
 *
 * 家电是客户**已经拥有或已经选定**的东西。它是输入，不是我们替他决定的。
 *
 * ## provenance 是这个模块的重点
 *
 * 客户答「我不确定」是**合法答案**——多数人不知道自己冰箱多宽，逼他量了才能
 * 继续是把系统的困难转嫁给他。但走了默认值就必须**留痕**：
 *
 *   - 图纸解释里如实说「冰箱位按 33" 常见尺寸预留」；
 *   - **由推定值导致的硬约束否决，提示里必须说明它是推定的**——否则客户会
 *     以为自己的厨房真的排不下，而事实可能只是我们猜的尺寸偏大。
 *
 * 把「我们假设了什么」做成**数据**而不是散落在文案里的一句话，才能保证
 * 下游每一处都能读到它。
 */

export type ApplianceKind =
  | "refrigerator" | "range" | "cooktop" | "wallOven"
  | "rangeHood" | "microwave" | "dishwasher";

/** 这个尺寸是客户给的，还是我们推定的。 */
export type Provenance = "customer" | "assumed";

export interface ApplianceSpec {
  kind: ApplianceKind;
  /** 家电本体宽度（英寸）。 */
  width: number;
  /** 每侧需要的通风/开门间隙。留空宽度 = width + 2 × clearanceEachSide。 */
  clearanceEachSide: number;
  /** 客户希望的位置。排布器尽量满足；满足不了要说明，不静默忽略。 */
  preferredZone?: "nearEntry" | "nearSink" | "nearWindow" | "any";
  /** 宽度是客户给的还是推定的——下游解释与硬约束提示都要读它。 */
  provenance: Provenance;
  /**
   * 客户明说这台家电不放在橱柜这面墙（比如放在储藏间/过道的独立空间）。
   * 默认（留空）视为 `"onWall"`。标为 `"elsewhere"` 后，落位与「装不装得下」
   * 的硬约束校验都跳过它——但它仍留在 `appliances` 列表里、仍走
   * provenance 披露链路，不是被悄悄丢掉：客户随时能在已确认面板里看到、改回。
   */
  placement?: "onWall" | "elsewhere";
}

/**
 * 常见尺寸与间隙。
 *
 * 这些数值**只在客户明确说"不确定"时使用**，且用了就标 `provenance: "assumed"`。
 * 它们不是"标准"，只是"最常见"——所以不能拿来覆盖客户给的数。
 */
export const APPLIANCE_DEFAULTS: Record<ApplianceKind, { width: number; clearanceEachSide: number }> = {
  // 33" 是北美最常见的整机宽度（30" 窄款、36" 对开门/法式各占一部分）
  refrigerator: { width: 33, clearanceEachSide: 1 },
  range: { width: 30, clearanceEachSide: 0 },
  // 嵌入式灶台落在**比它宽的柜子**上：台面开孔要留边，开孔切到柜体侧板就废了。
  // 所以它占的墙面宽度是"柜子的宽度"，不是"灶的宽度"——30" 的灶要 33" 的柜。
  cooktop: { width: 30, clearanceEachSide: 1.5 },
  // 单烤箱塔，柜内嵌装，本体两侧无需额外间隙
  wallOven: { width: 30, clearanceEachSide: 0 },
  // 抽油烟机通常与灶台同宽或宽一档
  rangeHood: { width: 30, clearanceEachSide: 0 },
  microwave: { width: 24, clearanceEachSide: 0 },
  dishwasher: { width: 24, clearanceEachSide: 0 },
};

/** 客户可选的常见宽度档位（选择题的选项）。 */
export const COMMON_WIDTHS: Partial<Record<ApplianceKind, number[]>> = {
  refrigerator: [30, 33, 36],
  range: [24, 30, 36],
  cooktop: [30, 36],
  wallOven: [24, 27, 30],
  rangeHood: [30, 36],
  microwave: [24, 30],
  dishwasher: [18, 24],
};

export const APPLIANCE_LABEL_EN: Record<ApplianceKind, string> = {
  refrigerator: "Refrigerator", range: "Range", cooktop: "Cooktop",
  wallOven: "Wall oven", rangeHood: "Range hood",
  microwave: "Microwave", dishwasher: "Dishwasher",
};

export const APPLIANCE_LABEL_ZH: Record<ApplianceKind, string> = {
  refrigerator: "冰箱", range: "灶具", cooktop: "灶台",
  wallOven: "烤箱", rangeHood: "抽油烟机",
  microwave: "微波炉", dishwasher: "洗碗机",
};

/**
 * 客户可见的家电名。问答跟语言偏好；**图纸标注一律用英文**
 * （见 `applianceLabelForDrawing`）。
 */
export const APPLIANCE_LABEL = APPLIANCE_LABEL_EN;

/** 图纸上的家电名——固定英文，无视客户语言偏好。 */
export function applianceLabelForDrawing(kind: ApplianceKind): string {
  return APPLIANCE_LABEL_EN[kind];
}

export function applianceLabel(
  kind: ApplianceKind,
  lang: "en" | "zh" = "en",
): string {
  return lang === "zh" ? APPLIANCE_LABEL_ZH[kind] : APPLIANCE_LABEL_EN[kind];
}

/** 尺寸边界：小于最窄的家用款、大于最宽的商用款都当输入错误处理。 */
const MIN_WIDTH = 12;
const MAX_WIDTH = 60;

export class ApplianceError extends Error {}

/**
 * 从客户的作答构造一份 `ApplianceSpec`。
 *
 * 没给宽度就走默认值并标 `assumed`——**不拒绝**，因为"我不确定"是合法答案，
 * 卡在这里等于逼客户先去量尺寸。
 *
 * @param overlayDefaults FR-22 平台 overlay 对默认宽度的覆盖（客户明示宽度仍优先）。
 */
export function applianceFrom(input: {
  kind: ApplianceKind;
  width?: number | undefined;
  clearanceEachSide?: number | undefined;
  preferredZone?: ApplianceSpec["preferredZone"];
  placement?: ApplianceSpec["placement"];
  language?: "en" | "zh";
}, overlayDefaults?: Partial<Record<ApplianceKind, number>>): ApplianceSpec {
  const lang = input.language ?? "en";
  const d = APPLIANCE_DEFAULTS[input.kind];
  if (!d) {
    throw new ApplianceError(lang === "zh"
      ? `未知的家电类型 ${String(input.kind)}`
      : `Unknown appliance kind ${String(input.kind)}`);
  }

  const defaultWidth = overlayDefaults?.[input.kind] ?? d.width;
  const label = applianceLabel(input.kind, lang);

  if (input.width !== undefined) {
    if (!Number.isFinite(input.width) || input.width < MIN_WIDTH || input.width > MAX_WIDTH) {
      throw new ApplianceError(lang === "zh"
        ? `${label}宽度 ${input.width}" 超出合理范围（${MIN_WIDTH}–${MAX_WIDTH}"）`
        : `${label} width ${input.width}" is outside the allowed range (${MIN_WIDTH}–${MAX_WIDTH}")`);
    }
  }
  const gap = input.clearanceEachSide ?? d.clearanceEachSide;
  if (!Number.isFinite(gap) || gap < 0 || gap > 6) {
    throw new ApplianceError(lang === "zh"
      ? `通风间隙 ${gap}" 不合理（0–6"）`
      : `Clearance ${gap}" is unreasonable (0–6")`);
  }

  return {
    kind: input.kind,
    width: input.width ?? defaultWidth,
    clearanceEachSide: gap,
    ...(input.preferredZone ? { preferredZone: input.preferredZone } : {}),
    ...(input.placement ? { placement: input.placement } : {}),
    provenance: input.width === undefined ? "assumed" : "customer",
  };
}

/** FR-22：按 overlay 生成默认冰箱+灶具+抽油烟机（推定）。 */
export function defaultAssumedAppliances(
  overlayWidths?: Partial<Record<ApplianceKind, number>>,
): ApplianceSpec[] {
  return normalizeAppliances([
    applianceFrom({ kind: "refrigerator" }, overlayWidths),
    applianceFrom({ kind: "range" }, overlayWidths),
  ]);
}

/**
 * 这个家电实际要占的墙面宽度。
 *
 * 通风间隙必须算进去：36" 的对开门冰箱塞进 36" 的空当，门开不了、背后散热不出去。
 */
export function reservedWidth(a: ApplianceSpec): number {
  return a.width + 2 * a.clearanceEachSide;
}

/**
 * 有没有推定值——有的话，下游的解释与否决提示都要跟着变。
 */
export function assumedOnes(appliances: readonly ApplianceSpec[]): ApplianceSpec[] {
  return appliances.filter((a) => a.provenance === "assumed");
}

/**
 * 一句可以直接放进图纸解释的说明。
 *
 * 只在**真的有推定值**时返回内容——与 `explain.ts` 同一条原则：
 * 说的每一句都要对应实际存在的东西。
 */
export function provenanceNote(
  appliances: readonly ApplianceSpec[],
  language: "en" | "zh" = "en",
): string | undefined {
  const assumed = assumedOnes(appliances);
  if (assumed.length === 0) return undefined;
  const parts = assumed.map((a) => language === "zh"
    ? `${APPLIANCE_LABEL_ZH[a.kind]}按 ${a.width}" 预留`
    : `${APPLIANCE_LABEL_EN[a.kind]} reserved at ${a.width}"`);
  if (language === "zh") {
    return `以下尺寸是按常见款推定的（你还没提供实际尺寸）：${parts.join("、")}。` +
      `如果你的实际尺寸不同，这一版要重排。`;
  }
  return `These sizes are assumed from common models (you haven't given actual sizes yet): ${parts.join(", ")}. ` +
    `If your actual sizes differ, this layout needs to be redone.`;
}

/**
 * 给硬约束违规加一句「这里面有推定值」的注脚。
 *
 * **推定值导致的否决必须说明它是推定的**，否则客户会以为自己的厨房真的排不下，
 * 而事实可能只是我们猜的尺寸偏大。
 */
export function violationCaveat(
  appliances: readonly ApplianceSpec[],
  language: "en" | "zh" = "en",
): string | undefined {
  const assumed = assumedOnes(appliances);
  if (assumed.length === 0) return undefined;
  if (language === "zh") {
    return `注意：${assumed.map((a) => `${APPLIANCE_LABEL_ZH[a.kind]}宽度按 ${a.width}" 推定`).join("、")}。` +
      `如果实际尺寸更小，上面这条可能并不成立——把准确尺寸告诉我，我重排一版。`;
  }
  return `Note: ${assumed.map((a) => `${APPLIANCE_LABEL_EN[a.kind]} width assumed at ${a.width}"`).join(", ")}. ` +
    `If the real size is smaller, the issue above may not apply — tell me the exact size and I'll re-layout.`;
}

/**
 * 归一化并去重（同一种家电只留一台）；有灶具没提烟机时**补一台推定的**。
 *
 * 这条是本模块头部原则（"家电是客户已经拥有或已经选定的东西，不是我们替
 * 他决定的"）唯一的例外，例外的理由很直接：现实里几乎没有厨房会装了灶具
 * 却不装抽油烟机（或同类排烟家电），客户不主动提起，多半是因为默认"当然
 * 会有"，而不是真的不需要。既然要补，就按这个模块一贯的规矩来——补的是
 * `provenance: "assumed"`，会走 `assumedOnes`/`provenanceNote`/
 * `violationCaveat` 同一条披露链路，客户能在报价单和图纸说明里看到、
 * 能像其他推定尺寸一样确认或改掉，不是悄悄塞进图里。
 */
export function normalizeAppliances(list: readonly ApplianceSpec[]): ApplianceSpec[] {
  const byKind = new Map<ApplianceKind, ApplianceSpec>();
  for (const a of list) byKind.set(a.kind, a);
  const cooking = byKind.get("range") ?? byKind.get("cooktop");
  if (cooking && !byKind.has("rangeHood")) {
    byKind.set("rangeHood", {
      kind: "rangeHood",
      width: cooking.width,
      clearanceEachSide: APPLIANCE_DEFAULTS.rangeHood.clearanceEachSide,
      provenance: "assumed",
    });
  }
  return [...byKind.values()];
}
