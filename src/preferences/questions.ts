/**
 * 价格与偏好的**选择式提问** —— FR-1 的补强。
 *
 * 起因：总控助手原来只会开放式提问（"预算大概多少？""喜欢什么风格？"）。
 * 客户不是行业内人士，答不上来"预算多少"很正常——他不知道一套橱柜该是多少钱，
 * 也不知道 shaker 和 raised panel 差多少。开放式提问把不该由客户承担的信息负担
 * 推给了客户。
 *
 * 改法：把这些问题变成**带选项、带价格影响的选择题**。
 *
 * ## 两条硬规则
 *
 * 1. **选项只能来自该公司真实的规格库。** 不存在的门板样式、这家公司不提供的五金，
 *    一律不出现在选项里——否则客户选了一个买不到的东西。
 * 2. **价格影响一律由代码从价格矩阵算出，LLM 不参与。** 这是 FR-8 在新界面上的延续：
 *    模型可以润色措辞，但"贵 18%"这个数字必须是算的。算不出来就如实写"价格待确认"，
 *    不猜。
 */
import { format, fromCents, mulQty, percentOf, type Money } from "../domain/money.js";
import type {
  AccessoryOption, AssemblyOption, CompanyPreferences, GenericCatalog, HardwareOption,
  Modifier, ModuleSpec, SharedPreferences,
} from "../domain/types.js";
import type { SpecBundle } from "../spec/bundle.js";
import { hasRole } from "../spec/capabilities.js";
import {
  APPLIANCE_LABEL, COMMON_WIDTHS, type ApplianceKind, type ApplianceSpec,
} from "../floorplan/appliances.js";

export type PreferenceKey =
  | "budgetBand"
  | "doorStyle"
  | "assembly"
  | "storage"
  | "hardware"
  | "accessories"
  | "tradeoff"
  /** 厨房里有哪些家电（多选）。 */
  | "appliances"
  /** 各个家电多宽。答"不确定"合法，走推定值并留痕（见 floorplan/appliances.ts）。 */
  | "applianceWidths";

/** 价格影响。分三种，因为能算准的程度本来就不同——不把估算伪装成精确值。 */
export type PriceImpact =
  | { kind: "included" }
  | { kind: "perCabinet"; amount: Money }
  | { kind: "percentOfList"; percent: number }
  | { kind: "relativeToCheapest"; percent: number }
  | { kind: "range"; low: Money; high: Money }
  | { kind: "unknown"; reason: string };

export interface PreferenceOption {
  /** 真实实体 id（doorStyleId / hardwareOptionId…）或枚举值。 */
  id: string;
  label: string;
  detail?: string;
  priceImpact: PriceImpact;
  /** 已格式化、可直接展示的价格说明。 */
  priceNote: string;
  recommended?: boolean;
}

export interface PreferenceQuestion {
  key: PreferenceKey;
  prompt: string;
  /** 为什么问这个——让客户知道自己的选择会影响什么，而不是盲答。 */
  why: string;
  multiSelect: boolean;
  options: PreferenceOption[];
  /** 可以跳过（有合理默认值）。预算这类问题不该强制。 */
  skippable: boolean;
}

/**
 * **解析后**的偏好视图 —— 跨公司通用项 + 当前这家公司的项，合成一份。
 *
 * 存储时是分开的（见 `Conversation.preferences`），因为门板/五金/配件的 id
 * 只在某家公司的规格库里有意义；但下游（出题、排布、报价）需要的是合成后的一份。
 */
export interface CustomerPreferences extends SharedPreferences, CompanyPreferences {}

/** 把分开存的两部分合成下游要用的一份。 */
export function resolvePreferences(
  shared: SharedPreferences | undefined,
  company: CompanyPreferences | undefined,
): CustomerPreferences {
  return { ...(shared ?? {}), ...(company ?? {}) };
}

// ── 价格影响的格式化 ──────────────────────────────────────────────────────

export function describeImpact(impact: PriceImpact): string {
  switch (impact.kind) {
    case "included":
      return "已含在基础价内";
    case "perCabinet":
      return `每个柜体 +${format(impact.amount)}`;
    case "percentOfList":
      return `适用柜体标价 +${impact.percent}%`;
    case "relativeToCheapest":
      return impact.percent === 0
        ? "本档最低价位"
        : `比最低价位约贵 ${impact.percent}%`;
    case "range":
      return `约 ${format(impact.low)} – ${format(impact.high)}`;
    case "unknown":
      return `价格待确认（${impact.reason}）`;
  }
}

