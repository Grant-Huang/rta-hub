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
import { sortBoxMaterials } from "../spec/carcass.js";
import {
  applianceLabel, COMMON_HEIGHTS, COMMON_WIDTHS, type ApplianceKind, type ApplianceSpec,
} from "../floorplan/appliances.js";
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";

export type PreferenceKey =
  | "budgetBand"
  | "doorStyle"
  /** 箱体用什么板。与门板花色是两个独立的维度。 */
  | "boxMaterial"
  | "assembly"
  | "storage"
  | "hardware"
  | "accessories"
  | "tradeoff"
  /** 厨房里有哪些家电（多选）。 */
  | "appliances"
  /** 各个家电多宽。答"不确定"合法，走推定值并留痕（见 floorplan/appliances.ts）。 */
  | "applianceWidths"
  /** 冰箱多高——决定上方能不能装吊柜。只对冰箱问。 */
  | "applianceHeights";

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

export function describeImpact(
  impact: PriceImpact,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): string {
  switch (impact.kind) {
    case "included":
      return msg(lang, "Included in base price", "已含在基础价中");
    case "perCabinet":
      return msg(lang,
        `+${format(impact.amount)} per cabinet`,
        `每个柜子 +${format(impact.amount)}`);
    case "percentOfList":
      return msg(lang,
        `+${impact.percent}% of applicable cabinet list`,
        `适用柜体目录价 +${impact.percent}%`);
    case "relativeToCheapest":
      return impact.percent === 0
        ? msg(lang, "Lowest price tier", "最低价档")
        : msg(lang,
          `About ${impact.percent}% above the lowest tier`,
          `约比最低档贵 ${impact.percent}%`);
    case "range":
      return msg(lang,
        `About ${format(impact.low)} – ${format(impact.high)}`,
        `约 ${format(impact.low)} – ${format(impact.high)}`);
    case "unknown":
      return msg(lang,
        `Price TBD (${impact.reason})`,
        `价格待确认（${impact.reason}）`);
  }
}

function option(
  o: Omit<PreferenceOption, "priceNote">,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): PreferenceOption {
  return { ...o, priceNote: describeImpact(o.priceImpact, lang) };
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
export function priceGroupPremiums(
  bundle: SpecBundle,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): Map<string, PriceImpact> {
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
      out.set(g.id, {
        kind: "unknown",
        reason: msg(lang,
          "No overlapping SKUs with the base tier",
          "与基准档没有可对比的共同型号"),
      });
      continue;
    }
    let sumMine = 0;
    let sumBase = 0;
    for (const id of shared) {
      sumMine += mine.get(id)!;
      sumBase += basePrices.get(id)!;
    }
    if (sumBase === 0) {
      out.set(g.id, {
        kind: "unknown",
        reason: msg(lang, "Base tier price is zero", "基准档价格为 0"),
      });
      continue;
    }
    out.set(g.id, {
      kind: "relativeToCheapest",
      percent: Math.round(((sumMine - sumBase) / sumBase) * 100),
    });
  }
  return out;
}

export function doorStyleQuestion(
  bundle: SpecBundle,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): PreferenceQuestion | undefined {
  // 只有一种门板就不用问——问一个没得选的问题只是浪费客户一轮
  if (bundle.doorStyles.length < 2) return undefined;

  const premiums = priceGroupPremiums(bundle, lang);
  const cheapest = bundle.doorStyles.find(
    (d) => premiumPercent(premiums.get(d.priceGroupId)) === 0);

  const options = bundle.doorStyles.map((d) => {
    const impact = premiums.get(d.priceGroupId) ?? {
      kind: "unknown" as const,
      reason: msg(lang, "No list price for this tier", "该档暂无目录价"),
    };
    const parts = [d.material, d.color].filter(Boolean);
    return option({
      id: d.id,
      label: d.name,
      ...(parts.length ? { detail: parts.join(" · ") } : {}),
      priceImpact: impact,
      ...(cheapest && d.id === cheapest.id ? { recommended: true } : {}),
    }, lang);
  });

  return {
    key: "doorStyle",
    prompt: msg(lang, "Which door style do you want?", "想要哪种门板样式？"),
    why: msg(lang,
      "The door drives the look and is usually the biggest price swing — same boxes, different doors can move the total by 20%+.",
      "门板决定观感，通常也是价差最大的一项——同样柜体换门板，总价可差 20% 以上。"),
    multiSelect: false,
    options,
    skippable: false,
  };
}

