/**
 * 换花色比价（FR-6.3）与 `finishDependent`（§3.5.5）。
 *
 * 这两条是一件事的两半：换花色时**哪些件跟着换、哪些不跟**。
 * 填缝条、收口板、踢脚板跟着换（要与门同色，那正是它们存在的理由）；
 * 塑料地脚不跟——它藏在踢脚板后面没人看得见，给它编一个"高级花色版"的价格
 * 是凭空加价。
 *
 * 最要紧的两条断言：
 *   1. **逐行重算，不是总价乘系数**——同一个价格组里各型号的涨幅并不一致，
 *      乘系数得出的数没有任何一行支持它，而客户会拿它去签合同；
 *   2. **价格空洞要标出来**，且要说清是哪个型号卡住的。悄悄跳过那个花色，
 *      客户会以为它不存在；给它编一个价，那是假数据。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareFinishes, renderFinishComparison } from "../src/quote/finish-comparison.js";
import { computePrice, type PricingContext } from "../src/pricing/engine.js";
import { priceEntryFor, isFinishDependent } from "../src/spec/finish.js";
import { format, fromDollars } from "../src/domain/money.js";
import {
  pilotModules, pilotPriceMatrix, pilotDoorStyles, pilotPriceGroups,
  pilotHardware, pilotAccessories, pilotDiscounts, pilotShipping,
  PILOT_SPEC_VERSION_ID, PILOT_COMPANY_ID,
} from "../src/app/seed.js";
import { SEED_TAX_RULES } from "../src/pricing/tax.js";
import type { ModuleSelection, PriceMatrixEntry } from "../src/domain/types.js";

const ctx: PricingContext = {
  specVersionId: PILOT_SPEC_VERSION_ID,
  companyId: PILOT_COMPANY_ID,
  modules: pilotModules,
  doorStyles: pilotDoorStyles,
  priceMatrix: pilotPriceMatrix,
  hardwareOptions: pilotHardware,
  accessoryOptions: pilotAccessories,
  discountRules: pilotDiscounts,
  shippingRule: pilotShipping,
  taxRules: SEED_TAX_RULES,
};

const mod = (code: string) => {
  const m = pilotModules.find((x) => x.code === code);
  assert.ok(m, `种子里没有型号 ${code}`);
  return m;
};

function sel(code: string, qty = 1): ModuleSelection {
  const m = mod(code);
  return {
    moduleId: m.id, qty,
    width: m.widthOptions[0]!, height: m.heightOptions[0]!, depth: m.depthOptions[0]!,
    assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [],
  };
}

const selections = [sel("B30", 2), sel("SB36"), sel("W3030", 2), sel("LEG", 12)];
const at = "2026-03-01T00:00:00.000Z";
const args = { ctx, selections, currentDoorStyleId: pilotDoorStyles[0]!.id,
  accountType: "consumer" as const, province: "ON" as const, at };

// ── finishDependent ──────────────────────────────────────────────────────

test("塑料地脚的价格不随花色变，其余的都随", () => {
  assert.equal(isFinishDependent(mod("LEG")), false, "塑料地脚藏在踢脚板后面，一个价");
  for (const code of ["B30", "SB36", "W3030", "BF3", "TK8"]) {
    assert.equal(isFinishDependent(mod(code)), true,
      `${code} 要与门同色，价格应随花色变`);
  }
});

test("只有一行价的型号在任何价格组下都查得到价——不误报成价格空洞", () => {
  const leg = mod("LEG");
  const rows = pilotPriceMatrix.filter((e) => e.moduleId === leg.id);
  assert.equal(rows.length, 1, "塑料地脚在价格矩阵里应该只有一行");
  for (const group of pilotPriceGroups) {
    const entry = priceEntryFor(leg, group.id, pilotPriceMatrix);
    assert.ok(entry, `价格组 ${group.id} 下查不到塑料地脚的价——会被误报成价格空洞`);
    assert.equal(entry.listPrice, rows[0]!.listPrice, "不同花色下塑料地脚应该同价");
  }
});

test("随花色变的型号，缺了那一行就是真的空洞——不许回退到某个默认价", () => {
  const b30 = mod("B30");
  const withoutPremium = pilotPriceMatrix.filter(
    (e) => !(e.moduleId === b30.id && e.priceGroupId === "pg_prem"));
  assert.equal(priceEntryFor(b30, "pg_prem", withoutPremium), undefined);
});

// ── 换花色比价 ────────────────────────────────────────────────────────────

test("每个花色都出现在比价里，当前那个排最前", () => {
  const cmp = compareFinishes(args);
  assert.equal(cmp.options.length, pilotDoorStyles.length);
  assert.equal(cmp.options[0]!.current, true);
  assert.equal(cmp.options[0]!.doorStyleId, pilotDoorStyles[0]!.id);
});

test("换色价与「真选了那个花色之后的报价」逐分一致", () => {
  // 这是整件事的要害：比价表上的数必须**就是**客户真选之后拿到的那个数。
  // 另写一套"比价用的算法"，两边迟早对不上，而那是最难解释的一种不一致。
  const cmp = compareFinishes(args);
  for (const o of cmp.options) {
    if (!o.total) continue;
    const real = computePrice(ctx, {
      selections, doorStyleId: o.doorStyleId,
      accountType: "consumer", province: "ON", at,
    });
    assert.equal(o.total, real.total, `${o.doorStyleName} 的比价与实际报价对不上`);
  }
});

test("差额不是总价乘系数——它是逐行重算出来的", () => {
  const cmp = compareFinishes(args);
  // 要挑**换了价格组**的那个：同价格组的花色本来就同价，比不出什么
  const other = cmp.options.find(
    (o) => !o.current && o.total !== undefined
      && o.priceGroupId !== cmp.current!.priceGroupId);
  assert.ok(other, "种子里应该有一个属于另一个价格组的花色");

  // 造一个"总价乘系数"的假答案：拿单个柜体的涨幅当整单的涨幅。
  // 真实结果必须与它不同——不同的原因是塑料地脚不换色，而且折扣/运费/税
  // 各自有自己的算法，不随标价等比例缩放。
  const b30 = mod("B30");
  const stdRow = priceEntryFor(b30, pilotDoorStyles[0]!.priceGroupId, pilotPriceMatrix)!;
  const otherRow = priceEntryFor(b30, other.priceGroupId, pilotPriceMatrix)!;
  const naiveRatio = otherRow.listPrice / stdRow.listPrice;
  const naive = Math.round(cmp.current!.total! * naiveRatio);

  assert.notEqual(other.total, naive,
    "换色总价正好等于「当前总价 × 单个柜体的涨幅」——多半是乘了系数而不是逐行重算");
  // 具体到种子数据：B30 的标价涨 62%，整单只涨 52%——差在塑料地脚不换色，
  // 以及折扣/运费/税各有各的算法，不随标价等比例缩放
  assert.ok(other.deltaPercent !== undefined && other.deltaPercent < Math.round((naiveRatio - 1) * 100),
    `整单涨幅（${other.deltaPercent}%）不该等于单个柜体的涨幅` +
    `（${Math.round((naiveRatio - 1) * 100)}%）`);
});

test("塑料地脚在两个花色下同价——它不该跟着涨", () => {
  const groups = pilotDoorStyles.map((d) => d.priceGroupId);
  const legPrices = new Set(
    groups.map((g) => priceEntryFor(mod("LEG"), g, pilotPriceMatrix)!.listPrice));
  assert.equal(legPrices.size, 1, "塑料地脚在不同花色下报了不同的价");
});

// ── 价格空洞 ─────────────────────────────────────────────────────────────

test("某花色在某型号上没有价时：整个花色报不出价，并说清是哪个型号卡住的", () => {
  const sb36 = mod("SB36");
  const holed: PriceMatrixEntry[] = pilotPriceMatrix.filter(
    (e) => !(e.moduleId === sb36.id && e.priceGroupId === "pg_prem"));
  const cmp = compareFinishes({ ...args, ctx: { ...ctx, priceMatrix: holed } });

  const premium = cmp.options.find((o) => o.priceGroupId === "pg_prem");
  assert.ok(premium, "有空洞的花色**不能从清单里消失**——客户可能正想选它");
  assert.equal(premium.total, undefined, "有空洞还给出了总价，那是假数据");
  assert.ok(premium.unavailable, "没说明为什么报不出价");
  assert.deepEqual(premium.unavailable.moduleCodes, ["SB36"]);
  assert.match(premium.unavailable.reason, /SB36/);
  assert.equal(cmp.hasHoles, true);
});

test("多个型号有空洞时全部列出来——客户要知道一共要调整几个", () => {
  const holed = pilotPriceMatrix.filter(
    (e) => !(["m_sb36", "m_b30"].includes(e.moduleId) && e.priceGroupId === "pg_prem"));
  const cmp = compareFinishes({ ...args, ctx: { ...ctx, priceMatrix: holed } });
  const premium = cmp.options.find((o) => o.priceGroupId === "pg_prem")!;
  assert.deepEqual(premium.unavailable?.moduleCodes, ["B30", "SB36"]);
});

// ── 呈现 ─────────────────────────────────────────────────────────────────

test("文字版把「重算价」「哪些跟着换色」都说清楚", () => {
  const text = renderFinishComparison(compareFinishes({ ...args, language: "zh" }), format, "zh");
  assert.match(text, /换一种门板花色/);
  assert.match(text, /重算价/);
  assert.match(text, /塑料地脚不换/);
  // 每个非当前花色都要出现
  for (const d of pilotDoorStyles.slice(1)) {
    assert.ok(text.includes(d.name), `文字版里没有 ${d.name}`);
  }
});

test("只有一个花色时不出这一段——没有可比的对象", () => {
  const single = { ...ctx, doorStyles: [pilotDoorStyles[0]!] };
  const text = renderFinishComparison(compareFinishes({ ...args, ctx: single, language: "zh" }), format, "zh");
  assert.equal(text, "");
});

test("金额格式与报价单一致，不另编一套", () => {
  const cmp = compareFinishes(args);
  const text = renderFinishComparison(cmp, format, "zh");
  assert.ok(text.includes(format(cmp.current!.total!)),
    "比价里的当前总价与报价单的写法不一致");
  assert.ok(fromDollars("0.00") === 0, "占位断言：金额单位是分");
});
