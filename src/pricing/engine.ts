/**
 * 定价引擎 —— REQUIREMENTS 3.5.4。
 *
 * **纯函数**：相同输入必须得到相同输出，便于测试与事后复算（3.6 的快照复算校验依赖这一点）。
 * **LLM 不参与定价的任何环节**（FR-8 第 1 条）——入参 selections 里只有「选择」，没有金额。
 *
 * 计算链路（3.5.2）：
 *   标价 → ＋修饰项 → －折扣 → ＝小计 → ＋运费 → ＋税 → ＝总价
 */
import {
  ZERO, add, sub, mulQty, percentOf, fromCents, type Money,
} from "../domain/money.js";
import { priceEntryFor } from "../spec/finish.js";
import { boxMaterialCharge, resolveBoxMaterial } from "../spec/carcass.js";
import type {
  AccessoryOption, AccountType, AppliedDiscount, BoxMaterialOption, DiscountRule, DoorStyle,
  HardwareOption, ModuleSelection, ModuleSpec, Modifier, PriceMatrixEntry,
  Province, QuoteLineItem, QuoteLineModifier, QuoteTax, ShippingRule, TaxRule,
} from "../domain/types.js";

/** 引擎需要的一整套规格数据（均来自同一个 published ProductSpecVersion）。 */
export interface PricingContext {
  specVersionId: string;
  companyId: string;
  modules: readonly ModuleSpec[];
  doorStyles: readonly DoorStyle[];
  priceMatrix: readonly PriceMatrixEntry[];
  hardwareOptions: readonly HardwareOption[];
  accessoryOptions: readonly AccessoryOption[];
  /**
   * 箱体板材档位。**可以为空**——老的规格版本没有这一维，那时不加任何修饰项，
   * 报价与从前逐分一致。
   */
  boxMaterialOptions?: readonly BoxMaterialOption[];
  discountRules: readonly DiscountRule[];
  shippingRule?: ShippingRule;
  taxRules: readonly TaxRule[];
}

export interface PricingInput {
  selections: readonly ModuleSelection[];
  doorStyleId: string;
  /**
   * 箱体板材。与 `doorStyleId` 是**两个独立的维度**：同一款门配颗粒板箱体
   * 和配全夹板箱体是两个价（见 `domain/types.ts` 的 `BoxMaterialOption`）。
   * 不给就按商家的默认档。
   */
  boxMaterialId?: string;
  accountType: AccountType;
  province: Province;
  /** 报价时刻，决定取哪一版税率。 */
  at: string;
}

/** 可解释的价格明细——报价单要能逐项核对，不能只给一个总数。 */
export interface PriceBreakdown {
  priceGroupId: string;
  /**
   * 这份报价实际按的箱体档。**客户没选时这里是商家的默认档**——
   * 报价单要写明按的是哪一档，"没写"会被读成"和别家一样"。
   */
  boxMaterial?: BoxMaterialOption;
  lineItems: QuoteLineItem[];
  subtotal: Money;
  discounts: AppliedDiscount[];
  discountTotal: Money;
  shipping: { ruleId?: string; amount: Money };
  taxes: QuoteTax[];
  taxTotal: Money;
  total: Money;
  taxRule: TaxRule;
}

export class PricingError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "PricingError";
  }
}

function applyModifier(base: Money, modifier: Modifier): Money {
  return modifier.kind === "flat" ? modifier.value : percentOf(base, modifier.value);
}

/**
 * 计算一份完整报价。
 *
 * 假定调用方已通过 FR-8 校验（validateSelections）；这里仍对价格矩阵空洞等
 * 致命情况抛错，因为「静默回退到某个默认价」比报错危险得多。
 */