function option(o: Omit<PreferenceOption, "priceNote">): PreferenceOption {
  return { ...o, priceNote: describeImpact(o.priceImpact) };
}

// ── 门板样式：价格组的相对价位 ────────────────────────────────────────────

/**
 * 各价格组相对最便宜那组贵多少。
 *
 * 关键细节：**只在两组都有报价的型号上比较**。价格矩阵允许有洞（某型号只在
 * 高档组提供），直接拿两组各自的平均价相比，等于拿两个不同的篮子比总价——
 * 高档组多了几个大柜就会显得"贵 40%"，而那跟门板本身无关。
 *
 * 交集为空时返回 `unknown` 而不是硬算一个数。
 */
export function priceGroupPremiums(bundle: SpecBundle): Map<string, PriceImpact> {
  const out = new Map<string, PriceImpact>();
  const groups = bundle.priceGroups;
  if (groups.length === 0) return out;

  /** priceGroupId → (moduleId → listPrice) */
  const byGroup = new Map<string, Map<string, Money>>();
  for (const g of groups) byGroup.set(g.id, new Map());
  for (const e of bundle.priceMatrix) {
    byGroup.get(e.priceGroupId)?.set(e.moduleId, e.listPrice);
  }

  // 基准 = 在"与其他组的公共型号"上平均价最低的那一组
  const ranked = [...groups].sort((a, b) => a.rank - b.rank);
  const baseGroup = ranked[0];
  if (!baseGroup) return out;
  const basePrices = byGroup.get(baseGroup.id) ?? new Map();

  for (const g of groups) {
    if (g.id === baseGroup.id) {
      out.set(g.id, { kind: "relativeToCheapest", percent: 0 });
      continue;
    }
    const mine = byGroup.get(g.id) ?? new Map();
    const shared = [...mine.keys()].filter((id) => basePrices.has(id));
    if (shared.length === 0) {
      out.set(g.id, { kind: "unknown", reason: "与基准价位没有可比型号" });
      continue;
    }
    let sumMine = 0;
    let sumBase = 0;
    for (const id of shared) {
      sumMine += mine.get(id)!;
      sumBase += basePrices.get(id)!;
    }
    if (sumBase === 0) {
      out.set(g.id, { kind: "unknown", reason: "基准价位为零" });
      continue;
    }
    out.set(g.id, {
      kind: "relativeToCheapest",
      percent: Math.round(((sumMine - sumBase) / sumBase) * 100),
    });
  }
  return out;
}

export function doorStyleQuestion(bundle: SpecBundle): PreferenceQuestion | undefined {
  // 只有一种门板就不用问——问一个没得选的问题只是浪费客户一轮
  if (bundle.doorStyles.length < 2) return undefined;

  const premiums = priceGroupPremiums(bundle);
  const cheapest = bundle.doorStyles.find(
    (d) => premiumPercent(premiums.get(d.priceGroupId)) === 0);

  const options = bundle.doorStyles.map((d) => {
    const impact = premiums.get(d.priceGroupId) ?? { kind: "unknown" as const, reason: "该价位无报价数据" };
    const parts = [d.material, d.color].filter(Boolean);
    return option({
      id: d.id,
      label: d.name,
      ...(parts.length ? { detail: parts.join(" · ") } : {}),
      priceImpact: impact,
      ...(cheapest && d.id === cheapest.id ? { recommended: true } : {}),
    });
  });

  return {
    key: "doorStyle",
    prompt: "门板样式想选哪一款？",
    why: "门板决定了整体观感，也是价格差异最大的一项——同样的柜体，换门板价格可以差两成以上。",
    multiSelect: false,
    options,
    skippable: false,
  };
}

function premiumPercent(impact: PriceImpact | undefined): number | undefined {
  return impact?.kind === "relativeToCheapest" ? impact.percent : undefined;
}

// ── 五金与配件：真实价格修饰项 ────────────────────────────────────────────

function impactOfModifier(mod: Modifier): PriceImpact {
  return mod.kind === "flat"
    ? { kind: "perCabinet", amount: mod.value }
    : { kind: "percentOfList", percent: mod.value };
}

