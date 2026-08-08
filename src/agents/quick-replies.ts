/**
 * 快捷回答 —— 开放式问题旁边的那几个可点选项。
 *
 * ## 为什么需要
 *
 * 「What's your preferred kitchen style?」后面跟一串括号例子，客户读完
 * 还是不知道答案该有多长。给可点选项，或至少告诉他"a short phrase is fine"。
 *
 * `preferences/questions.ts` 那套选择题解决的是**有公司上下文之后**的偏好；
 * 这里补的是还没 @ 任何公司之前的尺寸 / 布局 / 风格 / 预算 / 省份。
 *
 * ## 一条纪律
 *
 * 选项文字就是**客户点了之后原样发出去的那句话**，不是标签。
 * 随后 `missingFields` 的关键词表必须认得它。
 */
import type { UiLanguage } from "../i18n/language.js";
import { DEFAULT_LANGUAGE } from "../i18n/language.js";

export interface QuickReply {
  /** 缺哪个字段。与 `missingFields` 的返回值同名。 */
  field: string;
  /** 提示语——告诉客户"回一个词就行"。 */
  hint: string;
  /** 可点选项。点了就把这段文字当成客户的话发出去。 */
  options: string[];
  /** 除了点选，还能怎么答（上传户型图之类）。 */
  alternative?: string;
}

type CatalogEntry = Omit<QuickReply, "field">;

const CATALOG_EN: Record<string, CatalogEntry> = {
  "kitchen size": {
    hint: "A rough size is fine — e.g. \"one wall ~12 ft\"",
    options: [
      "One wall ~8 ft",
      "One wall ~12 ft",
      "Two walls ~10 ft each",
      "Kitchen ~100 sq ft",
    ],
    alternative: "Upload a floor plan for more accuracy — we can read sizes from the drawing.",
  },
  layout: {
    hint: "Tap one",
    options: ["I-shape", "L-shape", "U-shape", "With island"],
  },
  style: {
    hint: "A short phrase is fine — e.g. \"modern\"",
    options: ["Modern", "Farmhouse", "Nordic", "Transitional", "Traditional"],
  },
  budget: {
    hint: "A range is fine; \"not sure yet\" works too",
    options: [
      "Budget under CAD $10k",
      "Budget CAD $10–20k",
      "Budget over CAD $20k",
      "Budget not decided yet",
    ],
  },
  province: {
    hint: "Province is required for tax",
    options: [
      "Ontario ON",
      "British Columbia BC",
      "Alberta AB",
      "Quebec QC",
    ],
  },
};

const CATALOG_ZH: Record<string, CatalogEntry> = {
  "kitchen size": {
    hint: "报个大概就行，比如「一面墙 12 尺」",
    options: ["一面墙 8 尺左右", "一面墙 12 尺左右", "两面墙各 10 尺左右", "厨房约 100 平方尺"],
    alternative: "直接上传户型图更准——从图上读出来的数不用你量。",
  },
  layout: {
    hint: "点一个就行",
    options: ["一字型", "L 型", "U 型", "带岛台"],
  },
  style: {
    hint: "回两个字就行，比如「现代简约」",
    options: ["现代简约", "美式乡村", "北欧", "轻奢", "传统欧式"],
  },
  budget: {
    hint: "给个范围就行，不确定也可以直说",
    options: ["预算 1 万加币以内", "预算 1-2 万加币", "预算 2 万加币以上", "预算还没想好"],
  },
  province: {
    hint: "省份用来算税，必填",
    options: ["安大略省 ON", "不列颠哥伦比亚省 BC", "阿尔伯塔省 AB", "魁北克省 QC"],
  },
};

/**
 * 本轮该给哪些快捷回答。
 *
 * `limit` 与助手本轮问了几个问题对齐。
 */
export function quickRepliesFor(
  missing: readonly string[],
  limit = 2,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): QuickReply[] {
  const catalog = lang === "zh" ? CATALOG_ZH : CATALOG_EN;
  return missing
    .slice(0, Math.max(0, limit))
    .flatMap((field) => {
      const entry = catalog[field];
      return entry ? [{ field, ...entry }] : [];
    });
}

/**
 * 给 LLM 的提问纪律。
 *
 * 光有按钮不够：模型仍然会写出很长的括号列举。system prompt 里要明确要求短答案。
 */
export function askStyleRules(lang: UiLanguage = DEFAULT_LANGUAGE): string {
  if (lang === "zh") {
    return [
      "提问纪律：",
      "- 每个问题都要让客户**能用几个字答完**。不确定时，直接说「回一个词就行」。",
      "- 举例最多给三个，写成「比如现代简约」，不要罗列五六个再加一个「等」。",
      "- 不要问「您的需求是什么」这类没有答案形状的问题。",
      "- 客户已经答过的，不要换个说法再问一遍。",
    ].join("\n");
  }
  return [
    "Asking style:",
    "- Every question must be answerable in a few words. When unsure, say \"a short phrase is fine\".",
    "- Give at most three examples (e.g. \"modern\"), never a long laundry list.",
    "- Don't ask shapeless questions like \"What are your requirements?\".",
    "- Don't re-ask something the customer already answered.",
  ].join("\n");
}

/** @deprecated 用 `askStyleRules(lang)`。默认英文。 */
export const ASK_STYLE_RULES = askStyleRules("en");