export function computePrice(ctx: PricingContext, input: PricingInput): PriceBreakdown {
  const doorStyle = ctx.doorStyles.find((d) => d.id === input.doorStyleId);
  if (!doorStyle) {
    throw new PricingError(`Door style not found: ${input.doorStyleId}`, "DOOR_STYLE_NOT_FOUND");
  }
  const priceGroupId = doorStyle.priceGroupId;

  // 箱体板材：客户没选就按商家的默认档。**明确选了一档而那一档不存在是数据错误**
  // ——静默换成默认档等于按客户没要的规格出价，那份价还会被拿去下单。
  const boxOptions = ctx.boxMaterialOptions ?? [];
  const boxMaterial = resolveBoxMaterial(boxOptions, input.boxMaterialId);
  if (input.boxMaterialId && !boxMaterial) {
    throw new PricingError(
      `Box material not found: ${input.boxMaterialId}`, "BOX_MATERIAL_NOT_FOUND");
  }

  // ── 1. 逐行：标价 + 修饰项 ──────────────────────────────────────────────
  const lineItems: QuoteLineItem[] = [];
  for (const sel of input.selections) {
    const mod = ctx.modules.find((m) => m.id === sel.moduleId);
    if (!mod) {
      throw new PricingError(`Module not found: ${sel.moduleId}`, "MODULE_NOT_FOUND");
    }
    // 查价走 `priceEntryFor`：`finishDependent: false` 的型号（塑料地脚）
    // 在矩阵里只有一行，那一行对所有花色都适用（§3.5.5）。
    // 与 FR-8 校验读同一个函数——两边各写一遍的话，会出现"校验放行、定价当场
    // 抛价格空洞"，而客户看到的只是一句"报价校验未通过"。
    const entry = priceEntryFor(mod, priceGroupId, ctx.priceMatrix);
    if (!entry) {
      // 价格矩阵空洞：该型号不供应该价格组。绝不回退到「某个默认价」。
      throw new PricingError(
        `No price entry for ${mod.code} under price group ${priceGroupId}`,
        "PRICE_MATRIX_HOLE",
      );
    }

    // 贸易价：优先用独立矩阵，否则走折扣规则（见第 3 步）
    const useTradeMatrix = input.accountType === "trade" && entry.tradePrice !== undefined;
    const unitListPrice = useTradeMatrix ? entry.tradePrice! : entry.listPrice;

    const modifiers: QuoteLineModifier[] = [];

    // 箱体板材加价。**只加在有箱体的件上**——填缝条、踢脚板、塑料地脚是
    // 一块板或一个塑料件，给它们乘上全夹板的加价是凭空加价（`spec/carcass.ts`）。
    const boxCharge = boxMaterialCharge(mod, boxMaterial, unitListPrice);
    if (boxCharge !== undefined) {
      modifiers.push({
        kind: "boxMaterial", refId: boxMaterial!.id, name: boxMaterial!.name,
        amount: boxCharge,
      });
    }

    if (sel.assembly === "assembled" && entry.assembledUpcharge) {
      modifiers.push({
        kind: "assembly",
        refId: `${entry.moduleId}:assembled`,
        name: "Assembly upcharge",
        amount: applyModifier(unitListPrice, entry.assembledUpcharge),
      });
    }
    for (const hwId of sel.hardwareOptionIds) {
      const hw = ctx.hardwareOptions.find((h) => h.id === hwId);
      if (!hw) throw new PricingError(`Hardware option not found: ${hwId}`, "HARDWARE_NOT_FOUND");
      modifiers.push({
        kind: "hardware", refId: hw.id, name: hw.name,
        amount: applyModifier(unitListPrice, hw.priceModifier),
      });
    }
    for (const acId of sel.accessoryOptionIds) {
      const ac = ctx.accessoryOptions.find((a) => a.id === acId);
      if (!ac) throw new PricingError(`Accessory option not found: ${acId}`, "ACCESSORY_NOT_FOUND");
      modifiers.push({
        kind: "accessory", refId: ac.id, name: ac.name,
        amount: applyModifier(unitListPrice, ac.priceModifier),
      });
    }

    // 运算顺序：所有百分比修饰项都以**标价**为基数，不叠乘。
    // 这样修饰项的顺序不影响结果（可交换），报价才可复算。
    const unitNetPrice = add(unitListPrice, ...modifiers.map((m) => m.amount));
    lineItems.push({
      moduleId: mod.id,
      moduleCode: mod.code,
      qty: sel.qty,
      width: sel.width,
      height: sel.height,
      depth: sel.depth,
      assembly: sel.assembly,
      unitListPrice,
      modifiers,
      unitNetPrice,
      lineSubtotal: mulQty(unitNetPrice, sel.qty),
    });
  }

  const subtotal = add(...lineItems.map((l) => l.lineSubtotal));

  // ── 2. 折扣 ────────────────────────────────────────────────────────────
  const { discounts, discountTotal } = computeDiscounts(
    ctx, input.accountType, priceGroupId, subtotal, lineItems,
  );
  const afterDiscount = sub(subtotal, discountTotal);

  // ── 3. 运费 ────────────────────────────────────────────────────────────
  const shipping = computeShipping(ctx.shippingRule, afterDiscount, input.province);

  // ── 4. 税 ──────────────────────────────────────────────────────────────
  const taxRule = resolveTax(ctx.taxRules, input.province, input.at);
  const taxable = add(afterDiscount, shipping.amount);
  const taxes = computeTaxes(taxRule, taxable);
  const taxTotal = add(...taxes.map((t) => t.amount));

  return {
    priceGroupId,
    ...(boxMaterial ? { boxMaterial } : {}),
    lineItems,
    subtotal,
    discounts,
    discountTotal,
    shipping,
    taxes,
    taxTotal,
    total: add(afterDiscount, shipping.amount, taxTotal),
    taxRule,
  };
}