export function hardwareQuestion(
  bundle: SpecBundle,
  opts: { estimatedCabinetCount?: number } = {},
): PreferenceQuestion | undefined {
  if (bundle.hardwareOptions.length === 0) return undefined;

  return {
    key: "hardware",
    prompt: "五金要不要升级？可以多选，也可以都不选。",
    why: "五金是每天开合都会碰到的部分，也是用久了最容易出问题的地方。这里的价格是每个柜体的加价。",
    multiSelect: true,
    options: bundle.hardwareOptions.map((h) => hardwareOption(h, opts.estimatedCabinetCount)),
    skippable: true,
  };
}

function hardwareOption(h: HardwareOption, cabinetCount?: number): PreferenceOption {
  const impact = impactOfModifier(h.priceModifier);
  const base = option({ id: h.id, label: h.name, priceImpact: impact });
  // 知道柜体数时把总价也算出来——"每个 +$22" 对客户来说不如"这套约 +$400"直观
  if (cabinetCount && cabinetCount > 0 && impact.kind === "perCabinet") {
    return {
      ...base,
      priceNote: `${base.priceNote}（按 ${cabinetCount} 个柜体估算，合计约 ${format(mulQty(impact.amount, cabinetCount))}）`,
    };
  }
  return base;
}

export function accessoryQuestion(bundle: SpecBundle): PreferenceQuestion | undefined {
  if (bundle.accessoryOptions.length === 0) return undefined;

  return {
    key: "accessories",
    prompt: "有没有想加的功能配件？可以多选。",
    why: "配件只装在能装的柜体上，不是每个柜子都加钱。选了之后我们会在方案里标出装在哪几个柜子。",
    multiSelect: true,
    options: bundle.accessoryOptions.map((a) => accessoryOption(a, bundle)),
    skippable: true,
  };
}

function accessoryOption(a: AccessoryOption, bundle: SpecBundle): PreferenceOption {
  const codes = (a.appliesToModuleIds ?? [])
    .map((id) => bundle.modules.find((m) => m.id === id)?.code)
    .filter((c): c is string => Boolean(c));
  const base = option({
    id: a.id,
    label: a.name,
    priceImpact: impactOfModifier(a.priceModifier),
    ...(codes.length ? { detail: `可装于 ${codes.slice(0, 4).join("、")}${codes.length > 4 ? " 等" : ""}` } : {}),
  });
  return base;
}

// ── 组装方式 ──────────────────────────────────────────────────────────────

/**
 * RTA / 组装好。
 *
 * 加价取价格矩阵里 `assembledUpcharge` 的**实际分布**，不是拍一个百分比。
 * 各型号的加价方式可能不同（有的按件、有的按比例），所以给区间而不是单值。
 */
export function assemblyQuestion(bundle: SpecBundle): PreferenceQuestion | undefined {
  const upcharges = bundle.priceMatrix
    .map((e) => ({ mod: e.assembledUpcharge, list: e.listPrice }))
    .filter((x): x is { mod: Modifier; list: Money } => x.mod !== undefined);
  if (upcharges.length === 0) return undefined;

  const amounts = upcharges.map(({ mod, list }) =>
    mod.kind === "flat" ? mod.value : percentOf(list, mod.value));
  const low = fromCents(Math.min(...amounts));
  const high = fromCents(Math.max(...amounts));

  return {
    key: "assembly",
    prompt: "柜体要平板发货自己组装，还是组装好发货？",
    why: "RTA（平板发货）便宜，但需要自己或请人组装一整套柜体；组装好发货省事，运费通常也更高。",
    multiSelect: false,
    options: [
      option({
        id: "RTA" satisfies AssemblyOption, label: "平板发货（RTA），自己组装",
        priceImpact: { kind: "included" }, recommended: true,
      }),
      option({
        id: "assembled" satisfies AssemblyOption, label: "组装好发货",
        detail: "省去组装工时",
        priceImpact: low === high
          ? { kind: "perCabinet", amount: low }
          : { kind: "range", low, high },
      }),
    ],
    skippable: false,
  };
}

// ── 储物偏好：直接喂给排布目标函数 ────────────────────────────────────────

/**
 * 抽屉 vs 门板。
 *
 * 这个偏好**不只是外观**：抽屉柜比同宽的门板柜贵，但取放锅具方便得多。
 * 选择结果进排布算法的 `preference` 项（`biasTowardDrawers`），不是记下来给人看。
 */
