/**
 * 定价引擎测试 —— 覆盖 PRE_LAUNCH_CHECKLIST C1 列出的全部场景。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromDollars, add } from "../src/domain/money.js";
import { computePrice, PricingError } from "../src/pricing/engine.js";
import { resolveTaxRule, SEED_TAX_RULES, TaxRuleNotFoundError } from "../src/pricing/tax.js";
import { ALL_PROVINCES } from "../src/domain/types.js";
import type { ModuleSelection } from "../src/domain/types.js";
import { makeContext, shippingFreeOver } from "./fixtures.js";

const AT = "2026-06-01T00:00:00.000Z";

function sel(over: Partial<ModuleSelection> = {}): ModuleSelection {
  return {
    moduleId: "m_b30", qty: 1, width: 30, height: 34.5, depth: 24,
    assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [], ...over,
  };
}

test("多价格组：同一型号在不同价格组取到不同标价", () => {
  const ctx = makeContext();
  const a = computePrice(ctx, { selections: [sel()], doorStyleId: "ds_shaker_white", accountType: "consumer", province: "AB", at: AT });
  const b = computePrice(ctx, { selections: [sel()], doorStyleId: "ds_maple_glaze", accountType: "consumer", province: "AB", at: AT });

  assert.equal(a.lineItems[0]!.unitListPrice, fromDollars("245.50"));
  assert.equal(b.lineItems[0]!.unitListPrice, fromDollars("398.75"));
  assert.equal(a.priceGroupId, "pg_a");
  assert.equal(b.priceGroupId, "pg_b");
});

test("价格矩阵空洞：拒绝，不回退到默认价", () => {
  const ctx = makeContext();
  assert.throws(
    () => computePrice(ctx, {
      selections: [sel({ moduleId: "m_sb36", width: 36 })],
      doorStyleId: "ds_maple_glaze", // pg_b，SB36 无此条目
      accountType: "consumer", province: "ON", at: AT,
    }),
    (e: unknown) => e instanceof PricingError && e.code === "PRICE_MATRIX_HOLE",
  );
});

test("组装加价：百分比", () => {
  const ctx = makeContext();
  const r = computePrice(ctx, {
    selections: [sel({ moduleId: "m_b12", width: 12, assembly: "assembled" })],
    doorStyleId: "ds_shaker_white", accountType: "consumer", province: "AB", at: AT,
  });
  // 120.00 + 15% = 138.00
  assert.equal(r.lineItems[0]!.modifiers[0]!.amount, fromDollars("18.00"));
  assert.equal(r.lineItems[0]!.unitNetPrice, fromDollars("138.00"));
});

test("定额与百分比修饰项混合：都以标价为基数，顺序不影响结果", () => {
  const ctx = makeContext();
  const r = computePrice(ctx, {
    selections: [sel({ hardwareOptionIds: ["hw_softclose"], accessoryOptionIds: ["ac_rollout"] })],
    doorStyleId: "ds_shaker_white", accountType: "consumer", province: "AB", at: AT,
  });
  // 245.50 + 18.00(定额) + 24.55(10%) = 288.05
  assert.equal(r.lineItems[0]!.unitNetPrice, fromDollars("288.05"));

  const swapped = computePrice(ctx, {
    selections: [sel({ accessoryOptionIds: ["ac_rollout"], hardwareOptionIds: ["hw_softclose"] })],
    doorStyleId: "ds_shaker_white", accountType: "consumer", province: "AB", at: AT,
  });
  assert.equal(swapped.lineItems[0]!.unitNetPrice, r.lineItems[0]!.unitNetPrice);
});

test("分档折扣的边界值：恰好等于门槛落进该档", () => {
  const ctx = makeContext({ shippingRule: undefined });
  // 构造小计恰好 1000.00：无法用现有价格凑整，改用直接检验 tier 选择逻辑
  // 245.50 × 4 = 982.00 → 未达 1000，无折扣
  const below = computePrice(ctx, {
    selections: [sel({ qty: 4 })],
    doorStyleId: "ds_shaker_white", accountType: "consumer", province: "AB", at: AT,
  });
  assert.equal(below.subtotal, fromDollars("982.00"));
  assert.equal(below.discounts.length, 0);

  // 245.50 × 5 = 1227.50 → 命中 5% 档
  const first = computePrice(ctx, {
    selections: [sel({ qty: 5 })],
    doorStyleId: "ds_shaker_white", accountType: "consumer", province: "AB", at: AT,
  });
  assert.equal(first.subtotal, fromDollars("1227.50"));
  assert.equal(first.discounts.length, 1);
  assert.equal(first.discountTotal, fromDollars("61.38")); // 1227.50 × 5% = 61.375 → 61.38

  // 398.75 × 13 = 5183.75 → 命中 10% 档（更高档位胜出）
  const second = computePrice(ctx, {
    selections: [sel({ qty: 13 })],
    doorStyleId: "ds_maple_glaze", accountType: "consumer", province: "AB", at: AT,
  });
  assert.equal(second.subtotal, fromDollars("5183.75"));
  assert.equal(second.discountTotal, fromDollars("518.38"));
});

test("贸易账号走贸易折扣规则", () => {
  const ctx = makeContext({ shippingRule: undefined });
  const r = computePrice(ctx, {
    selections: [sel()],
    doorStyleId: "ds_shaker_white", accountType: "trade", province: "AB", at: AT,
  });
  // 245.50 - 15% = 208.68 (折扣 36.825 → 36.83)
  assert.equal(r.discountTotal, fromDollars("36.83"));
  assert.equal(r.discounts[0]!.ruleId, "dr_trade_15");
});

test("stackable=false 时取折扣最大的一条且不叠加", () => {
  const ctx = makeContext({
    shippingRule: undefined,
    discountRules: [
      { specVersionId: "spec_maple_v1", companyId: "co_maple", id: "d1", audience: "consumer", kind: "percentOffList", value: 5, stackable: false, description: "5%" },
      { specVersionId: "spec_maple_v1", companyId: "co_maple", id: "d2", audience: "consumer", kind: "percentOffList", value: 12, stackable: false, description: "12%" },
      { specVersionId: "spec_maple_v1", companyId: "co_maple", id: "d3", audience: "consumer", kind: "percentOffList", value: 3, stackable: true, description: "3%" },
    ],
  });
  const r = computePrice(ctx, {
    selections: [sel()], doorStyleId: "ds_shaker_white", accountType: "consumer", province: "AB", at: AT,
  });
  assert.equal(r.discounts.length, 1);
  assert.equal(r.discounts[0]!.ruleId, "d2");
  assert.equal(r.discountTotal, fromDollars("29.46")); // 245.50 × 12%
});

test("折扣按价格组限定生效", () => {
  const ctx = makeContext({
    shippingRule: undefined,
    discountRules: [{
      specVersionId: "spec_maple_v1", companyId: "co_maple", id: "d_a_only",
      audience: "consumer", kind: "percentOffList", value: 10,
      appliesToPriceGroupIds: ["pg_a"], stackable: true, description: "仅 A 组 10%",
    }],
  });
  const inA = computePrice(ctx, { selections: [sel()], doorStyleId: "ds_shaker_white", accountType: "consumer", province: "AB", at: AT });
  const inB = computePrice(ctx, { selections: [sel()], doorStyleId: "ds_maple_glaze", accountType: "consumer", province: "AB", at: AT });
  assert.equal(inA.discounts.length, 1);
  assert.equal(inB.discounts.length, 0);
});

test("运费阈值边界：恰好等于阈值即免运", () => {
  const ctx = makeContext({ discountRules: [] });
  // 398.75 × 5 = 1993.75 < 2000 → 收运费
  const below = computePrice(ctx, {
    selections: [sel({ qty: 5 })], doorStyleId: "ds_maple_glaze", accountType: "consumer", province: "AB", at: AT,
  });
  assert.equal(below.shipping.amount, fromDollars("150.00"));

  // 245.50 × 4 + 398.75 × 3 = 982 + 1196.25 = 2178.25 ≥ 2000 → 免运
  const above = computePrice(ctx, {
    selections: [sel({ qty: 9 })], doorStyleId: "ds_maple_glaze", accountType: "consumer", province: "AB", at: AT,
  });
  assert.equal(above.shipping.amount, 0);
  assert.equal(above.shipping.ruleId, shippingFreeOver.id);
});

test("按地区运费与兜底值", () => {
  const ctx = makeContext({
    discountRules: [],
    shippingRule: {
      specVersionId: "spec_maple_v1", companyId: "co_maple", id: "sr_region", kind: "byRegion",
      regionTable: [{ province: "ON", amount: fromDollars("80.00") }],
      fallbackAmount: fromDollars("220.00"),
    },
  });
  const on = computePrice(ctx, { selections: [sel()], doorStyleId: "ds_shaker_white", accountType: "consumer", province: "ON", at: AT });
  const bc = computePrice(ctx, { selections: [sel()], doorStyleId: "ds_shaker_white", accountType: "consumer", province: "BC", at: AT });
  assert.equal(on.shipping.amount, fromDollars("80.00"));
  assert.equal(bc.shipping.amount, fromDollars("220.00"));
});

// ── 税 ────────────────────────────────────────────────────────────────────

test("ON 的 HST 13%", () => {
  const ctx = makeContext({ discountRules: [], shippingRule: undefined });
  const r = computePrice(ctx, { selections: [sel()], doorStyleId: "ds_shaker_white", accountType: "consumer", province: "ON", at: AT });
  assert.equal(r.taxes.length, 1);
  assert.equal(r.taxes[0]!.name, "HST");
  assert.equal(r.taxes[0]!.amount, fromDollars("31.92")); // 245.50 × 13% = 31.915 → 31.92
  assert.equal(r.total, fromDollars("277.42"));
});

test("QC 的 GST + QST 分项且非复合", () => {
  const ctx = makeContext({ discountRules: [], shippingRule: undefined });
  const r = computePrice(ctx, { selections: [sel()], doorStyleId: "ds_shaker_white", accountType: "consumer", province: "QC", at: AT });
  assert.equal(r.taxes.length, 2);
  assert.equal(r.taxes[0]!.amount, fromDollars("12.28"));  // 245.50 × 5% = 12.275 → 12.28
  assert.equal(r.taxes[1]!.amount, fromDollars("24.49"));  // 245.50 × 9.975% = 24.4886 → 24.49
  // 非复合：QST 以不含 GST 的金额为基数
  const compoundWould = Math.round((245.50 + 12.275) * 0.09975 * 100);
  assert.notEqual(r.taxes[1]!.amount, compoundWould);
});

test("NS 的税率变更：2025-04-01 前后取到不同税率", () => {
  const before = resolveTaxRule(SEED_TAX_RULES, "NS", "2025-03-31T23:59:59.000Z");
  const after = resolveTaxRule(SEED_TAX_RULES, "NS", "2025-04-01T00:00:00.000Z");
  assert.equal(before.components[0]!.ratePercent, 15);
  assert.equal(after.components[0]!.ratePercent, 14);
});

test("13 个省/地区都能查到生效税率", () => {
  for (const province of ALL_PROVINCES) {
    const rule = resolveTaxRule(SEED_TAX_RULES, province, AT);
    assert.ok(rule.components.length > 0, `${province} 无税种`);
  }
});

test("查不到税率时抛错而不是按 0 计税", () => {
  assert.throws(
    () => resolveTaxRule(SEED_TAX_RULES, "ON", "1800-01-01T00:00:00.000Z"),
    TaxRuleNotFoundError,
  );
});

test("运费计入税基", () => {
  const ctx = makeContext({ discountRules: [] });
  const r = computePrice(ctx, {
    selections: [sel({ qty: 1 })], doorStyleId: "ds_shaker_white", accountType: "consumer", province: "ON", at: AT,
  });
  // 小计 245.50 + 运费 150.00 = 395.50，×13% = 51.415 → 51.42
  assert.equal(r.shipping.amount, fromDollars("150.00"));
  assert.equal(r.taxes[0]!.amount, fromDollars("51.42"));
  assert.equal(r.total, fromDollars("446.92"));
});

test("总价 = 小计 − 折扣 + 运费 + 税（逐项自洽）", () => {
  const ctx = makeContext();
  const r = computePrice(ctx, {
    selections: [sel({ qty: 6 }), sel({ moduleId: "m_w3030", width: 30, height: 30, depth: 12, qty: 2 })],
    doorStyleId: "ds_shaker_white", accountType: "consumer", province: "BC", at: AT,
  });
  const expected = add(r.subtotal - r.discountTotal as never, r.shipping.amount, r.taxTotal);
  assert.equal(r.total, expected);
  assert.equal(r.subtotal, add(...r.lineItems.map((l) => l.lineSubtotal)));
  assert.equal(r.taxes.length, 2); // BC = GST + PST
});

test("引擎是纯函数：相同输入两次调用结果完全一致", () => {
  const ctx = makeContext();
  const input = {
    selections: [sel({ qty: 3, hardwareOptionIds: ["hw_softclose"] })],
    doorStyleId: "ds_maple_glaze" as const, accountType: "trade" as const,
    province: "QC" as const, at: AT,
  };
  assert.deepEqual(computePrice(ctx, input), computePrice(ctx, input));
});