/**
 * 折扣。
 *
 * - 只应用 audience 匹配当前账号类型的规则。
 * - `appliesToPriceGroupIds` 限定了价格组时，只对该价格组生效。
 * - `stackable: false` 的规则一旦命中就独占（取折扣额最大的那条），不与其他规则叠加。
 */
function computeDiscounts(
  ctx: PricingContext,
  accountType: AccountType,
  priceGroupId: string,
  subtotal: Money,
  lineItems: readonly QuoteLineItem[],
): { discounts: AppliedDiscount[]; discountTotal: Money } {
  // 用独立贸易价矩阵定价的行，不再重复享受贸易折扣
  const tradeMatrixUsed =
    accountType === "trade" &&
    lineItems.length > 0 &&
    ctx.priceMatrix.some((e) => e.tradePrice !== undefined);

  const candidates = ctx.discountRules.filter((r) => {
    if (r.audience !== accountType) return false;
    if (r.appliesToPriceGroupIds && !r.appliesToPriceGroupIds.includes(priceGroupId)) return false;
    if (tradeMatrixUsed && accountType === "trade") return false;
    return true;
  });

  const evaluated = candidates
    .map((rule) => ({ rule, amount: discountAmount(rule, subtotal) }))
    .filter((d) => d.amount > 0);

  if (evaluated.length === 0) return { discounts: [], discountTotal: ZERO };

  const nonStackable = evaluated.filter((d) => !d.rule.stackable);
  const chosen =
    nonStackable.length > 0
      // 存在互斥规则：取折扣额最大的一条，且不与任何其他规则叠加
      ? [nonStackable.reduce((best, d) => (d.amount > best.amount ? d : best))]
      : evaluated;

  const discounts: AppliedDiscount[] = chosen.map((d) => ({
    ruleId: d.rule.id,
    description: d.rule.description,
    amount: d.amount,
  }));
  return { discounts, discountTotal: add(...discounts.map((d) => d.amount)) };
}

function discountAmount(rule: DiscountRule, subtotal: Money): Money {
  if (rule.kind === "percentOffList") {
    return rule.value ? percentOf(subtotal, rule.value) : ZERO;
  }
  // tieredByOrderValue：取所有满足门槛的档位中门槛最高的一档（边界为「大于等于」）
  const tiers = [...(rule.tiers ?? [])].sort((a, b) => a.minSubtotal - b.minSubtotal);
  let hit: { minSubtotal: Money; percentOff: number } | undefined;
  for (const tier of tiers) {
    if (subtotal >= tier.minSubtotal) hit = tier;
  }
  return hit ? percentOf(subtotal, hit.percentOff) : ZERO;
}

function computeShipping(
  rule: ShippingRule | undefined,
  afterDiscount: Money,
  province: Province,
): { ruleId?: string; amount: Money } {
  if (!rule) return { amount: ZERO };
  switch (rule.kind) {
    case "flat":
      return { ruleId: rule.id, amount: rule.flatAmount };
    case "freeOver":
      // 边界：恰好等于阈值即免运（「满 X 免运」的通常语义）
      return {
        ruleId: rule.id,
        amount: afterDiscount >= rule.freeOverThreshold ? ZERO : rule.belowThresholdAmount,
      };
    case "byRegion": {
      const row = rule.regionTable.find((r) => r.province === province);
      return { ruleId: rule.id, amount: row ? row.amount : rule.fallbackAmount };
    }
  }
}

function resolveTax(rules: readonly TaxRule[], province: Province, at: string): TaxRule {
  const t = Date.parse(at);
  const hit = rules.find(
    (r) =>
      r.province === province &&
      Date.parse(r.effectiveFrom) <= t &&
      (r.effectiveTo === undefined || t < Date.parse(r.effectiveTo)),
  );
  if (!hit) {
    throw new PricingError(`No tax rule for ${province} effective at ${at}`, "TAX_RULE_NOT_FOUND");
  }
  return hit;
}

/**
 * 分项计税。
 *
 * 非复合（现行 QC 等）：每个税种都以税基原值计算。
 * 复合：后一个税种以「税基 + 前面已计税额」为基数——保留此分支是因为 QST
 * 历史上曾是复合计算，税率数据可能需要表达旧口径。
 */
function computeTaxes(rule: TaxRule, taxable: Money): QuoteTax[] {
  const taxes: QuoteTax[] = [];
  let compoundBase = taxable;
  for (const c of rule.components) {
    const base = rule.compounded ? compoundBase : taxable;
    const amount = percentOf(base, c.ratePercent);
    taxes.push({ name: c.name, ratePercent: c.ratePercent, amount });
    if (rule.compounded) compoundBase = fromCents(compoundBase + amount);
  }
  return taxes;
}