export function storageQuestion(bundle: SpecBundle): PreferenceQuestion | undefined {
  // 「这家有没有抽屉柜」问能力，不问型号码——与 M5-2 同一条原则：
  // 靠 /^\dDB/ 判断，第二家公司（NW- 命名）会答"没有抽屉柜"而其实有
  const hasDrawers = bundle.modules.some(
    (m) => m.type === "base" && hasRole(m, "drawerStorage") && !hasRole(m, "doorStorage"));
  if (!hasDrawers) return undefined;

  return {
    key: "storage",
    prompt: "地柜偏好抽屉还是门板？",
    why: "抽屉取放锅碗方便（不用蹲下来伸手进柜子深处），但同宽度下比门板柜贵。灶台和水槽附近做抽屉收益最大。",
    multiSelect: false,
    options: [
      option({
        id: "drawers", label: "尽量多做抽屉",
        detail: "取放最方便，造价最高",
        priceImpact: { kind: "unknown", reason: "取决于最终排布，出方案后即可看到差额" },
      }),
      option({
        id: "balanced", label: "灶台/水槽附近做抽屉，其余门板",
        detail: "常见做法",
        priceImpact: { kind: "unknown", reason: "取决于最终排布" },
        recommended: true,
      }),
      option({
        id: "doors", label: "以门板柜为主",
        detail: "造价最低",
        priceImpact: { kind: "unknown", reason: "取决于最终排布" },
      }),
    ],
    skippable: true,
  };
}

// ── 家电：客户已经拥有的东西，是输入不是常数 ──────────────────────────────

/**
 * 厨房里有哪些家电。
 *
 * 改造前这件事是**推**出来的：户型图上识别出燃气特征就放灶具，识别出强电就放
 * 冰箱，都没识别到就一个家电也不放——而没有哪家厨房是没冰箱的。
 * 家电是客户已经拥有或已经选定的东西，得问。
 */
export function applianceQuestion(): PreferenceQuestion {
  const kinds: ApplianceKind[] = [
    "refrigerator", "range", "wallOven", "rangeHood", "dishwasher", "microwave",
  ];
  const why =
    "家电占的墙面是从柜子里扣出来的，尺寸差 3 寸就可能少一个柜。" +
    "另外冰箱把手一侧、灶具两侧都有净空要求（放刚端下来的热锅），会影响整体排布。";

  return {
    key: "appliances",
    prompt: "厨房里会有哪些家电？",
    why,
    multiSelect: true,
    options: kinds.map((kind) => option({
      id: kind,
      label: APPLIANCE_LABEL[kind],
      ...(kind === "rangeHood" ? { detail: "会占用灶台正上方的吊柜位" } : {}),
      ...(kind === "dishwasher" ? { detail: "需要紧邻水槽（NKBA 要求 36 英寸以内）" } : {}),
      priceImpact: { kind: "unknown", reason: "家电本身不在报价内；它影响的是柜体数量" },
      ...(kind === "refrigerator" || kind === "range" || kind === "dishwasher"
        ? { recommended: true } : {}),
    })),
    skippable: false,
  };
}

/**
 * 各个家电多宽。
 *
 * **「我去量一下再说」是合法选项。** 多数客户不知道自己冰箱多宽，逼他量了才能
 * 继续，是把系统的困难转嫁给他。选了它就走常见尺寸，但会标成推定值
 * （`provenance: "assumed"`），并在图纸解释与硬约束提示里如实说明。
 */
export function applianceWidthQuestion(kind: ApplianceKind): PreferenceQuestion | undefined {
  const widths = COMMON_WIDTHS[kind];
  if (!widths || widths.length === 0) return undefined;
  const label = APPLIANCE_LABEL[kind];

  return {
    key: "applianceWidths",
    prompt: `${label}的宽度是多少？`,
    why: "柜位会按你的尺寸留空（冰箱两侧还要各留 1 英寸通风）。" +
      "按常见尺寸猜的话，你的机器更宽就装不进去，更窄就白白浪费储物。",
    multiSelect: false,
    options: [
      ...widths.map((w, i) => option({
        id: `${kind}:${w}`,
        label: `${w} 英寸`,
        ...(widthDetail(kind, w) ? { detail: widthDetail(kind, w)! } : {}),
        priceImpact: { kind: "unknown", reason: "影响的是能排下多少柜子，不是单价" },
        // 中间那档是最常见的
        ...(i === Math.floor(widths.length / 2) ? { recommended: true } : {}),
      })),
      option({
        id: `${kind}:unsure`,
        label: "我去量一下再说",
        detail: `先按 ${label}常见尺寸预留；图上会标出这是推定值`,
        priceImpact: { kind: "unknown", reason: "按常见尺寸预留，之后可改" },
      }),
    ],
    skippable: true,
  };
}

