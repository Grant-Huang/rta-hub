/**
 * FR-13 隐私：订阅同意、退订、留存清除、去标识化、数据主体权利。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anonymizeIp, deliverableRecipients, needsReconsent, subscribe,
  SubscriptionError, unsubscribeByToken, unsubscribeUrl,
} from "../src/marketing/subscriptions.js";
import {
  DEIDENTIFIED, deIdentifyBillingEvent, deIdentifyQuote, executeDeletionRequest,
  exportAccountData, isOverdue, planRetentionSweep, RETENTION, responseDueBy,
  type SubjectRequest,
} from "../src/privacy/retention.js";
import { fromDollars } from "../src/domain/money.js";
import type {
  Conversation, CustomerAccount, EstimateDraft, LeadBillingEvent, Quote, QuoteAuditEvent,
} from "../src/domain/types.js";

const AT = "2026-06-01T00:00:00.000Z";

// ── 订阅（CASL Express Consent）───────────────────────────────────────────

test("未勾选同意不能加入邮件列表", () => {
  assert.throws(
    () => subscribe({
      email: "a@b.example", companyName: "X", consentGiven: false,
      termsVersion: "2026-01", at: AT,
    }),
    (e: unknown) => e instanceof SubscriptionError && e.code === "CONSENT_REQUIRED",
  );
});

test("同意记录必须带条款版本号", () => {
  assert.throws(
    () => subscribe({
      email: "a@b.example", companyName: "X", consentGiven: true,
      termsVersion: "", at: AT,
    }),
    (e: unknown) => e instanceof SubscriptionError && e.code === "MISSING_TERMS_VERSION",
  );
});

test("订阅记录包含可追溯的同意凭据", () => {
  const sub = subscribe({
    email: "A@B.Example", companyName: " Maple Ridge ", consentGiven: true,
    termsVersion: "2026-01", userAgent: "Mozilla/5.0", ipAddress: "203.0.113.45", at: AT,
  });
  assert.equal(sub.email, "a@b.example");
  assert.equal(sub.companyName, "Maple Ridge");
  assert.equal(sub.consentDate, AT);
  assert.equal(sub.termsVersion, "2026-01");
  assert.equal(sub.status, "active");
  assert.ok(sub.unsubscribeToken.length >= 16);
});

test("IP 按最小化原则脱敏存储", () => {
  assert.equal(anonymizeIp("203.0.113.45"), "203.0.113.0");
  assert.equal(anonymizeIp("2001:db8:85a3:8d3:1319:8a2e:370:7348"), "2001:db8:85a3:0:0:0:0:0");
  assert.equal(anonymizeIp(""), "");
});

test("非法邮箱被拒", () => {
  assert.throws(
    () => subscribe({ email: "not-an-email", companyName: "X", consentGiven: true, termsVersion: "v1", at: AT }),
    (e: unknown) => e instanceof SubscriptionError && e.code === "INVALID_EMAIL",
  );
});

test("退订立即生效，之后不再是可投递收件人", () => {
  const sub = subscribe({
    email: "a@b.example", companyName: "X", consentGiven: true, termsVersion: "v1", at: AT,
  });
  assert.equal(deliverableRecipients([sub]).length, 1);
  const after = unsubscribeByToken([sub], sub.unsubscribeToken, "2026-06-02T00:00:00.000Z");
  assert.equal(after.status, "unsubscribed");
  assert.equal(after.unsubscribedAt, "2026-06-02T00:00:00.000Z");
  assert.equal(deliverableRecipients([after]).length, 0);
});

test("无效退订 token 报错而不是静默成功", () => {
  const sub = subscribe({ email: "a@b.example", companyName: "X", consentGiven: true, termsVersion: "v1", at: AT });
  assert.throws(
    () => unsubscribeByToken([sub], "wrong-token", AT),
    (e: unknown) => e instanceof SubscriptionError && e.code === "INVALID_TOKEN",
  );
});

test("退订链接格式", () => {
  assert.equal(unsubscribeUrl("https://x.example/", "abc"), "https://x.example/unsubscribe?token=abc");
});

test("条款版本变更时找出需要重新同意的订阅者", () => {
  const old = subscribe({ email: "a@b.example", companyName: "X", consentGiven: true, termsVersion: "2026-01", at: AT });
  const fresh = subscribe({ email: "c@d.example", companyName: "Y", consentGiven: true, termsVersion: "2026-06", at: AT });
  const need = needsReconsent([old, fresh], "2026-06");
  assert.equal(need.length, 1);
  assert.equal(need[0]!.email, "a@b.example");
});

// ── 留存清除 ──────────────────────────────────────────────────────────────

const account: CustomerAccount = {
  id: "ca_1", accountType: "consumer", email: "alex@example.com",
  displayName: "Alex", province: "ON", consentRecords: [],
};

const conv = (id: string, createdAt: string): Conversation => ({
  id, customerAccountId: "ca_1", messages: [], designRequirements: "",
  perCompanyThreads: [], createdAt,
});

const quote = (id: string, conversationId: string): Quote => ({
  id, designLayoutId: "dl", designRevisionNo: 1, companyId: "co_1",
  conversationId, customerAccountId: "ca_1", specVersionId: "sv1",
  accountTypeAtQuote: "consumer", doorStyleId: "ds", priceGroupId: "pg",
  currency: "CAD", province: "ON",
  taxRuleSnapshot: { id: "t", province: "ON", components: [{ name: "HST", ratePercent: 13 }], compounded: false, effectiveFrom: AT },
  appliedDiscountRuleIds: [], lineItems: [], subtotal: fromDollars("100.00"),
  discounts: [], shipping: { amount: fromDollars("0") }, taxes: [], total: fromDollars("113.00"),
  createdAt: AT, validUntil: AT, status: "sent",
});

const estimate = (id: string, conversationId: string): EstimateDraft => ({
  id, conversationId, basedOn: "genericCatalog", lineItems: [],
  totalRange: { low: fromDollars("0"), high: fromDollars("0") },
  disclaimer: "", createdAt: AT,
});

test("超过 24 个月的会话进入清除计划", () => {
  const plan = planRetentionSweep({
    conversations: [conv("cv_old", "2024-01-01T00:00:00.000Z"), conv("cv_new", "2026-01-01T00:00:00.000Z")],
    estimates: [estimate("est_old", "cv_old")],
    quotes: [], billingEvents: [], auditEvents: [], at: AT,
  });
  assert.deepEqual(plan.conversationsToDelete, ["cv_old"]);
  assert.deepEqual(plan.estimatesToDelete, ["est_old"]);
});

test("已发送的报价不删除，改为去标识化保留（法定 7 年）", () => {
  const plan = planRetentionSweep({
    conversations: [conv("cv_old", "2024-01-01T00:00:00.000Z")],
    estimates: [],
    quotes: [quote("q1", "cv_old")],
    billingEvents: [], auditEvents: [], at: AT,
  });
  assert.deepEqual(plan.quotesToDeIdentify, ["q1"]);
  assert.ok(plan.notes.some((n) => n.includes("7 年")));
});

test("账号注销后 30 天宽限期内不清除，之后清除", () => {
  const base = {
    conversations: [conv("cv_1", "2026-05-01T00:00:00.000Z")],
    estimates: [], quotes: [], billingEvents: [], auditEvents: [],
  };
  const within = planRetentionSweep({
    ...base, deletedAccounts: [{ accountId: "ca_1", deletedAt: "2026-05-25T00:00:00.000Z" }], at: AT,
  });
  assert.equal(within.conversationsToDelete.length, 0, "宽限期内不应清除");

  const after = planRetentionSweep({
    ...base, deletedAccounts: [{ accountId: "ca_1", deletedAt: "2026-04-01T00:00:00.000Z" }], at: AT,
  });
  assert.deepEqual(after.conversationsToDelete, ["cv_1"]);
});

test("超过 7 年的审计事件才允许物理删除", () => {
  const ev = (id: string, at: string): QuoteAuditEvent => ({
    id, quoteId: "q1", companyId: "co_1", at, actor: "system", action: "sent", contentHash: "h",
  });
  const plan = planRetentionSweep({
    conversations: [], estimates: [], quotes: [], billingEvents: [],
    auditEvents: [ev("old", "2018-01-01T00:00:00.000Z"), ev("recent", "2025-01-01T00:00:00.000Z")],
    at: AT,
  });
  assert.deepEqual(plan.auditToDelete, ["old"]);
});

test("去标识化移除身份但保留金额明细", () => {
  const q = quote("q1", "cv_1");
  const d = deIdentifyQuote(q);
  assert.equal(d.customerAccountId, DEIDENTIFIED);
  assert.equal(d.conversationId, DEIDENTIFIED);
  assert.equal(d.total, q.total, "金额必须保留（财务留存的意义所在）");
  assert.equal(d.companyId, q.companyId);
});

test("计费事件去标识化同理", () => {
  const e: LeadBillingEvent = {
    id: "lbe1", companyId: "co_1", conversationId: "cv_1", quoteId: "q1",
    customerAccountId: "ca_1", sentAt: AT, dedupeKey: "k",
    feeAmount: fromDollars("45.00"), currency: "CAD", feeStatus: "invoiced",
  };
  const d = deIdentifyBillingEvent(e);
  assert.equal(d.customerAccountId, DEIDENTIFIED);
  assert.equal(d.feeAmount, e.feeAmount);
  assert.equal(d.feeStatus, "invoiced");
});

test("已去标识化的报价不会被重复计划", () => {
  const plan = planRetentionSweep({
    conversations: [conv("cv_old", "2024-01-01T00:00:00.000Z")],
    estimates: [],
    quotes: [deIdentifyQuote(quote("q1", "cv_old"))],
    billingEvents: [], auditEvents: [], at: AT,
  });
  assert.equal(plan.quotesToDeIdentify.length, 0);
});

// ── 数据主体权利 ──────────────────────────────────────────────────────────

test("访问权导出该账号的全部个人信息", () => {
  const exported = exportAccountData(account, {
    conversations: [conv("cv_1", AT), { ...conv("cv_2", AT), customerAccountId: "ca_other" }],
    estimates: [estimate("est_1", "cv_1")],
    quotes: [quote("q1", "cv_1")],
  }, AT);
  assert.equal(exported.conversations.length, 1);
  assert.equal(exported.estimates.length, 1);
  assert.equal(exported.quotes.length, 1);
  assert.ok(exported.notes.some((n) => n.includes("7 年")));
});

test("删除权：冲突时去标识化保留，且如实说明原因", () => {
  const outcome = executeDeletionRequest("ca_1", {
    conversations: [conv("cv_1", AT)],
    estimates: [estimate("est_1", "cv_1")],
    quotes: [quote("q1", "cv_1")],
    billingEvents: [{
      id: "lbe1", companyId: "co_1", conversationId: "cv_1", quoteId: "q1",
      customerAccountId: "ca_1", sentAt: AT, dedupeKey: "k",
      feeAmount: fromDollars("45.00"), currency: "CAD", feeStatus: "invoiced",
    }],
  });
  assert.deepEqual(outcome.conversationsDeleted, ["cv_1"]);
  assert.deepEqual(outcome.quotesDeIdentified, ["q1"]);
  assert.deepEqual(outcome.billingDeIdentified, ["lbe1"]);
  // 必须解释为什么不能直接删，而不是拒绝整个请求
  assert.match(outcome.explanation, /7 年/);
  assert.match(outcome.explanation, /去标识化/);
});

test("无留存冲突时说明「不再持有你的个人信息」", () => {
  const outcome = executeDeletionRequest("ca_1", {
    conversations: [conv("cv_1", AT)], estimates: [], quotes: [], billingEvents: [],
  });
  assert.match(outcome.explanation, /不再持有你的个人信息/);
});

test("数据主体请求 30 天响应时限（PIPEDA）", () => {
  const req: SubjectRequest = {
    id: "sr1", accountId: "ca_1", kind: "access", requestedAt: "2026-06-01T00:00:00.000Z",
  };
  assert.equal(responseDueBy(req), "2026-07-01T00:00:00.000Z");
  assert.equal(RETENTION.subjectRequestResponseDays, 30);
  assert.equal(isOverdue(req, "2026-06-15T00:00:00.000Z"), false);
  assert.equal(isOverdue(req, "2026-07-05T00:00:00.000Z"), true);
  assert.equal(isOverdue({ ...req, respondedAt: "2026-06-10T00:00:00.000Z" }, "2026-08-01T00:00:00.000Z"), false);
});