/**
 * 箱体板材那一题。
 *
 * 单独问，不并进门板那一题——客户问的是两件事：「柜门长什么样」和
 * 「柜子本身用什么板」。并成一题会逼出"Shaker White + 全夹板"这种
 * 组合选项，选项数变成花色数 × 板材数，而客户其实只想分别答一次。
 *
 * `why` 里要说清**差在哪**，不是只说贵多少：客户不知道夹板箱体值不值
 * 那 18%，除非有人告诉他水槽柜下面那一格最能看出区别。
 */
export function boxMaterialQuestion(
  bundle: SpecBundle,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): PreferenceQuestion | undefined {
  const materials = sortBoxMaterials(bundle.boxMaterialOptions ?? []);
  // 只有一档就不问——问一个没得选的问题只是浪费客户一轮
  if (materials.length < 2) return undefined;

  const baseline = materials.find((m) => m.isDefault) ?? materials[0];
  return {
    key: "boxMaterial",
    prompt: msg(lang, "What box (carcass) material do you want?", "想要哪种箱体板材？"),
    why: msg(lang,
      "This is separate from the door finish: doors are what you see; the box is what the cabinet is made of. "
        + "Pricing is separate too — same door on different boxes are two prices. The difference shows most under the sink.",
      "这与门板花色是两件事：门板是外观，箱体是柜子本身的板材。"
        + "计价也分开——同门板不同箱体是两个价。差别在水槽柜下格最明显。"),
    multiSelect: false,
    options: materials.map((m) => option({
      id: m.id,
      label: m.name,
      ...(m.note ? { detail: m.note } : {}),
      priceImpact: impactOfModifier(m.priceModifier),
      ...(baseline && m.id === baseline.id ? { recommended: true } : {}),
    }, lang)),
    skippable: true,
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
  opts: { estimatedCabinetCount?: number; language?: UiLanguage } = {},
): PreferenceQuestion | undefined {
  if (bundle.hardwareOptions.length === 0) return undefined;
  const lang = opts.language ?? DEFAULT_LANGUAGE;

  return {
    key: "hardware",
    prompt: msg(lang,
      "Want any hardware upgrades? Multi-select, or skip.",
      "要升级五金吗？可多选，也可跳过。"),
    why: msg(lang,
      "Hardware is what you touch every day, and where wear shows first. Prices below are per cabinet.",
      "五金是每天都会摸到的部分，也最先显出磨损。下列价格按每个柜子计。"),
    multiSelect: true,
    options: bundle.hardwareOptions.map((h) =>
      hardwareOption(h, opts.estimatedCabinetCount, lang)),
    skippable: true,
  };
}

function hardwareOption(
  h: HardwareOption,
  cabinetCount?: number,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): PreferenceOption {
  const impact = impactOfModifier(h.priceModifier);
  const base = option({ id: h.id, label: h.name, priceImpact: impact }, lang);
  // 知道柜体数时把总价也算出来——"每个 +$22" 对客户来说不如"这套约 +$400"直观
  if (cabinetCount && cabinetCount > 0 && impact.kind === "perCabinet") {
    const total = format(mulQty(impact.amount, cabinetCount));
    return {
      ...base,
      priceNote: msg(lang,
        `${base.priceNote} (≈ ${total} for ${cabinetCount} cabinets)`,
        `${base.priceNote}（约 ${cabinetCount} 个柜子合计 ${total}）`),
    };
  }
  return base;
}

export function accessoryQuestion(
  bundle: SpecBundle,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): PreferenceQuestion | undefined {
  if (bundle.accessoryOptions.length === 0) return undefined;

  return {
    key: "accessories",
    prompt: msg(lang,
      "Any functional accessories to add? Multi-select OK.",
      "要加功能配件吗？可多选。"),
    why: msg(lang,
      "Accessories only go on cabinets that can take them — you don't pay per cabinet across the whole kitchen.",
      "配件只装在能装的柜子上——不会按整厨每个柜子都收一遍。"),
    multiSelect: true,
    options: bundle.accessoryOptions.map((a) => accessoryOption(a, bundle, lang)),
    skippable: true,
  };
}

function accessoryOption(
  a: AccessoryOption,
  bundle: SpecBundle,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): PreferenceOption {
  const codes = (a.appliesToModuleIds ?? [])
    .map((id) => bundle.modules.find((m) => m.id === id)?.code)
    .filter((c): c is string => Boolean(c));
  const base = option({
    id: a.id,
    label: a.name,
    priceImpact: impactOfModifier(a.priceModifier),
    ...(codes.length
      ? {
          detail: msg(lang,
            `Fits ${codes.slice(0, 4).join(", ")}${codes.length > 4 ? ", …" : ""}`,
            `适用于 ${codes.slice(0, 4).join("、")}${codes.length > 4 ? "…" : ""}`),
        }
      : {}),
  }, lang);
  return base;
}

// ── 组装方式 ──────────────────────────────────────────────────────────────

/**
 * RTA / 组装好。
 *
 * 加价取价格矩阵里 `assembledUpcharge` 的**实际分布**，不是拍一个百分比。
 * 各型号的加价方式可能不同（有的按件、有的按比例），所以给区间而不是单值。
 */
export function assemblyQuestion(
  bundle: SpecBundle,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): PreferenceQuestion | undefined {
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
    prompt: msg(lang,
      "Ship flat-pack (RTA) for you to assemble, or assembled?",
      "要平板发货（RTA，自行组装），还是组装好发货？"),
    why: msg(lang,
      "RTA is cheaper but you (or a hired installer) assemble the set; assembled ships ready but usually costs more to freight.",
      "RTA 更便宜，但需自行或请人组装；组装好发货省事，运费通常更高。"),
    multiSelect: false,
    options: [
      option({
        id: "RTA" satisfies AssemblyOption,
        label: msg(lang, "Flat-pack (RTA) — assemble yourself", "平板发货（RTA）— 自行组装"),
        priceImpact: { kind: "included" }, recommended: true,
      }, lang),
      option({
        id: "assembled" satisfies AssemblyOption,
        label: msg(lang, "Assembled", "组装好发货"),
        detail: msg(lang, "Skip assembly labor", "省去组装人力"),
        priceImpact: low === high
          ? { kind: "perCabinet", amount: low }
          : { kind: "range", low, high },
      }, lang),
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
export function storageQuestion(
  bundle: SpecBundle,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): PreferenceQuestion | undefined {
  // 「这家有没有抽屉柜」问能力，不问型号码——与 M5-2 同一条原则：
  // 靠 /^\dDB/ 判断，第二家公司（NW- 命名）会答"没有抽屉柜"而其实有
  const hasDrawers = bundle.modules.some(
    (m) => m.type === "base" && hasRole(m, "drawerStorage") && !hasRole(m, "doorStorage"));
  if (!hasDrawers) return undefined;

  const layoutDelta = msg(lang,
    "Depends on the final layout",
    "取决于最终排布");
  const layoutDeltaAfter = msg(lang,
    "Depends on the final layout — delta shows after we generate",
    "取决于最终排布——出图后才能看到价差");

  return {
    key: "storage",
    prompt: msg(lang,
      "Prefer drawers or doors on the base run?",
      "地柜更倾向抽屉还是门板柜？"),
    why: msg(lang,
      "Drawers are easier for pots and pans (no deep crouching), but cost more than door cabinets of the same width. Highest payoff near the range and sink.",
      "抽屉取锅更方便（不用深蹲），但比同宽门板柜贵。灶台与水槽附近收益最大。"),
    multiSelect: false,
    options: [
      option({
        id: "drawers",
        label: msg(lang, "As many drawers as possible", "尽量多抽屉"),
        detail: msg(lang, "Most convenient, highest cost", "最方便，成本最高"),
        priceImpact: { kind: "unknown", reason: layoutDeltaAfter },
      }, lang),
      option({
        id: "balanced",
        label: msg(lang, "Drawers near range/sink; doors elsewhere", "灶台/水槽旁抽屉，其余门板"),
        detail: msg(lang, "Common approach", "常见做法"),
        priceImpact: { kind: "unknown", reason: layoutDelta },
        recommended: true,
      }, lang),
      option({
        id: "doors",
        label: msg(lang, "Mostly door cabinets", "以门板柜为主"),
        detail: msg(lang, "Lowest cost", "成本最低"),
        priceImpact: { kind: "unknown", reason: layoutDelta },
      }, lang),
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
export function applianceQuestion(
  lang: UiLanguage = DEFAULT_LANGUAGE,
): PreferenceQuestion {
  const kinds: ApplianceKind[] = [
    "refrigerator", "range", "wallOven", "rangeHood", "dishwasher", "microwave",
  ];
  const why = msg(lang,
    "Appliances take wall space out of the cabinet run — 3\" can cost you a whole cabinet. "
      + "Fridge handle side and both sides of the range also need landing clearance, which reshapes the layout.",
    "家电会占掉柜体墙面——差 3\" 可能少一整柜。"
      + "冰箱把手侧与灶台两侧还要落台空间，会改变整段排布。");
  const priceReason = msg(lang,
    "Appliances aren't in the quote; they change cabinet count",
    "家电不计入报价；会改变柜体数量");

  return {
    key: "appliances",
    prompt: msg(lang, "Which appliances will be in the kitchen?", "这间厨房会有哪些家电？"),
    why,
    multiSelect: true,
    options: kinds.map((kind) => option({
      id: kind,
      label: applianceLabel(kind, lang),
      ...(kind === "rangeHood"
        ? {
            detail: msg(lang,
              "Uses the wall-cabinet bay above the range",
              "占用灶台上方的吊柜位"),
          }
        : {}),
      ...(kind === "dishwasher"
        ? {
            detail: msg(lang,
              "Needs to sit next to the sink (NKBA: within 36\")",
              "需紧邻水槽（NKBA：36\" 以内）"),
          }
        : {}),
      priceImpact: { kind: "unknown", reason: priceReason },
      ...(kind === "refrigerator" || kind === "range" || kind === "dishwasher"
        ? { recommended: true } : {}),
    }, lang)),
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
export function applianceWidthQuestion(
  kind: ApplianceKind,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): PreferenceQuestion | undefined {
  const widths = COMMON_WIDTHS[kind];
  if (!widths || widths.length === 0) return undefined;
  const label = applianceLabel(kind, lang);
  const affectReason = msg(lang,
    "Affects how many cabinets fit, not unit price",
    "影响能排几个柜子，不改变单价");

  return {
    key: "applianceWidths",
    prompt: msg(lang, `How wide is the ${label}?`, `${label}多宽？`),
    why: msg(lang,
      "We'll reserve the bay to your size (fridge also needs 1\" clearance each side). "
        + "Guessing a common size means a wider unit won't fit, or a narrower one wastes storage.",
      "我们会按你的尺寸留位（冰箱两侧各还需 1\" 间隙）。"
        + "猜常见尺寸时：偏大装不进，偏小会浪费储物空间。"),
    multiSelect: false,
    options: [
      ...widths.map((w, i) => option({
        id: `${kind}:${w}`,
        label: `${w}"`,
        ...(widthDetail(kind, w, lang) ? { detail: widthDetail(kind, w, lang)! } : {}),
        priceImpact: { kind: "unknown", reason: affectReason },
        ...(i === Math.floor(widths.length / 2) ? { recommended: true } : {}),
      }, lang)),
      option({
        id: `${kind}:unsure`,
        label: msg(lang, "I'll measure and come back", "我量好了再说"),
        detail: msg(lang,
          `Reserve a common ${label} width for now; the drawing will mark it as assumed`,
          `先按常见 ${label} 宽度预留；图纸上会标明为推定`),
        priceImpact: {
          kind: "unknown",
          reason: msg(lang, "Common size reserved; changeable later", "先按常见尺寸预留，之后可改"),
        },
      }, lang),
    ],
    skippable: true,
  };
}

/**
 * 冰箱多高。
 *
 * 只问冰箱——它是唯一「上面通常还有个柜子」的家电（烤箱/洗碗机嵌在柜体里，
 * 灶具矮柜没有上方净空的问题）。不知道高度，冰箱上柜的尺寸就是瞎猜的，
 * 猜大了压不下去，猜小了顶上留一截露白边。
 *
 * 同样接受"不确定"：走常见高度并标 `heightProvenance: "assumed"`。
 */
export function applianceHeightQuestion(
  lang: UiLanguage = DEFAULT_LANGUAGE,
): PreferenceQuestion | undefined {
  const heights = COMMON_HEIGHTS.refrigerator;
  if (!heights || heights.length === 0) return undefined;
  const label = applianceLabel("refrigerator", lang);
  const affectReason = msg(lang,
    "Decides whether a cabinet fits above the fridge, not unit price",
    "决定冰箱上方能不能装吊柜，不改变单价");

  return {
    key: "applianceHeights",
    prompt: msg(lang,
      `How tall is the ${label} (top of the appliance, in inches)?`,
      `${label}多高（机身顶部，英寸）？`),
    why: msg(lang,
      "Fridges usually don't reach the ceiling — there's a small cabinet above. "
        + "We need the height to size that cabinet (or tell you there's no room for one).",
      "冰箱一般不会顶到天花板——上面通常还有一个小柜子。"
        + "需要知道高度才能定这个柜子的尺寸（或者如实告诉你根本装不下）。"),
    multiSelect: false,
    options: [
      ...heights.map((h, i) => option({
        id: `refrigerator:height:${h}`,
        label: `${h}"`,
        priceImpact: { kind: "unknown", reason: affectReason },
        ...(i === Math.floor(heights.length / 2) ? { recommended: true } : {}),
      }, lang)),
      option({
        id: "refrigerator:height:unsure",
        label: msg(lang, "I'll measure and come back", "我量好了再说"),
        detail: msg(lang,
          "Reserve a common height for now; the drawing will mark it as assumed",
          "先按常见高度预留；图纸上会标明为推定"),
        priceImpact: {
          kind: "unknown",
          reason: msg(lang, "Common height reserved; changeable later", "先按常见高度预留，之后可改"),
        },
      }, lang),
    ],
    skippable: true,
  };
}

/** 常见宽度的口语化说明。没有说法的就不编一个。 */
function widthDetail(
  kind: ApplianceKind,
  width: number,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): string | undefined {
  if (kind !== "refrigerator") return undefined;
  if (width === 30) {
    return msg(lang, "Narrow — common in small kitchens", "窄款——小厨房常见");
  }
  if (width === 33) return msg(lang, "Most common", "最常见");
  if (width === 36) {
    return msg(lang, "French door / side-by-side", "法式对开 / 对开门");
  }
  return undefined;
}

/**
 * 家电想放在哪。
 *
 * 位置是客户的偏好，不是几何推导的结果。排布器会尽量满足；满足不了要说明，
 * 不静默忽略——「你说想靠近入口，但那面墙放不下 35" 的冰箱位」是有用的信息。
 */
export function appliancePlacementQuestion(
  kind: ApplianceKind,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): PreferenceQuestion {
  const label = applianceLabel(kind, lang);
  const noPrice = msg(lang, "Doesn't change unit price", "不改变单价");
  return {
    key: "appliances",
    prompt: msg(lang, `Where should the ${label} go?`, `${label}想放在哪？`),
    why: msg(lang,
      `${label} placement drives the work triangle: fridge needs ≥15" landing on the handle side, `
        + "the range needs hot-pan landing on both sides, and sink + dishwasher stay together.",
      `${label}的位置影响工作三角：冰箱把手侧需 ≥15" 落台，`
        + "灶台两侧要能放热锅，水槽与洗碗机应相邻。"),
    multiSelect: false,
    options: [
      option({
        id: `${kind}:nearEntry`,
        label: msg(lang, "Near the entry", "靠近入口"),
        detail: msg(lang, "Drop groceries as you walk in", "进门就能放下菜"),
        priceImpact: { kind: "unknown", reason: noPrice },
        recommended: kind === "refrigerator",
      }, lang),
      option({
        id: `${kind}:nearSink`,
        label: msg(lang, "Near the sink", "靠近水槽"),
        priceImpact: { kind: "unknown", reason: noPrice },
      }, lang),
      option({
        id: `${kind}:any`,
        label: msg(lang, "Not sure — you decide", "不确定——你来定"),
        detail: msg(lang, "Place by ergonomics and traffic flow", "按人体工学与动线放置"),
        priceImpact: { kind: "unknown", reason: noPrice },
      }, lang),
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
export function budgetQuestion(
  ctx: BudgetContext,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): PreferenceQuestion | undefined {
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
    : msg(lang,
      " (Ranges use the platform reference catalog and are not fully verified item-by-item — for order-of-magnitude only.)",
      "（区间来自平台参考目录，尚未逐项核实——仅供量级感知。）");

  return {
    key: "budgetBand",
    prompt: msg(lang,
      `For a kitchen this size (about ${Math.round(inches)}" of base run), the cabinet portion usually lands in these bands — which fits you?`,
      `按这个厨房尺寸（地柜走长约 ${Math.round(inches)}"），柜体部分通常落在这些档位——哪一档更贴近你？`),
    why: msg(lang,
      `The band steers door-tier and accessory trade-offs. Cabinets only — no countertops, appliances, or install.${caveat}`,
      `档位会影响门板档次与配件取舍。仅柜体——不含台面、家电与安装。${caveat}`),
    multiSelect: false,
    options: [
      option({
        id: "economy",
        label: msg(lang, "Keep cost down", "尽量控制成本"),
        priceImpact: { kind: "range", low, high: mid },
      }, lang),
      option({
        id: "standard",
        label: msg(lang, "Mid range — value first", "中档——性价比优先"),
        priceImpact: { kind: "range", low: mid, high },
        recommended: true,
      }, lang),
      option({
        id: "premium",
        label: msg(lang, "No hard cap — finish first", "不设硬顶——效果优先"),
        priceImpact: {
          kind: "unknown",
          reason: msg(lang, "Depends on door and accessory choices", "取决于门板与配件选择"),
        },
      }, lang),
      option({
        id: "unsure",
        label: msg(lang, "Not sure yet — show options first", "还没想好——先看选项"),
        priceImpact: {
          kind: "unknown",
          reason: msg(lang, "Not chosen", "尚未选择"),
        },
      }, lang),
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
export function tradeoffQuestion(
  lang: UiLanguage = DEFAULT_LANGUAGE,
): PreferenceQuestion {
  return {
    key: "tradeoff",
    prompt: msg(lang,
      "If the budget needs trade-offs, which one do you want to keep first?",
      "预算需要取舍时，你最想先保住哪一项？"),
    why: msg(lang,
      "With this, later trade-offs can follow your priority instead of asking every time.",
      "有了这个，后续取舍可按你的优先级走，不必每次都问。"),
    multiSelect: false,
    options: [
      option({
        id: "price",
        label: msg(lang, "Total price", "总价"),
        detail: msg(lang, "Keep accessories and upgrades light", "配件与升级从简"),
        priceImpact: { kind: "included" },
      }, lang),
      option({
        id: "quality",
        label: msg(lang, "Materials & hardware", "板材与五金"),
        detail: msg(lang, "Panels can be plain; hardware shouldn't be", "面板可以朴素，五金别省"),
        priceImpact: { kind: "included" },
      }, lang),
      option({
        id: "lookAndFeel",
        label: msg(lang, "Look & finish", "观感与饰面"),
        detail: msg(lang, "Door style and color first", "门板样式与颜色优先"),
        priceImpact: { kind: "included" },
      }, lang),
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
  language?: UiLanguage;
}

/**
 * 生成本轮要问的问题。
 *
 * 顺序是有讲究的：先问影响面最大的（门板 → 价格组 → 整体价位），
 * 再问局部的（五金、配件）。反过来问会出现"先挑好了配件，一换门板价格全变"。
 */
export function buildQuestionSet(input: QuestionSetInput): PreferenceQuestion[] {
  const { bundle, answered } = input;
  const lang = input.language ?? DEFAULT_LANGUAGE;
  const all: (PreferenceQuestion | undefined)[] = [
    input.budget ? budgetQuestion(input.budget, lang) : undefined,
    bundle ? doorStyleQuestion(bundle, lang) : undefined,
    bundle ? boxMaterialQuestion(bundle, lang) : undefined,
    bundle ? storageQuestion(bundle, lang) : undefined,
    bundle ? assemblyQuestion(bundle, lang) : undefined,
    bundle
      ? hardwareQuestion(bundle, {
          ...(input.estimatedCabinetCount !== undefined
            ? { estimatedCabinetCount: input.estimatedCabinetCount } : {}),
          language: lang,
        })
      : undefined,
    bundle ? accessoryQuestion(bundle, lang) : undefined,
    tradeoffQuestion(lang),
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
    case "boxMaterial": return prefs.boxMaterialId !== undefined;
    case "assembly": return prefs.assembly !== undefined;
    case "storage": return prefs.storage !== undefined;
    case "hardware": return prefs.hardwareOptionIds !== undefined;
    case "accessories": return prefs.accessoryOptionIds !== undefined;
    case "tradeoff": return prefs.tradeoff !== undefined;
    // 家电问的是**这个厨房的物理事实**，答案存在 FloorPlan 上而不是偏好里
    // （贸易账号一个人有多个项目，各自的家电不同）。所以它们不走这条判断，
    // 由 buildApplianceQuestions 按户型自己的状态决定还该问什么。
    case "appliances":
    case "applianceWidths":
    case "applianceHeights": return false;
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
  language?: UiLanguage;
}): PreferenceQuestion[] {
  const lang = input.language ?? DEFAULT_LANGUAGE;
  if (!input.kindsAnswered) return [applianceQuestion(lang)];

  // 只对**推定尺寸**的家电追问宽度——客户已经给了准确数字的不再打扰。
  // 宽度还没定的先问宽度，冰箱高度等宽度确认后再问——一件件来，不一次甩两问。
  const out: PreferenceQuestion[] = [];
  for (const a of input.known) {
    if (a.provenance === "assumed") {
      const q = applianceWidthQuestion(a.kind, lang);
      if (q) out.push(q);
      continue;
    }
    if (a.kind === "refrigerator" && a.heightProvenance === "assumed") {
      const q = applianceHeightQuestion(lang);
      if (q) out.push(q);
    }
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
      throw new PreferenceError(`Door style ${raw.doorStyleId} is not in this company's catalog`);
    }
    company.doorStyleId = raw.doorStyleId;
  }
  if (raw.boxMaterialId !== undefined) {
    if (!bundle?.boxMaterialOptions?.some((m) => m.id === raw.boxMaterialId)) {
      throw new PreferenceError(`Box material ${raw.boxMaterialId} is not in this company's catalog`);
    }
    company.boxMaterialId = raw.boxMaterialId;
  }
  if (raw.hardwareOptionIds !== undefined) {
    company.hardwareOptionIds = checkIds(raw.hardwareOptionIds, bundle?.hardwareOptions ?? [], "Hardware");
  }
  if (raw.accessoryOptionIds !== undefined) {
    company.accessoryOptionIds = checkIds(raw.accessoryOptionIds, bundle?.accessoryOptions ?? [], "Accessory");
  }

  if (raw.assembly !== undefined) {
    if (raw.assembly !== "RTA" && raw.assembly !== "assembled") {
      throw new PreferenceError("Assembly must be RTA or assembled");
    }
    shared.assembly = raw.assembly;
  }
  if (raw.storage !== undefined) {
    if (!["drawers", "doors", "balanced"].includes(raw.storage)) {
      throw new PreferenceError("Storage preference must be drawers / doors / balanced");
    }
    shared.storage = raw.storage;
  }
  if (raw.budgetBand !== undefined) {
    if (!["economy", "standard", "premium", "unsure"].includes(raw.budgetBand)) {
      throw new PreferenceError("Invalid budget band");
    }
    shared.budgetBand = raw.budgetBand;
  }
  if (raw.tradeoff !== undefined) {
    if (!["price", "quality", "lookAndFeel"].includes(raw.tradeoff)) {
      throw new PreferenceError("Invalid trade-off priority");
    }
    shared.tradeoff = raw.tradeoff;
  }
  if (raw.language !== undefined) {
    if (raw.language !== "en" && raw.language !== "zh") {
      throw new PreferenceError("language must be en or zh");
    }
    shared.language = raw.language;
  }
  if (raw.layoutHints !== undefined && typeof raw.layoutHints === "object") {
    shared.layoutHints = { ...raw.layoutHints };
  }
  return { shared, company };
}

function checkIds(ids: unknown, known: readonly { id: string }[], label: string): string[] {
  if (!Array.isArray(ids)) throw new PreferenceError(`${label} selection must be an array`);
  const set = new Set(known.map((k) => k.id));
  for (const id of ids) {
    if (typeof id !== "string" || !set.has(id)) {
      throw new PreferenceError(`${label} ${String(id)} is not in this company's catalog`);
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
  lang: UiLanguage = DEFAULT_LANGUAGE,
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
      const assembled = prefs.assembly === "assembled";
      notes.push(msg(lang,
        `${cannot.join(", ")} do not offer ${assembled ? "assembled" : "RTA"} shipping; ` +
        `those cabinets ship ${assembled ? "flat-pack" : "assembled"} — ` +
        `most sellers only assemble base cabinets.`,
        `${cannot.join("、")} 不提供「${assembled ? "组装好发货" : "平板发货"}」，` +
        `这几个柜体按${assembled ? "平板" : "组装好"}发货——` +
        `多数公司只对地柜提供组装服务。`,
      ));
    }
  }

  for (const [ids, pool, labelEn, labelZh] of [
    [prefs.accessoryOptionIds ?? [], bundle.accessoryOptions, "Accessory", "配件"],
    [prefs.hardwareOptionIds ?? [], bundle.hardwareOptions, "Hardware", "五金"],
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
        notes.push(msg(lang,
          `${labelEn} "${opt.name}" doesn't fit any cabinet in this layout — not included in the quote.`,
          `${labelZh}「${opt.name}」在这版方案的柜体上都装不了，未计入报价。`,
        ));
      }
    }
  }
  return notes;
}
