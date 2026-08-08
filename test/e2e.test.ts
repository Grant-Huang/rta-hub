/**
 * 端到端：MVP-1 出口条件的自动化版本 ——
 * 「一条真实客户对话能走到确认发送并产生 1 条计费事件」（REQUIREMENTS 第 9 节）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromDollars, format } from "../src/domain/money.js";
import { TenantScope } from "../src/tenancy/scoped-repo.js";
import {
  buildSendDisclosure, confirm, createQuoteDraft, createQuoteFromLlmOutput, recordSendResult,
} from "../src/app/quote-service.js";
import type { LeadBillingEvent, ModuleSelection } from "../src/domain/types.js";
import { COMPANY_ID, makeContext } from "./fixtures.js";

const AT = "2026-06-01T00:00:00.000Z";
const FEE = fromDollars("45.00");
const scope = new TenantScope(COMPANY_ID);
const ctx = makeContext();

const draftInput = {
  quoteId: "q_e2e", designLayoutId: "dl_1", designRevisionNo: 1,
  conversationId: "cv_e2e", customerAccountId: "ca_1",
  accountType: "consumer" as const, province: "ON" as const,
  doorStyleId: "ds_shaker_white", at: AT,
};

const selections: ModuleSelection[] = [
  { moduleId: "m_b30", qty: 4, width: 30, height: 34.5, depth: 24, assembly: "RTA", hardwareOptionIds: ["hw_softclose"], accessoryOptionIds: [] },
  { moduleId: "m_w3030", qty: 3, width: 30, height: 30, depth: 12, assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [] },
  { moduleId: "m_sb36", qty: 1, width: 36, height: 34.5, depth: 24, assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [] },
];

test("完整链路：草稿 → 确认 → 发送 → 计费", () => {
  const created = createQuoteDraft(scope, ctx, selections, draftInput);
  assert.equal(created.ok, true, !created.ok ? JSON.stringify(created.issues) : "");
  if (!created.ok) return;

  const quote = created.quote;
  assert.equal(quote.status, "draft");
  assert.equal(quote.lineItems.length, 3);
  assert.equal(created.events[0]!.action, "created");
  // 报价含税、含运费、有有效期
  assert.ok(quote.taxes.length > 0);
  assert.ok(quote.validUntil > quote.createdAt);
  assert.equal(quote.taxes[0]!.name, "HST");

  // 逐项自洽
  const lineSum = quote.lineItems.reduce((s, l) => s + l.lineSubtotal, 0);
  assert.equal(quote.subtotal, lineSum);
  const discountSum = quote.discounts.reduce((s, d) => s + d.amount, 0);
  const taxSum = quote.taxes.reduce((s, t) => s + t.amount, 0);
  assert.equal(quote.total, quote.subtotal - discountSum + quote.shipping.amount + taxSum);

  // 发送前披露
  const disclosure = buildSendDisclosure(quote, "Maple Cabinetry", {
    displayName: "Alex", email: "alex@example.com",
  }, "zh");
  assert.equal(disclosure.companyName, "Maple Cabinetry");
  assert.ok(disclosure.items.some((i) => i.label === "你的邮箱"));
  assert.match(disclosure.notice, /Maple Cabinetry/);

  // 确认
  const confirmed = confirm(quote, AT);
  assert.equal(confirmed.quote.status, "confirmed");

  // 发送 + 计费
  const billing: LeadBillingEvent[] = [];
  const sent = recordSendResult(confirmed.quote, billing, { delivered: true }, FEE, AT);
  assert.equal(sent.quote.status, "sent");
  assert.ok(sent.billingEvent, "应产生一条计费事件");
  assert.equal(sent.billingEvent!.feeStatus, "pending");
  assert.equal(sent.billingEvent!.companyId, COMPANY_ID);
  assert.equal(sent.billingSuppressed, false);

  console.log(`    报价总额 ${format(quote.total)}（含税 ${format(taxSum as never)}）`);
});

test("同一会话再次发送：邮件照发，但不重复计费", () => {
  const created = createQuoteDraft(scope, ctx, selections, { ...draftInput, quoteId: "q_e2e_2" });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const first = recordSendResult(confirm(created.quote, AT).quote, [], { delivered: true }, FEE, AT);
  const existing = first.billingEvent ? [first.billingEvent] : [];

  // 客户改了设计，第二次发送
  const again = createQuoteDraft(scope, ctx, selections.slice(0, 2), { ...draftInput, quoteId: "q_e2e_3" });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  const second = recordSendResult(confirm(again.quote, AT).quote, existing, { delivered: true }, FEE, AT);

  assert.equal(second.quote.status, "sent", "邮件照发，状态仍应到 sent");
  assert.equal(second.billingSuppressed, true);
  assert.equal(second.billingEvent, undefined);
  assert.ok(second.events.some((e) => e.action === "suppressedDuplicateBilling"));
});

test("LLM 编造价格：型号真实但价格被丢弃，最终金额来自规格库", () => {
  const llmOutput = [
    {
      moduleId: "m_b30", qty: 2, width: 30, height: 34.5, depth: 24, assembly: "RTA",
      hardwareOptionIds: [], accessoryOptionIds: [],
      // 模型编造：型号是真的，价格是假的 —— v0.3 的校验挡不住这个
      unitPrice: 9.99, lineSubtotal: 19.98, total: 19.98,
    },
  ];
  const r = createQuoteFromLlmOutput(scope, ctx, llmOutput, { ...draftInput, quoteId: "q_llm" });
  assert.equal(r.ok, true, !r.ok ? JSON.stringify(r.issues) : "");
  if (!r.ok) return;

  // 价格来自规格库的 245.50，不是模型说的 9.99
  assert.equal(r.quote.lineItems[0]!.unitListPrice, fromDollars("245.50"));
  assert.notEqual(r.quote.total, fromDollars("19.98"));
  // 模型试图报价这件事被记进审计
  assert.match(r.events[0]!.details ?? "", /Discarded price fields from model output/);
});

test("校验失败：拒绝生成，写 validationRejected，不进入闸门", () => {
  const bad: ModuleSelection[] = [
    { moduleId: "m_b30", qty: 1, width: 31, height: 34.5, depth: 24, assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [] },
  ];
  const r = createQuoteDraft(scope, ctx, bad, { ...draftInput, quoteId: "q_bad" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.issues[0]!.code, "DIMENSION_NOT_IN_OPTIONS");
  assert.equal(r.events[0]!.action, "validationRejected");
});

test("发送失败：状态为 failed，不产生计费事件", () => {
  const created = createQuoteDraft(scope, ctx, selections, { ...draftInput, quoteId: "q_fail" });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const r = recordSendResult(confirm(created.quote, AT).quote, [], { delivered: false, error: "SMTP 550" }, FEE, AT);
  assert.equal(r.quote.status, "failed");
  assert.equal(r.billingEvent, undefined);
  assert.equal(r.events[0]!.action, "sendFailed");
});

test("贸易账号拿到贸易折扣，且账号类型进快照", () => {
  const r = createQuoteDraft(scope, ctx, selections, {
    ...draftInput, quoteId: "q_trade", accountType: "trade",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.quote.accountTypeAtQuote, "trade");
  assert.ok(r.quote.appliedDiscountRuleIds.includes("dr_trade_15"));
});

test("跨租户上下文被拒绝", () => {
  const otherScope = new TenantScope("co_other");
  assert.throws(() => createQuoteDraft(otherScope, ctx, selections, draftInput), /scope is co_other/);
});
