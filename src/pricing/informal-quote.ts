/**
 * 厂商 Agent 的非正式报价——MSRP + 标准折扣。
 *
 * 这不是正式 Quote 流程（那条路走 `pricing/engine.ts`，产出带税费/运费/
 * 快照字段的完整报价单）。这里只回答"这个型号大概多少钱"，给厂商 Agent
 * 在聊天里直接引用的一句话事实——**价格必须在这里算好，Agent 只负责转述
 * 数字，不允许自己做加减乘除**（与规格清单注入 system prompt 是同一个
 * "确定性计算，LLM 只narrate"的做法）。
 *
 * 折扣只认一条：`audience: "consumer"` + `kind: "percentOffList"` +
 * `autoQuotable: true` + 未按价格组细分。厂商的「标准折扣」按设计只支持
 * 全店统一一档——按品类/价格组分档的折扣只在正式 Quote 里参与计算。
 */
import { format, percentOf, sub, type Money } from "../domain/money.js";
import type { DiscountRule, ModuleSpec } from "../domain/types.js";
import type { SpecBundle } from "../spec/bundle.js";

/** 找出这家公司「可自动引用」的标准折扣——至多一条，找不到就是没有。 */
export function standardAutoQuotableDiscount(bundle: SpecBundle): DiscountRule | undefined {
  return bundle.discountRules.find((r) =>
    r.audience === "consumer"
    && r.kind === "percentOffList"
    && r.autoQuotable
    && !r.appliesToPriceGroupIds?.length
    && typeof r.value === "number" && r.value > 0);
}

export interface ModulePriceSummary {
  moduleId: string;
  code: string;
  minListPrice: Money;
  maxListPrice: Money;
  standardDiscountPercent?: number;
  minDiscountedPrice?: Money;
  maxDiscountedPrice?: Money;
}

/** 某型号在价格矩阵里的价格区间（跨价格组），叠加标准折扣（若有）。 */
export function priceSummaryForModule(
  bundle: SpecBundle,
  module: ModuleSpec,
): ModulePriceSummary | undefined {
  const entries = bundle.priceMatrix.filter((e) => e.moduleId === module.id);
  if (entries.length === 0) return undefined;
  const prices = entries.map((e) => e.listPrice);
  const minListPrice = prices.reduce((a, b) => (b < a ? b : a));
  const maxListPrice = prices.reduce((a, b) => (b > a ? b : a));

  const rule = standardAutoQuotableDiscount(bundle);
  if (!rule?.value) {
    return { moduleId: module.id, code: module.code, minListPrice, maxListPrice };
  }
  return {
    moduleId: module.id,
    code: module.code,
    minListPrice,
    maxListPrice,
    standardDiscountPercent: rule.value,
    minDiscountedPrice: sub(minListPrice, percentOf(minListPrice, rule.value)),
    maxDiscountedPrice: sub(maxListPrice, percentOf(maxListPrice, rule.value)),
  };
}

/** 渲染成一句话价格提示，供注入 system prompt（不含任何需要 LLM 计算的部分）。 */
export function formatModulePriceHint(
  summary: ModulePriceSummary,
  language: "en" | "zh" = "en",
): string {
  const range = (lo: Money, hi: Money) => (lo === hi ? format(lo) : `${format(lo)}–${format(hi)}`);
  const list = range(summary.minListPrice, summary.maxListPrice);
  if (summary.standardDiscountPercent && summary.minDiscountedPrice && summary.maxDiscountedPrice) {
    const disc = range(summary.minDiscountedPrice, summary.maxDiscountedPrice);
    return language === "zh"
      ? `原价${list}，标准折扣-${summary.standardDiscountPercent}%后约${disc}`
      : `MSRP ${list}, ~${disc} after standard ${summary.standardDiscountPercent}% off`;
  }
  return language === "zh" ? `原价${list}（暂无标准折扣）` : `MSRP ${list} (no standard discount on file)`;
}