/** 常见宽度的口语化说明。没有说法的就不编一个。 */
function widthDetail(kind: ApplianceKind, width: number): string | undefined {
  if (kind !== "refrigerator") return undefined;
  if (width === 30) return "窄款，小户型常见";
  if (width === 33) return "最常见";
  if (width === 36) return "对开门 / 法式";
  return undefined;
}

/**
 * 家电想放在哪。
 *
 * 位置是客户的偏好，不是几何推导的结果。排布器会尽量满足；满足不了要说明，
 * 不静默忽略——「你说想靠近入口，但那面墙放不下 35" 的冰箱位」是有用的信息。
 */
export function appliancePlacementQuestion(kind: ApplianceKind): PreferenceQuestion {
  const label = APPLIANCE_LABEL[kind];
  return {
    key: "appliances",
    prompt: `${label}想放在哪个位置？`,
    why: `${label}的位置会牵动整条动线：冰箱把手一侧要留 15 英寸以上的落台面，` +
      "灶具两侧要能放热锅，水槽和洗碗机要挨着。",
    multiSelect: false,
    options: [
      option({
        id: `${kind}:nearEntry`, label: "靠近入口",
        detail: "买菜进门先放下",
        priceImpact: { kind: "unknown", reason: "不影响单价" },
        recommended: kind === "refrigerator",
      }),
      option({
        id: `${kind}:nearSink`, label: "靠近水槽",
        priceImpact: { kind: "unknown", reason: "不影响单价" },
      }),
      option({
        id: `${kind}:any`, label: "我不确定，你帮我定",
        detail: "按人体工程与动线自动安排",
        priceImpact: { kind: "unknown", reason: "不影响单价" },
      }),
    ],
    skippable: true,
  };
}

// ── 预算：用真实数据锚定，不凭空给区间 ────────────────────────────────────

export interface BudgetContext {
  /** 地柜层总长度（英寸）。有户型图时才有。 */
  baseRunInches?: number;
  catalog: GenericCatalog;
  /** `GenericCatalog` 的来源是否已核实（未核实时必须标注为占位数据）。 */
  sourceVerified: boolean;
}

/**
 * 预算区间。
 *
 * **不问"你的预算是多少"**——客户不知道一套橱柜该是多少钱，这个问题等于让他
 * 先去做一遍市场调研。改成给出按这个厨房尺寸估算的三档区间，让他选一档。
 *
 * 区间从 `GenericCatalog` 的典型价推出来；来源未核实时如实标注，
 * 不让占位数字冒充行业数据（检查清单 A4）。
 */
export function budgetQuestion(ctx: BudgetContext): PreferenceQuestion | undefined {
  const inches = ctx.baseRunInches;
  if (!inches || inches <= 0) return undefined;

  const base = ctx.catalog.modules.find((m) => m.type === "base");
  const wall = ctx.catalog.modules.find((m) => m.type === "wall");
  if (!base || !wall) return undefined;

  // 以 30" 为典型柜宽估个数：地柜 + 同长度的吊柜
  const cabinets = Math.max(1, Math.round(inches / 30));
  const low = fromCents((base.typicalPriceRange.low + wall.typicalPriceRange.low) * cabinets);
  const high = fromCents((base.typicalPriceRange.high + wall.typicalPriceRange.high) * cabinets);
  const mid = fromCents(Math.round((low + high) / 2));

  const caveat = ctx.sourceVerified
    ? ""
    : "（价格区间基于平台通用参考数据，尚未逐条核实，仅供确定量级）";

  return {
    key: "budgetBand",
    prompt: `按你这个厨房的尺寸（地柜约 ${Math.round(inches)}"），柜体部分大致在这几档，你倾向哪一档？`,
    why: `预算档位会影响我们推荐的门板价位与配件取舍。这里只含柜体，不含台面、电器与安装。${caveat}`,
    multiSelect: false,
    options: [
      option({
        id: "economy", label: "控制成本优先",
        priceImpact: { kind: "range", low, high: mid },
      }),
      option({
        id: "standard", label: "中间档，性价比优先",
        priceImpact: { kind: "range", low: mid, high },
        recommended: true,
      }),
      option({
        id: "premium", label: "不设上限，优先质感",
        priceImpact: { kind: "unknown", reason: "取决于门板与配件选择" },
      }),
      option({
        id: "unsure", label: "还没想好，先看方案再说",
        priceImpact: { kind: "unknown", reason: "未选择" },
      }),
    ],
    skippable: true,
  };
}

