/**
 * 报价编排服务 —— 把 FR-8 闸门、定价引擎、快照、计费串起来。
 *
 * 这一层的职责是**顺序不能错**：
 *   校验（含丢弃 LLM 价格）→ 定价 → 写快照 → 复算自检 → 状态机 → 发送 → 计费
 *
 * 任何一步失败都不进入下一步，并写审计事件。
 */
import type { Money } from "../domain/money.js";
import type {
  AccountType, LeadBillingEvent, ModuleSelection, Province, Quote,
  QuoteAuditEvent, ShippingRule, TaxRule,
} from "../domain/types.js";
import { computePrice, type PricingContext } from "../pricing/engine.js";
import { resolveTaxRule } from "../pricing/tax.js";
import { stripPriceFields, validateSelections, type ValidationIssue } from "../spec/validation.js";
import {
  confirmQuote, makeAuditEvent, markSendFailed, markSent, verifySnapshot,
} from "../quote/state.js";
import { recordLeadBilling } from "../billing/lead-events.js";
import { TenantScope } from "../tenancy/scoped-repo.js";
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";

export interface QuoteDraftInput {
  quoteId: string;
  designLayoutId: string;
  designRevisionNo: number;
  conversationId: string;
  customerAccountId: string;
  accountType: AccountType;
  province: Province;
  doorStyleId: string;
  /** 箱体板材。不给就按商家的默认档，报价快照里记的也是那一档。 */
  boxMaterialId?: string;
  /** 报价有效期（天）。 */
  validForDays?: number;
  at: string;
}

export type CreateQuoteResult =
  | { ok: true; quote: Quote; events: QuoteAuditEvent[] }
  | { ok: false; issues: ValidationIssue[]; events: QuoteAuditEvent[] };

const DEFAULT_VALID_DAYS = 30;

/**
 * 从 **LLM 原始输出** 创建报价草稿。
 *
 * `rawSelections` 是模型的原始输出，可能夹带编造的价格字段——第一步就把它们丢掉
 * （FR-8 第 1 条）。模型试图报价这件事本身会记进审计事件。
 */
export function createQuoteFromLlmOutput(
  scope: TenantScope,
  ctx: PricingContext,
  rawSelections: unknown,
  input: QuoteDraftInput,
): CreateQuoteResult {
  const { selections, strippedPaths } = stripPriceFields(rawSelections);
  return createQuoteDraft(scope, ctx, selections, input, strippedPaths);
}

export function createQuoteDraft(
  scope: TenantScope,
  ctx: PricingContext,
  selections: readonly ModuleSelection[],
  input: QuoteDraftInput,
  strippedPaths: string[] = [],
): CreateQuoteResult {
  if (ctx.companyId !== scope.companyId) {
    throw new Error(`Pricing context belongs to ${ctx.companyId}, but scope is ${scope.companyId}`);
  }
  const events: QuoteAuditEvent[] = [];

  // 步骤 1：FR-8 硬校验
  const validation = validateSelections(
    {
      specVersionId: ctx.specVersionId,
      companyId: ctx.companyId,
      modules: ctx.modules,
      doorStyles: ctx.doorStyles,
      priceMatrix: ctx.priceMatrix,
      hardwareOptions: ctx.hardwareOptions,
      accessoryOptions: ctx.accessoryOptions,
      ...(ctx.boxMaterialOptions ? { boxMaterialOptions: ctx.boxMaterialOptions } : {}),
      taxRules: ctx.taxRules,
    },
    selections, input.doorStyleId, input.province, input.at, input.boxMaterialId,
  );

  if (!validation.ok) {
    // 拒绝生成，留痕。不做「自动修正后继续」。
    const stub = stubQuote(input, ctx.companyId);
    events.push(makeAuditEvent(
      stub, "validationRejected", "system", input.at,
      validation.issues.map((i) => `${i.code}: ${i.message}`).join(" | "),
    ));
    return { ok: false, issues: validation.issues, events };
  }

  // 步骤 2：定价（纯代码，与 LLM 无关）
  const bd = computePrice(ctx, {
    selections, doorStyleId: input.doorStyleId,
    ...(input.boxMaterialId ? { boxMaterialId: input.boxMaterialId } : {}),
    accountType: input.accountType, province: input.province, at: input.at,
  });

  // 步骤 3：写快照
  const taxRule: TaxRule = resolveTaxRule(ctx.taxRules, input.province, input.at);
  const validUntil = new Date(
    Date.parse(input.at) + (input.validForDays ?? DEFAULT_VALID_DAYS) * 86_400_000,
  ).toISOString();

  const quote: Quote = {
    id: input.quoteId,
    designLayoutId: input.designLayoutId,
    designRevisionNo: input.designRevisionNo,
    companyId: ctx.companyId,
    conversationId: input.conversationId,
    customerAccountId: input.customerAccountId,
    specVersionId: ctx.specVersionId,
    accountTypeAtQuote: input.accountType,
    doorStyleId: input.doorStyleId,
    priceGroupId: bd.priceGroupId,
    // 记的是**实际用的那一档**，不是客户传进来的那个字段：客户没选时
    // 两者不同，而报价单要说清按的是哪一档
    ...(bd.boxMaterial ? { boxMaterialId: bd.boxMaterial.id } : {}),
    currency: "CAD",
    province: input.province,
    taxRuleSnapshot: taxRule,
    ...(ctx.shippingRule ? { shippingRuleSnapshot: ctx.shippingRule as ShippingRule } : {}),
    appliedDiscountRuleIds: bd.discounts.map((d) => d.ruleId),
    lineItems: bd.lineItems,
    subtotal: bd.subtotal,
    discounts: bd.discounts,
    shipping: bd.shipping,
    taxes: bd.taxes,
    total: bd.total,
    createdAt: input.at,
    validUntil,
    status: "draft",
  };

  scope.assertOwned(quote, "quote");

  // 步骤 4：复算自检（FR-8 校验第 6 项）
  const check = verifySnapshot(quote, ctx, input.at);
  if (!check.ok) {
    events.push(makeAuditEvent(
      quote, "validationRejected", "system", input.at,
      `Snapshot recompute mismatch: ${check.mismatches.join("; ")}`,
    ));
    return {
      ok: false,
      issues: check.mismatches.map((m) => ({ code: "PRICE_MATRIX_HOLE" as const, message: m })),
      events,
    };
  }

  const detail = strippedPaths.length
    ? `Discarded price fields from model output: ${strippedPaths.join(", ")}`
    : undefined;
  events.push(makeAuditEvent(quote, "created", "system", input.at, detail));
  return { ok: true, quote, events };
}

