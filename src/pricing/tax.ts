/**
 * 加拿大各省税率 —— 平台共享层，带生效区间（REQUIREMENTS 3.5.3）。
 *
 * ⚠️ 这里的税率是**按撰写时公开信息整理的种子数据，上线前必须由运营逐条重新核对**
 *    （PRE_LAUNCH_CHECKLIST A1/A2），核对时请记录来源 URL 与查询日期。
 *    之所以把它建成带生效区间的数据而不是常量，就是因为税率会变——
 *    例如 NS 于 2025-04-01 由 15% 降至 14%。
 */
import type { Province, TaxRule } from "../domain/types.js";

const FOREVER_AGO = "1900-01-01T00:00:00.000Z";

/** 种子数据。effectiveTo 为空表示当前仍生效。 */
export const SEED_TAX_RULES: TaxRule[] = [
  // 仅 GST 5%
  ...(["AB", "NT", "NU", "YT"] as Province[]).map((province) => ({
    id: `tax_${province}_gst5`,
    province,
    components: [{ name: "GST" as const, ratePercent: 5 }],
    compounded: false,
    effectiveFrom: FOREVER_AGO,
  })),
  // GST + PST
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
  // GST + QST（现行非复合：QST 以不含 GST 的金额为基数）
  {
    id: "tax_QC", province: "QC",
    components: [{ name: "GST", ratePercent: 5 }, { name: "QST", ratePercent: 9.975 }],
    compounded: false, effectiveFrom: FOREVER_AGO,
  },
  // HST
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
  // NS：2025-04-01 由 15% 降至 14%，两条记录并存，按报价日期取用
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