// ── 取舍优先级 ────────────────────────────────────────────────────────────

/**
 * 预算不够时先保什么。
 *
 * 这个问题看着虚，但它决定了后续每一次"要不要加这个配件"的默认答案。
 * 没有它，系统只能每次都问一遍。
 */
export function tradeoffQuestion(): PreferenceQuestion {
  return {
    key: "tradeoff",
    prompt: "如果预算需要取舍，你更想先保住哪一样？",
    why: "有了这个，后面的取舍我们可以按你的倾向先给建议，不用每一项都来问你一遍。",
    multiSelect: false,
    options: [
      option({ id: "price", label: "总价", detail: "配件与升级项从简", priceImpact: { kind: "included" } }),
      option({ id: "quality", label: "用料与五金", detail: "面板可以朴素，五金不将就", priceImpact: { kind: "included" } }),
      option({ id: "lookAndFeel", label: "外观质感", detail: "门板与颜色优先", priceImpact: { kind: "included" } }),
    ],
    skippable: true,
  };
}

// ── 组卷 ──────────────────────────────────────────────────────────────────

export interface QuestionSetInput {
  bundle?: SpecBundle;
  budget?: BudgetContext;
  /** 已经答过的，不再问。 */
  answered: CustomerPreferences;
  /** 每轮最多问几题——沿用 trade/consumer 的交互差异。 */
  maxPerTurn: number;
  estimatedCabinetCount?: number;
}

/**
 * 生成本轮要问的问题。
 *
 * 顺序是有讲究的：先问影响面最大的（门板 → 价格组 → 整体价位），
 * 再问局部的（五金、配件）。反过来问会出现"先挑好了配件，一换门板价格全变"。
 */
export function buildQuestionSet(input: QuestionSetInput): PreferenceQuestion[] {
  const { bundle, answered } = input;
  const all: (PreferenceQuestion | undefined)[] = [
    input.budget ? budgetQuestion(input.budget) : undefined,
    bundle ? doorStyleQuestion(bundle) : undefined,
    bundle ? storageQuestion(bundle) : undefined,
    bundle ? assemblyQuestion(bundle) : undefined,
    bundle
      ? hardwareQuestion(bundle, {
          ...(input.estimatedCabinetCount !== undefined
            ? { estimatedCabinetCount: input.estimatedCabinetCount } : {}),
        })
      : undefined,
    bundle ? accessoryQuestion(bundle) : undefined,
    tradeoffQuestion(),
  ];

  return all
    .filter((q): q is PreferenceQuestion => q !== undefined)
    .filter((q) => !isAnswered(q.key, answered))
    .slice(0, Math.max(1, input.maxPerTurn));
}

function isAnswered(key: PreferenceKey, prefs: CustomerPreferences): boolean {
  switch (key) {
    case "budgetBand": return prefs.budgetBand !== undefined;
    case "doorStyle": return prefs.doorStyleId !== undefined;
    case "assembly": return prefs.assembly !== undefined;
    case "storage": return prefs.storage !== undefined;
    case "hardware": return prefs.hardwareOptionIds !== undefined;
    case "accessories": return prefs.accessoryOptionIds !== undefined;
    case "tradeoff": return prefs.tradeoff !== undefined;
    // 家电问的是**这个厨房的物理事实**，答案存在 FloorPlan 上而不是偏好里
    // （贸易账号一个人有多个项目，各自的家电不同）。所以它们不走这条判断，
    // 由 buildApplianceQuestions 按户型自己的状态决定还该问什么。
    case "appliances":
    case "applianceWidths": return false;
  }
}

/**
 * 按户型当前的家电信息，决定还该问什么。
 *
 * 与 `buildQuestionSet` 分开，因为两者的**状态源不同**：偏好在会话上，
 * 家电在户型上。合在一起会出现「换一家公司问一遍你冰箱多宽」。
 */
