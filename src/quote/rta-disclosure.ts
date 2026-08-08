/**
 * 「这里卖的是 RTA，不是全定制」—— 措辞只有一份（每种语言各一份）。
 *
 * ## 为什么这件事必须**预先**说
 *
 * 客户拿着一份 $17,000 的报价来，脑子里想的是「定制橱柜」：任意尺寸、
 * 上门量尺、师傅安装、想改哪儿改哪儿。而他买到的是 RTA：
 * 尺寸只有几个固定档、板件平装发货、多数情况要自己或另找人装。
 *
 * 这两件事的差价能到一半以上，**但那不是"便宜"，是不同的东西**。
 * 等到货到了才发现，那已经不是解释得清的阶段了——那是投诉和退货。
 * 所以：开场就说，报价单上再说一遍，不等客户问。
 *
 * ## 为什么不能只写在报价单末尾
 *
 * 报价单是客户**已经把方案做完之后**才看到的。等到那时候，他已经为这套方案
 * 花了半小时、已经在心里跟别家的定制报价比过了。这时候才说"顺便说一句，
 * 这是需要自己组装的板件"，客户会觉得是被绕进来的。
 *
 * 所以分两处，同一套措辞：
 *   - `rtaIntro(lang)`：开场白，客户还没投入任何东西的时候；
 *   - `rtaQuoteNote(lang)`：报价单末尾，签字之前的最后一次。
 *
 * ## 这里不做贬低，也不做美化
 *
 * RTA 是一种正当的产品形态：同样的板材五金，省掉的是仓储、组装工时和
 * 设计师抽成。写清楚它**是什么**、**不是什么**，客户自己判断值不值。
 */
import type { UiLanguage } from "../i18n/language.js";
import { DEFAULT_LANGUAGE } from "../i18n/language.js";

/** 一条差异：RTA 这边是什么、全定制那边是什么。 */
export interface RtaDifference {
  aspect: string;
  rta: string;
  custom: string;
}

const DIFFERENCES_EN: readonly RtaDifference[] = [
  {
    aspect: "Size",
    rta: "Only the manufacturer's fixed sizes (usually 3\" steps); leftover gaps get fillers",
    custom: "Any size, built to your walls",
  },
  {
    aspect: "How it arrives",
    rta: "Flat-packed panels that need assembly (many sellers offer paid assembly as a line item)",
    custom: "Fully built cabinets delivered ready to hang",
  },
  {
    aspect: "Installation",
    rta: "No on-site install — DIY or hire a separate installer",
    custom: "Usually includes measuring and installation",
  },
  {
    aspect: "Changes",
    rta: "Changing size means changing SKU; leftovers are handled with fillers and panels",
    custom: "Almost anything can change while drawings are open",
  },
  {
    aspect: "Price",
    rta: "Skips assembly labor, warehousing, and design markup — often about half of custom",
    custom: "Includes design, measuring, assembly, and install",
  },
];

const DIFFERENCES_ZH: readonly RtaDifference[] = [
  {
    aspect: "尺寸",
    rta: "只有厂家给的固定档（多数是 3\" 一跳），排不满的地方用填缝条补",
    custom: "任意尺寸，按你的墙实际做",
  },
  {
    aspect: "到货状态",
    rta: "板件平装成箱发货，需要组装（多数商家可加价代装，报价里会单列）",
    custom: "整柜做好运到，直接上墙",
  },
  {
    aspect: "安装",
    rta: "不含上门安装，要自己装或另请安装工",
    custom: "通常含上门量尺与安装",
  },
  {
    aspect: "改动",
    rta: "改尺寸=换型号，改不了的地方靠填缝条和收口板处理",
    custom: "图纸阶段想怎么改都行",
  },
  {
    aspect: "价格",
    rta: "省掉组装工时、仓储与设计费，通常是定制的一半上下",
    custom: "含设计、量尺、组装、安装",
  },
];

/** 默认语言（英文）的差异表。测试与旧调用仍可直接读。 */
export const RTA_DIFFERENCES: readonly RtaDifference[] = DIFFERENCES_EN;

export function rtaDifferences(lang: UiLanguage = DEFAULT_LANGUAGE): readonly RtaDifference[] {
  return lang === "zh" ? DIFFERENCES_ZH : DIFFERENCES_EN;
}

const INTRO_EN =
  "One thing upfront so we don't talk past each other: quotes here are for **RTA " +
  "(ready-to-assemble) cabinets**, not fully custom. Sizes come in the manufacturer's " +
  "fixed steps, they ship flat-packed and need assembly, and installation is not included — " +
  "the price is often about half of custom, but that's because it **is a different product**, " +
  "not the same thing sold cheaper. Ask anytime: \"What's the difference between RTA and custom?\"";

