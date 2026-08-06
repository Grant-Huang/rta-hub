/**
 * 报价状态机 / 快照复算 / 计费去重与争议。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromDollars } from "../src/domain/money.js";
import { computePrice } from "../src/pricing/engine.js";
import { resolveTaxRule, SEED_TAX_RULES } from "../src/pricing/tax.js";
import {
  canTransition, confirmQuote, expireQuote, isExpired, markSendFailed, markSent,
  quoteContentHash, QuoteStateError, verifySnapshot,
} from "../src/quote/state.js";
import {
  BillingError, computeDedupeKey, invoice, openDispute, recordLeadBilling, resolveDispute,
} from "../src/billing/lead-events.js";
import type { LeadBillingEvent, Quote } from "../src/domain/types.js";
import { COMPANY_ID, SPEC_V1, makeContext } from "./fixtures.js";

const AT = "2026-06-01T00:00:00.000Z";
const ctx = makeContext();

function buildQuote(over: Partial<Quote> = {}): Quote {
  const selections = [{
    moduleId: "m_b30", qty: 2, width: 30, height: 34.5, depth: 24,
    assembly: "RTA" as const, hardwareOptionIds: ["hw_softclose"], accessoryOptionIds: [],
  }];
  const bd = computePrice(ctx, {
    selections, doorStyleId: "ds_shaker_white", accountType: "consumer", province: "ON", at: AT,
  });
  return {
    id: "q_1", designLayoutId: "dl_1", designRevisionNo: 1,
    companyId: COMPANY_ID, conversationId: "cv_1", customerAccountId: "ca_1",
    specVersionId: SPEC_V1, accountTypeAtQuote: "consumer",
    doorStyleId: "ds_shaker_white", priceGroupId: bd.priceGroupId,
    currency: "CAD", province: "ON",
    taxRuleSnapshot: resolveTaxRule(SEED_TAX_RULES, "ON", AT),
    appliedDiscountRuleIds: bd.discounts.map((d) => d.ruleId),
    lineItems: bd.lineItems, subtotal: bd.subtotal, discounts: bd.discounts,
    shipping: bd.shipping, taxes: bd.taxes, total: bd.total,
    createdAt: AT, validUntil: "2026-07-01T00:00:00.000Z", status: "draft",
    ...over,
  };
}

// ── 状态机 ────────────────────────────────────────────────────────────────

test("允许的迁移：draft → confirmed → sent", () => {
  const q = buildQuote();
  const c = confirmQuote(q, AT);
  assert.equal(c.quote.status, "confirmed");
  assert.equal(c.event.action, "confirmed");
  const s = markSent(c.quote, AT);
  assert.equal(s.quote.status, "sent");
});

test("draft 不能直接跳到 sent —— 闸门不可绕过", () => {
  const q = buildQuote();
  assert.equal(canTransition("draft", "sent"), false);
  assert.throws(() => markSent(q, AT), (e: unknown) => e instanceof QuoteStateError && e.code === "ILLEGAL_TRANSITION");
});

test("sent 是终态", () => {
  assert.equal(canTransition("sent", "confirmed"), false);
  assert.equal(canTransition("sent", "sent"), false);
});

test("发送失败后允许修正重发", () => {
  const q = buildQuote({ status: "confirmed" });
  const f = markSendFailed(q, AT, "SMTP 550");
  assert.equal(f.quote.status, "failed");
  assert.equal(f.event.details, "SMTP 550");
  assert.equal(canTransition("failed", "confirmed"), true);
});

test("过期报价不能被确认", () => {
  const q = buildQuote({ validUntil: "2026-05-01T00:00:00.000Z" });
  assert.equal(isExpired(q, AT), true);
  assert.throws(() => confirmQuote(q, AT), (e: unknown) => e instanceof QuoteStateError && e.code === "QUOTE_EXPIRED");
});

test("过期迁移写审计事件", () => {
  const q = buildQuote();
  const r = expireQuote(q, "2026-07-02T00:00:00.000Z");
  assert.equal(r.quote.status, "expired");
  assert.equal(r.event.action, "expired");
});

test("内容哈希在 draft/confirmed/sent 之间保持一致", () => {
  const q = buildQuote();
  const c = confirmQuote(q, AT);
  const s = markSent(c.quote, AT);
  assert.equal(quoteContentHash(q), quoteContentHash(c.quote));
  assert.equal(quoteContentHash(q), quoteContentHash(s.quote));
});

test("改动金额会改变内容哈希", () => {
  const q = buildQuote();
  const tampered = { ...q, total: fromDollars("1.00") };
  assert.notEqual(quoteContentHash(q), quoteContentHash(tampered));
});

// ── 快照复算 ──────────────────────────────────────────────────────────────

test("快照与引擎复算一致", () => {
  const q = buildQuote();
  const r = verifySnapshot(q, ctx, AT);
  assert.equal(r.ok, true, "ok" in r && !r.ok ? r.mismatches.join("; ") : "");
});

test("公司改价后历史报价的快照不变，且复算能发现差异", () => {
  const q = buildQuote();
  // 模拟公司发布了新价格
  const bumped = makeContext({
    priceMatrix: ctx.priceMatrix.map((e) =>
      e.moduleId === "m_b30" && e.priceGroupId === "pg_a"
        ? { ...e, listPrice: fromDollars("300.00") }
        : e,
    ),
  });
  // 快照本身没有变
  assert.equal(q.lineItems[0]!.unitListPrice, fromDollars("245.50"));
  // 用新价格复算会检测出不一致（这正是 H3 监控项要抓的事故信号）
  const r = verifySnapshot(q, bumped, AT);
  assert.equal(r.ok, false);
  assert.ok("mismatches" in r && r.mismatches.some((m) => m.includes("unitListPrice")));
});

// ── 计费去重 ──────────────────────────────────────────────────────────────

test("同一 (公司, 会话) 在窗口内只计一次费", () => {
  const q = buildQuote();
  const fee = fromDollars("45.00");
  const first = recordLeadBilling([], q, fee, AT);
  assert.equal(first.kind, "created");
  const events = first.kind === "created" ? [first.event] : [];

  // 客户改了设计再发一次
  const second = recordLeadBilling(events, q, fee, "2026-06-05T00:00:00.000Z");
  assert.equal(second.kind, "suppressedDuplicate");
});

test("不同会话各自计费", () => {
  const q1 = buildQuote();
  const q2 = buildQuote({ id: "q_2", conversationId: "cv_2" });
  const fee = fromDollars("45.00");
  const a = recordLeadBilling([], q1, fee, AT);
  const events = a.kind === "created" ? [a.event] : [];
  const b = recordLeadBilling(events, q2, fee, AT);
  assert.equal(b.kind, "created");
});

test("不同公司各自计费", () => {
  const q1 = buildQuote();
  const q2 = buildQuote({ id: "q_2", companyId: "co_other" });
  const fee = fromDollars("45.00");
  const a = recordLeadBilling([], q1, fee, AT);
  const events = a.kind === "created" ? [a.event] : [];
  const b = recordLeadBilling(events, q2, fee, AT);
  assert.equal(b.kind, "created");
});

test("去重键跨窗口后变化", () => {
  const k1 = computeDedupeKey("c", "v", "2026-06-01T00:00:00.000Z");
  const k2 = computeDedupeKey("c", "v", "2026-06-02T00:00:00.000Z");
  const k3 = computeDedupeKey("c", "v", "2026-09-01T00:00:00.000Z");
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
});

// ── 争议 ──────────────────────────────────────────────────────────────────

function makeEvent(): LeadBillingEvent {
  const out = recordLeadBilling([], buildQuote(), fromDollars("45.00"), AT);
  assert.equal(out.kind, "created");
  return (out as { kind: "created"; event: LeadBillingEvent }).event;
}

test("争议窗口内可提起争议", () => {
  const e = makeEvent();
  const d = openDispute(e, {
    openedBy: "ops@maple.example", reason: "invalidContact",
    evidence: "邮箱退信", at: "2026-06-08T00:00:00.000Z",
  });
  assert.equal(d.feeStatus, "disputed");
  assert.equal(d.dispute!.reason, "invalidContact");
});

test("争议窗口关闭后拒绝受理", () => {
  const e = makeEvent();
  assert.throws(
    () => openDispute(e, { openedBy: "x", reason: "spam", evidence: "", at: "2026-07-01T00:00:00.000Z" }),
    (err: unknown) => err instanceof BillingError && err.code === "DISPUTE_WINDOW_CLOSED",
  );
});

test("争议期内不得出账", () => {
  const e = makeEvent();
  assert.throws(
    () => invoice(e, "2026-06-05T00:00:00.000Z"),
    (err: unknown) => err instanceof BillingError && err.code === "DISPUTE_WINDOW_OPEN",
  );
});

test("disputed 状态不得出账", () => {
  const e = openDispute(makeEvent(), {
    openedBy: "x", reason: "duplicate", evidence: "", at: "2026-06-05T00:00:00.000Z",
  });
  assert.throws(
    () => invoice(e, "2026-07-01T00:00:00.000Z"),
    (err: unknown) => err instanceof BillingError && err.code === "DISPUTED_CANNOT_INVOICE",
  );
});

test("裁定维持后可出账；裁定退款后状态为 refunded", () => {
  const disputed = openDispute(makeEvent(), {
    openedBy: "x", reason: "other", evidence: "", at: "2026-06-05T00:00:00.000Z",
  });
  const upheld = resolveDispute(disputed, { resolvedBy: "ops", resolution: "upheld", at: "2026-06-10T00:00:00.000Z" });
  assert.equal(upheld.feeStatus, "pending");
  assert.equal(invoice(upheld, "2026-07-01T00:00:00.000Z").feeStatus, "invoiced");

  const refunded = resolveDispute(disputed, { resolvedBy: "ops", resolution: "refunded", at: "2026-06-10T00:00:00.000Z" });
  assert.equal(refunded.feeStatus, "refunded");
});

test("争议窗口结束后正常出账", () => {
  const e = makeEvent();
  assert.equal(invoice(e, "2026-06-20T00:00:00.000Z").feeStatus, "invoiced");
});