export function buildApplianceQuestions(input: {
  /** 户型上已经记下的家电。 */
  known: readonly ApplianceSpec[];
  /** 客户是否已经答过「有哪些家电」。没答过就先问这个。 */
  kindsAnswered: boolean;
  maxPerTurn: number;
}): PreferenceQuestion[] {
  if (!input.kindsAnswered) return [applianceQuestion()];

  // 只对**推定尺寸**的家电追问宽度——客户已经给了准确数字的不再打扰
  const out: PreferenceQuestion[] = [];
  for (const a of input.known) {
    if (a.provenance !== "assumed") continue;
    const q = applianceWidthQuestion(a.kind);
    if (q) out.push(q);
  }
  return out.slice(0, Math.max(1, input.maxPerTurn));
}

// ── 答案校验 ──────────────────────────────────────────────────────────────

export class PreferenceError extends Error {}

/**
 * 校验并归一化客户的选择。
 *
 * 必须校验：客户端传来的 id 可能是任意字符串。选了一个这家公司没有的门板，
 * 后面定价会在价格矩阵里查不到而抛 `PRICE_MATRIX_HOLE`——那时候报错就太晚了，
 * 而且错误信息对客户没有意义。
 */
export function validatePreferences(
  raw: Partial<CustomerPreferences>,
  bundle: SpecBundle | undefined,
): { shared: SharedPreferences; company: CompanyPreferences } {
  const shared: SharedPreferences = {};
  const company: CompanyPreferences = {};

  if (raw.doorStyleId !== undefined) {
    if (!bundle?.doorStyles.some((d) => d.id === raw.doorStyleId)) {
      throw new PreferenceError(`门板样式 ${raw.doorStyleId} 不在该公司的规格库中`);
    }
    company.doorStyleId = raw.doorStyleId;
  }
  if (raw.hardwareOptionIds !== undefined) {
    company.hardwareOptionIds = checkIds(raw.hardwareOptionIds, bundle?.hardwareOptions ?? [], "五金");
  }
  if (raw.accessoryOptionIds !== undefined) {
    company.accessoryOptionIds = checkIds(raw.accessoryOptionIds, bundle?.accessoryOptions ?? [], "配件");
  }

  if (raw.assembly !== undefined) {
    if (raw.assembly !== "RTA" && raw.assembly !== "assembled") {
      throw new PreferenceError("组装方式只能是 RTA 或 assembled");
    }
    shared.assembly = raw.assembly;
  }
  if (raw.storage !== undefined) {
    if (!["drawers", "doors", "balanced"].includes(raw.storage)) {
      throw new PreferenceError("储物偏好只能是 drawers / doors / balanced");
    }
    shared.storage = raw.storage;
  }
  if (raw.budgetBand !== undefined) {
    if (!["economy", "standard", "premium", "unsure"].includes(raw.budgetBand)) {
      throw new PreferenceError("预算档位取值非法");
    }
    shared.budgetBand = raw.budgetBand;
  }
  if (raw.tradeoff !== undefined) {
    if (!["price", "quality", "lookAndFeel"].includes(raw.tradeoff)) {
      throw new PreferenceError("取舍优先级取值非法");
    }
    shared.tradeoff = raw.tradeoff;
  }
  return { shared, company };
}

function checkIds(ids: unknown, known: readonly { id: string }[], label: string): string[] {
  if (!Array.isArray(ids)) throw new PreferenceError(`${label}选择必须是数组`);
  const set = new Set(known.map((k) => k.id));
  for (const id of ids) {
    if (typeof id !== "string" || !set.has(id)) {
      throw new PreferenceError(`${label} ${String(id)} 不在该公司的规格库中`);
    }
  }
  return [...new Set(ids as string[])];
}

// ── 把偏好接到下游 ────────────────────────────────────────────────────────

/** 储物偏好 → 排布算法的抽屉倾向。 */
export function drawerBiasFor(prefs: CustomerPreferences): "always" | "highUseOnly" | "never" {
  switch (prefs.storage) {
    case "drawers": return "always";
    case "doors": return "never";
    default: return "highUseOnly";
  }
}