const INTRO_ZH =
  "先说清楚一件事，免得后面误会：这里报的是 **RTA 板式橱柜**（ready-to-assemble），" +
  "不是全定制。尺寸只有厂家的固定档，板件平装发货、需要组装，也不含上门安装——" +
  "价格通常是定制的一半上下，但那是因为它**是另一种东西**，不是同样的东西便宜卖。" +
  "想知道具体差在哪，随时问我「RTA 和定制有什么区别」。";

/** @deprecated 用 `rtaIntro(lang)`；保留英文默认以兼容旧引用。 */
export const RTA_INTRO = INTRO_EN;

export function rtaIntro(lang: UiLanguage = DEFAULT_LANGUAGE): string {
  return lang === "zh" ? INTRO_ZH : INTRO_EN;
}

const QUOTE_NOTE_EN =
  "[About this quote]\n" +
  "  This is an **RTA (ready-to-assemble)** cabinet quote: cabinets ship as flat panels " +
  "and need assembly; on-site installation is not included.\n" +
  "  Sizes come from this seller's fixed catalog steps; leftover gaps get fillers — " +
  "that is not the same as \"custom built to your walls.\"\n" +
  "  Factor that in when you compare this to a custom-cabinet quote.";

const QUOTE_NOTE_ZH =
  "【关于这份报价】\n" +
  "  这是 **RTA 板式橱柜**的报价：柜体以板件平装发货，需要组装；不含上门安装。\n" +
  "  尺寸取自该商家的固定档，排不满的位置用填缝条补——这与「按你的墙定制」不是一回事。\n" +
  "  拿它与定制橱柜的报价对比时请把这一点算进去。";

/** @deprecated 用 `rtaQuoteNote(lang)`。 */
export const RTA_QUOTE_NOTE = QUOTE_NOTE_EN;

export function rtaQuoteNote(lang: UiLanguage = DEFAULT_LANGUAGE): string {
  return lang === "zh" ? QUOTE_NOTE_ZH : QUOTE_NOTE_EN;
}

/** 给对话用的详细对照。客户问「RTA 和定制有什么区别」时回这个。 */
export function renderRtaComparison(lang: UiLanguage = DEFAULT_LANGUAGE): string {
  if (lang === "zh") {
    const rows = DIFFERENCES_ZH.map(
      (d) => `· ${d.aspect}\n    RTA：${d.rta}\n    定制：${d.custom}`);
    return [
      "RTA（ready-to-assemble，板式待组装）与全定制橱柜的区别：",
      "",
      ...rows,
      "",
      "两者用的板材与五金可以是同一档次，差的是**做法**，不是**质量**。" +
      "会自己动手、或者能找到安装工，RTA 很划算；想省心、墙不方正、" +
      "或者对尺寸有特殊要求，定制更合适。",
    ].join("\n");
  }

  const rows = DIFFERENCES_EN.map(
    (d) => `· ${d.aspect}\n    RTA: ${d.rta}\n    Custom: ${d.custom}`);
  return [
    "RTA (ready-to-assemble) vs fully custom cabinets:",
    "",
    ...rows,
    "",
    "Materials and hardware can be the same grade — the difference is **how it's made**, " +
    "not **quality**. If you'll assemble (or hire someone) and your walls are fairly square, " +
    "RTA is a strong value. If you want hands-off service, out-of-square walls, or " +
    "one-off sizes, custom is the better fit.",
  ].join("\n");
}

/**
 * 客户这句话是不是在问 RTA 与定制的区别。
 *
 * 判定**偏宽**是故意的：多解释一次这件事没有代价，漏掉一次的代价是客户
 * 按定制的预期下单。所以只要提到 RTA 或定制、并且带着一个疑问的口气，
 * 就当作在问。
 *
 * 但不能宽到把「门板要定制颜色吗」这种也吃掉——那会在客户答需求时
 * 突然甩一段产品介绍。所以疑问口气必须真的出现。
 */
export function asksAboutRta(text: string): boolean {
  const t = text.toLowerCase();
  const mentionsRta = /rta|待组装|板式|自己组装|自己装|需要组装|ready[\s-]?to[\s-]?assemble|flat[\s-]?pack/.test(t);
  const mentionsCustom = /定制|订制|custom/.test(t);
  const asksDiff =
    /区别|差别|不一样|不同|差在哪|是什么|什么是|啥是|是啥|有啥|怎么回事/.test(t)
    || /\b(difference|different|vs\.?|versus|what is|what's|how does .+ differ)\b/.test(t);
  return (mentionsRta || mentionsCustom) && asksDiff;
}
