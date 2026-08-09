/**
 * 加拿大各省税率 —— 平台共享层，带生效区间（REQUIREMENTS 3.5.3 / LAUNCH_BLOCKERS A1/A2）。
 *
 * ## 核实记录（A1/A2）
 *
 * - **核实日期**：2026-08-08
 * - **GST/HST + PST 表**：CRA《GST/HST calculator (and rates)》
 *   https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/calculator.html
 *   （页面 Date modified: 2025-04-01；含 NS 自 2025-04-01 起 HST 14%）
 * - **计税基数**：CRA 同页说明 PST 省份对 GST 以不含 PST 的价格计征；
 *   本表 GST+PST / GST+QST 均用 `compounded: false`（各税种以税前价为基数）。
 * - **A2 · QST**：自 2013-01-01 起 QST 9.975% 以**不含 GST** 的对价计征（非复合）。
 *   依据魁北克财政部 Information Bulletin 2012-4：
 *   https://www.finances.gouv.qc.ca/documents/bulletins/en/bulen_2012-4-a-b.pdf
 * - 税率会变 → 复核周期 365 天（`VERIFIED_TAX_RATES`）。Manitoba 省内亦称 RST，
 *   报价分项名仍用 PST（与 CRA 计算器表一致）。
 */
import type { Province, TaxRule } from "../domain/types.js";

const FOREVER_AGO = "1900-01-01T00:00:00.000Z";

/** 种子数据。effectiveTo 为空表示当前仍生效。 */
export const SEED_TAX_RULES: TaxRule[] = [
  // 仅 GST 5% —— CRA 表：AB / NT / NU / YT
  ...(["AB", "NT", "NU", "YT"] as Province[]).map((province) => ({
    id: `tax_${province}_gst5`,
    province,
    components: [{ name: "GST" as const, ratePercent: 5 }],
    compounded: false,
    effectiveFrom: FOREVER_AGO,
  })),
  // GST + PST —— CRA 表：BC 7% / SK 6% / MB 7%
  {
    id: "tax_BC", province: "BC",
    components: [{ name: "GST", ratePercent: 5 }, { name: "PST", ratePercent: 7 }],
    compounded: false, effectiveFrom: FOREVER_AGO,
  },
  {
    id: "tax_SK", province: "SK",
    components: [{ name: "GST", ratePercent: 5 }, { name: "PST", ratePercent: 6 }],
    compounded: false, effectiveFrom: FOREVER_AGO,
  },
  {
    id: "tax_MB", province: "MB",
    components: [{ name: "GST", ratePercent: 5 }, { name: "PST", ratePercent: 7 }],
    compounded: false, effectiveFrom: FOREVER_AGO,
  },
  // GST + QST（A2：2013-01-01 起非复合，QST 9.975% 以税前价为基数）
  {
    id: "tax_QC", province: "QC",
    components: [{ name: "GST", ratePercent: 5 }, { name: "QST", ratePercent: 9.975 }],
    compounded: false, effectiveFrom: FOREVER_AGO,
  },
  // HST —— CRA 表：ON 13%；NB / NL / PE 15%
  {
    id: "tax_ON", province: "ON",
    components: [{ name: "HST", ratePercent: 13 }],
    compounded: false, effectiveFrom: FOREVER_AGO,
  },
  ...(["NB", "NL", "PE"] as Province[]).map((province) => ({
    id: `tax_${province}_hst15`,
    province,
    components: [{ name: "HST" as const, ratePercent: 15 }],
    compounded: false,
    effectiveFrom: FOREVER_AGO,
  })),
  // NS：CRA — 2025-04-01 起省级部分降至 9%，HST 合计 14%
  {
    id: "tax_NS_hst15", province: "NS",
    components: [{ name: "HST", ratePercent: 15 }],
    compounded: false,
    effectiveFrom: FOREVER_AGO,
    effectiveTo: "2025-04-01T00:00:00.000Z",
  },
  {
    id: "tax_NS_hst14", province: "NS",
    components: [{ name: "HST", ratePercent: 14 }],
    compounded: false,
    effectiveFrom: "2025-04-01T00:00:00.000Z",
  },
];

export class TaxRuleNotFoundError extends Error {
  constructor(readonly province: Province, readonly at: string) {
    super(`未找到 ${province} 在 ${at} 生效的税率规则`);
    this.name = "TaxRuleNotFoundError";
  }
}

/**
 * 取某省在某时刻生效的税率规则。
 *
 * 区间语义为**左闭右开** `[effectiveFrom, effectiveTo)`，因此边界当天
 * （如 2025-04-01T00:00:00Z）取到的是新税率，不会出现两条同时命中。
 */
export function resolveTaxRule(
  rules: readonly TaxRule[],
  province: Province,
  at: string,
): TaxRule {
  const t = Date.parse(at);
  const hit = rules.find(
    (r) =>
      r.province === province &&
      Date.parse(r.effectiveFrom) <= t &&
      (r.effectiveTo === undefined || t < Date.parse(r.effectiveTo)),
  );
  if (!hit) throw new TaxRuleNotFoundError(province, at);
  return hit;
}

/** 合计税率（仅用于展示，实际计算按分项进行以保证四舍五入正确）。 */
export function totalRatePercent(rule: TaxRule): number {
  return rule.components.reduce((sum, c) => sum + c.ratePercent, 0);
}