/**
 * 把偏好套到排布产出的选择上。
 *
 * **每一项都要按适用性过滤**，这是同一个教训的三个面：
 *   - 配件有 `appliesToModuleIds` 限制；
 *   - 五金有 `appliesToModuleTypes` 限制；
 *   - **组装方式有 `assemblyOptions` 限制**——多数公司只提供地柜的组装服务，
 *     吊柜一律平板发货。
 *
 * 不做这层过滤，定价引擎会因为「这个柜体不提供这种形式」而**整单拒绝**
 * （FR-8 校验），而客户看到的只是一句"报价校验未通过"。
 */
export function applyPreferencesToSelections<
  T extends { moduleId: string; hardwareOptionIds: string[]; accessoryOptionIds: string[]; assembly: string },
>(
  selections: readonly T[],
  prefs: CustomerPreferences,
  bundle: SpecBundle,
  modulesById: ReadonlyMap<string, ModuleSpec> = indexModules(bundle),
): T[] {
  const hardware = (prefs.hardwareOptionIds ?? [])
    .map((id) => bundle.hardwareOptions.find((h) => h.id === id))
    .filter((h): h is HardwareOption => h !== undefined);
  const accessories = (prefs.accessoryOptionIds ?? [])
    .map((id) => bundle.accessoryOptions.find((a) => a.id === id))
    .filter((a): a is AccessoryOption => a !== undefined);

  return selections.map((s) => {
    const mod = modulesById.get(s.moduleId);
    const hw = mod
      ? hardware.filter((h) => !h.appliesToModuleTypes || h.appliesToModuleTypes.includes(mod.type))
      : [];
    const ac = accessories.filter((a) => !a.appliesToModuleIds || a.appliesToModuleIds.includes(s.moduleId));
    // 该型号不提供客户选的组装方式时保持原值（通常是 RTA），而不是整单被拒
    const assembly = prefs.assembly && (!mod || mod.assemblyOptions.includes(prefs.assembly))
      ? prefs.assembly
      : s.assembly;
    return {
      ...s,
      assembly,
      hardwareOptionIds: [...new Set([...s.hardwareOptionIds, ...hw.map((h) => h.id)])],
      accessoryOptionIds: [...new Set([...s.accessoryOptionIds, ...ac.map((a) => a.id)])],
    };
  });
}

function indexModules(bundle: SpecBundle): Map<string, ModuleSpec> {
  return new Map(bundle.modules.map((m) => [m.id, m]));
}

/**
 * 偏好里有哪些项在这版方案上没能完全落实。
 *
 * 静默地部分落实是最坏的做法——客户选了「组装好发货」，结果吊柜还是平板到货，
 * 拆箱时才发现。这里如实列出来，让界面能说清楚。
 */
export function unappliedPreferences(
  selections: readonly { moduleId: string }[],
  prefs: CustomerPreferences,
  bundle: SpecBundle,
): string[] {
  const notes: string[] = [];
  const byId = indexModules(bundle);

  if (prefs.assembly) {
    const cannot = [...new Set(
      selections
        .map((s) => byId.get(s.moduleId))
        .filter((m): m is ModuleSpec => !!m && !m.assemblyOptions.includes(prefs.assembly!))
        .map((m) => m.code),
    )];
    if (cannot.length > 0) {
      notes.push(
        `${cannot.join("、")} 不提供「${prefs.assembly === "assembled" ? "组装好发货" : "平板发货"}」，` +
        `这几个柜体按${prefs.assembly === "assembled" ? "平板" : "组装好"}发货——` +
        `多数公司只对地柜提供组装服务。`,
      );
    }
  }

  for (const [ids, pool, label] of [
    [prefs.accessoryOptionIds ?? [], bundle.accessoryOptions, "配件"],
    [prefs.hardwareOptionIds ?? [], bundle.hardwareOptions, "五金"],
  ] as const) {
    for (const id of ids) {
      const opt = pool.find((o) => o.id === id);
      if (!opt) continue;
      const applicable = selections.filter((s) => {
        const m = byId.get(s.moduleId);
        if (!m) return false;
        return "appliesToModuleIds" in opt && opt.appliesToModuleIds
          ? opt.appliesToModuleIds.includes(s.moduleId)
          : "appliesToModuleTypes" in opt && opt.appliesToModuleTypes
            ? opt.appliesToModuleTypes.includes(m.type)
            : true;
      }).length;
      if (applicable === 0) {
        notes.push(`${label}「${opt.name}」在这版方案的柜体上都装不了，未计入报价。`);
      }
    }
  }
  return notes;
}