// ── 确认与发送 ────────────────────────────────────────────────────────────

/** 客户确认 —— 服务端状态变更，不接受请求体里的布尔字段（FR-8 第 3 条）。 */
export function confirm(quote: Quote, at: string): { quote: Quote; events: QuoteAuditEvent[] } {
  const r = confirmQuote(quote, at);
  return { quote: r.quote, events: [r.event] };
}

export interface SendOutcome {
  quote: Quote;
  events: QuoteAuditEvent[];
  billingEvent?: LeadBillingEvent;
  /** 命中去重窗口时为 true —— 邮件照发，但不重复计费。 */
  billingSuppressed: boolean;
}

/**
 * 发送结果登记。
 *
 * 注意：**邮件是否发送**由调用方决定并把结果传进来；本函数只负责状态迁移与计费。
 * 这样发信副作用与状态机解耦，测试里不需要真发邮件。
 */
export function recordSendResult(
  quote: Quote,
  existingBilling: readonly LeadBillingEvent[],
  outcome: { delivered: boolean; error?: string },
  feeAmount: Money,
  at: string,
): SendOutcome {
  if (!outcome.delivered) {
    const f = markSendFailed(quote, at, outcome.error ?? "Unknown error");
    return { quote: f.quote, events: [f.event], billingSuppressed: false };
  }

  const s = markSent(quote, at);
  const events = [s.event];

  const billing = recordLeadBilling(existingBilling, s.quote, feeAmount, at);
  if (billing.kind === "suppressedDuplicate") {
    events.push(makeAuditEvent(
      s.quote, "suppressedDuplicateBilling", "system", at,
      `Hit dedupe window; reusing billing event ${billing.existing.id}`,
    ));
    return { quote: s.quote, events, billingSuppressed: true };
  }
  return { quote: s.quote, events, billingEvent: billing.event, billingSuppressed: false };
}

/**
 * 发送前的二次披露清单（FR-13 第 2 条）。
 *
 * 客户必须先看到"将要发送给 X 公司的具体内容"才能确认——这是 PIPEDA 意义上的
 * 对第三方披露，不能藏在通用条款里。
 */
export interface DisclosureItem {
  label: string;
  value: string;
}

export function buildSendDisclosure(
  quote: Quote,
  companyName: string,
  customer: { displayName: string; email: string },
  language: UiLanguage = DEFAULT_LANGUAGE,
): { companyName: string; items: DisclosureItem[]; notice: string } {
  const lang = language;
  const n = quote.lineItems.length;
  return {
    companyName,
    items: [
      {
        label: msg(lang, "Design package", "设计方案"),
        value: msg(lang,
          `Four views and dimensions for ${n} cabinet line${n === 1 ? "" : "s"}`,
          `${n} 项柜体的四视图与尺寸`),
      },
      {
        label: msg(lang, "SKUs & quantities", "型号与数量"),
        value: quote.lineItems.map((l) => `${l.moduleCode}×${l.qty}`).join(msg(lang, ", ", "、")),
      },
      {
        label: msg(lang, "Quote total", "报价总额"),
        value: `${quote.currency} ${(quote.total / 100).toFixed(2)}`,
      },
      { label: msg(lang, "Your name", "你的姓名"), value: customer.displayName },
      { label: msg(lang, "Your email", "你的邮箱"), value: customer.email },
      { label: msg(lang, "Project province", "项目所在省份"), value: quote.province },
    ],
    notice: msg(lang,
      `The above will be sent to "${companyName}", which will then be able to contact you. ` +
        `After you confirm, we keep this inquiry on your project — you can review or request deletion anytime in account settings.`,
      `以上内容将发送给「${companyName}」，该公司会因此获得联系你的能力。` +
        `确认发送后，我们会把这条询价记录在你的项目里，你可以随时在账号设置中查看或要求删除。`),
  };
}

function stubQuote(input: QuoteDraftInput, companyId: string): Quote {
  // 仅用于给「校验失败」这个事件一个可写审计的载体，不会被持久化
  return {
    id: input.quoteId, designLayoutId: input.designLayoutId,
    designRevisionNo: input.designRevisionNo, companyId,
    conversationId: input.conversationId, customerAccountId: input.customerAccountId,
    specVersionId: "", accountTypeAtQuote: input.accountType,
    doorStyleId: input.doorStyleId, priceGroupId: "", currency: "CAD",
    province: input.province,
    taxRuleSnapshot: { id: "", province: input.province, components: [], compounded: false, effectiveFrom: input.at },
    appliedDiscountRuleIds: [], lineItems: [], subtotal: 0 as Money,
    discounts: [], shipping: { amount: 0 as Money }, taxes: [], total: 0 as Money,
    createdAt: input.at, validUntil: input.at, status: "draft",
  };
}
