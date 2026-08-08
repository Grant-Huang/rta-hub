/**
 * MVP-3：方案持久化 + PDF 报价单 + 贸易账号（多项目 / 资质核实）+ 争议裁定台。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromDollars, type Money } from "../src/domain/money.js";
import type { Conversation, CustomerAccount, Quote } from "../src/domain/types.js";
import type { ParsedGeometry, WallRun } from "../src/floorplan/types.js";
import { generateLayout } from "../src/layout/generate.js";
import {
  buildDesignLayout, buildRevision, layoutKey, toGeneratedLayout, toStoredLayout,
} from "../src/layout/store.js";
import { BLACK, LETTER, PdfPage, buildPdf } from "../src/pdf/writer.js";
import { buildQuotePdf, elevationLabel, quoteFilename } from "../src/pdf/quote-pdf.js";
import { listProjects, summarizePortfolio, DORMANT_DAYS } from "../src/trade/projects.js";
import { interactionProfile } from "../src/trade/interaction.js";
import {
  canSeeTradePricing, effectiveAccountType, looksLikeGstNumber, normalizeBusinessNumber,
  reviewVerification, submitVerification, VerificationError, type TradeVerification,
} from "../src/trade/verification.js";
import { pilotModules } from "../src/app/seed.js";

const AT = "2026-06-01T00:00:00.000Z";

// ── 夹具 ──────────────────────────────────────────────────────────────────

const run: WallRun = {
  id: "wr_1", label: "北墙", length: 144, startsAtCorner: true, endsAtCorner: true,
  features: [{ id: "f_win", kind: "window", offset: 60, width: 36 }],
};
const geometry: ParsedGeometry = { wallRuns: [run], ceilingHeight: 96, confidence: 0.9 };

function quote(over: Partial<Quote> & { total: Money }): Quote {
  return {
    id: "q1", designLayoutId: "dl_1", designRevisionNo: 1, companyId: "co_a",
    conversationId: "cv_1", customerAccountId: "ca_1", specVersionId: "sv_1",
    accountTypeAtQuote: "consumer", doorStyleId: "ds_a", priceGroupId: "pg_a",
    currency: "CAD", province: "ON",
    taxRuleSnapshot: {
      id: "t", province: "ON", components: [{ name: "HST", ratePercent: 13 }],
      compounded: false, effectiveFrom: AT,
    },
    appliedDiscountRuleIds: [],
    lineItems: [{
      moduleId: "m_b30", moduleCode: "B30", qty: 4, width: 30, height: 34.5, depth: 24,
      assembly: "RTA", unitListPrice: fromDollars("245.50"), modifiers: [],
      unitNetPrice: fromDollars("245.50"), lineSubtotal: fromDollars("982.00"),
    }],
    subtotal: fromDollars("982.00"), discounts: [], shipping: { amount: fromDollars("0") },
    taxes: [{ name: "HST", ratePercent: 13, amount: fromDollars("127.66") }],
    createdAt: AT, validUntil: "2026-07-01T00:00:00.000Z", status: "draft",
    ...over,
  };
}

function account(over: Partial<CustomerAccount> = {}): CustomerAccount {
  return {
    id: "ca_1", accountType: "consumer", email: "a@example.com", displayName: "Alex",
    province: "ON", consentRecords: [], ...over,
  };
}

function conversation(over: Partial<Conversation> & { id: string }): Conversation {
  return {
    customerAccountId: "ca_1", messages: [], designRequirements: "",
    perCompanyThreads: [], createdAt: AT, ...over,
  };
}

const daysAfter = (days: number): string =>
  new Date(Date.parse(AT) + days * 86_400_000).toISOString();

// ── 方案持久化（§3.6 修订链）──────────────────────────────────────────────

test("StoredLayout 往返不丢排布结果", () => {
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
  const stored = toStoredLayout({
    floorPlanId: "fp_1", companyId: "co_a", conversationId: "cv_1",
    designLayoutId: "dl_1", revisionNo: 1, layout, at: AT,
  });

  assert.equal(stored.id, layoutKey("fp_1", "co_a"));
  const back = toGeneratedLayout(stored);
  assert.deepEqual(back.placements, layout.placements);
  assert.deepEqual(back.moduleCounts, layout.moduleCounts);
  assert.deepEqual(back.ergonomics, layout.ergonomics);
  assert.equal(back.acceptable, layout.acceptable);
});

test("重算保留 createdAt，只推进 updatedAt 与修订号", () => {
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
  const first = toStoredLayout({
    floorPlanId: "fp_1", companyId: "co_a", conversationId: "cv_1",
    designLayoutId: "dl_1", revisionNo: 1, layout, at: AT,
  });
  const later = daysAfter(2);
  const second = toStoredLayout({
    floorPlanId: "fp_1", companyId: "co_a", conversationId: "cv_1",
    designLayoutId: "dl_1", revisionNo: 2, layout, at: later, createdAt: first.createdAt,
  });

  assert.equal(second.createdAt, AT);
  assert.equal(second.updatedAt, later);
  assert.equal(second.currentRevisionNo, 2);
  // 同一 (户型, 公司) 的工作态只有一条，id 不变才能被 upsert 覆盖
  assert.equal(second.id, first.id);
});

test("修订记录 id 含修订号，多轮修改不会互相覆盖", () => {
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
  const r1 = buildRevision({
    designLayoutId: "dl_1", revisionNo: 1, layout,
    triggeredBy: "auto", changeSummary: "初版", at: AT,
  });
  const r2 = buildRevision({
    designLayoutId: "dl_1", revisionNo: 2, layout,
    triggeredBy: "customerRequest", changeSummary: "客户要求加抽屉柜", at: daysAfter(1),
  });
  assert.notEqual(r1.id, r2.id);
  assert.equal(r2.triggeredBy, "customerRequest");
  // 修订里只有选择，没有任何金额字段（FR-8）
  assert.ok(!JSON.stringify(r1).match(/price|Price|amount|total/));
});

test("DesignLayout 承载 specVersionId —— 报价据此追溯到当时的规格版本", () => {
  const dl = buildDesignLayout({
    id: "dl_1", companyId: "co_a", conversationId: "cv_1",
    specVersionId: "sv_7", floorPlanId: "fp_1", revisionNo: 3,
  });
  assert.equal(dl.specVersionId, "sv_7");
  assert.equal(dl.currentRevisionNo, 3);
  assert.equal(dl.status, "draft");
});

// ── PDF 写入器 ────────────────────────────────────────────────────────────

test("PDF 结构合法：头、xref 偏移、trailer", () => {
  const page = new PdfPage(LETTER);
  page.setFill(BLACK).text("Hello", 72, 72).rect(72, 100, 200, 50);
  const buf = buildPdf([page], { title: "T", author: "A" });
  const s = buf.toString("latin1");

  assert.ok(s.startsWith("%PDF-1.4\n"));
  assert.ok(s.trimEnd().endsWith("%%EOF"));

  // startxref 必须真的指向 xref 关键字所在的字节偏移
  const m = /startxref\n(\d+)\n%%EOF/.exec(s);
  assert.ok(m, "缺少 startxref");
  assert.equal(s.slice(Number(m![1]), Number(m![1]) + 4), "xref");
});

test("非 Latin-1 字符被报出来，不静默丢字", () => {
  const page = new PdfPage(LETTER);
  page.text("枫岭橱柜", 72, 72);
  assert.equal(page.warnings.length, 1);
  assert.match(page.warnings[0]!, /枫/);
});

test("排版标点（破折号、弯引号）属于 WinAnsi，不该被判为不支持", () => {
  const page = new PdfPage(LETTER);
  page.text("Maple — Ridge’s “quote”", 72, 72);
  assert.deepEqual(page.warnings, []);
});

test("PDF 括号与反斜杠被转义，不会截断内容流", () => {
  const page = new PdfPage(LETTER);
  page.text("B30 (RTA) \\ special", 72, 72);
  const s = buildPdf([page]).toString("latin1");
  assert.ok(s.includes("B30 \\(RTA\\) \\\\ special"));
});

test("空文档被拒绝而不是产出坏文件", () => {
  assert.throws(() => buildPdf([]), /至少需要一页/);
});

// ── 报价单 PDF ────────────────────────────────────────────────────────────

test("报价单：一页摘要 + 每段墙一页立面图", () => {
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
  const q = quote({ total: fromDollars("1109.66") });
  const { pdf, warnings } = buildQuotePdf({
    quote: q, companyName: "Maple Ridge Cabinets", customerName: "Alex",
    customerEmail: "alex@example.com", province: "ON", doorStyleName: "Shaker White",
    runs: [{ run, placements: layout.placements }],
    senderName: "RTA Hub",
  });

  const s = pdf.toString("latin1");
  assert.equal((s.match(/\/Type \/Page[^s]/g) ?? []).length, 2);
  // 中文墙段标签换成了英文说法，纸面上不该留 `??`，也不该有告警
  assert.deepEqual(warnings, []);
  assert.ok(s.includes("North Wall"));
  assert.ok(!s.includes("ELEVATION — ??"));
  // 关键商业信息必须出现在纸面上
  for (const needle of ["Maple Ridge Cabinets", "Shaker White", "B30"]) {
    assert.ok(s.includes(needle), `PDF 缺少 ${needle}`);
  }
});

test("画不出的墙段标签退到位置编号，绝不留 ??", () => {
  assert.equal(elevationLabel("North Wall", 0), "North Wall");
  assert.equal(elevationLabel("北墙", 0), "North Wall");
  assert.equal(elevationLabel("阳台外挂那面墙", 2), "Wall 3");
});

test("长度为 0 的墙段不出立面页（避免空白页）", () => {
  const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96 });
  const empty: WallRun = { ...run, id: "wr_2", label: "西墙", length: 0, features: [] };
  const { pdf } = buildQuotePdf({
    quote: quote({ total: fromDollars("1109.66") }),
    companyName: "Maple Ridge", customerName: "Alex", customerEmail: "a@example.com",
    province: "ON", doorStyleName: "Shaker White",
    runs: [{ run, placements: layout.placements }, { run: empty, placements: [] }],
    senderName: "RTA Hub",
  });
  assert.equal((pdf.toString("latin1").match(/\/Type \/Page[^s]/g) ?? []).length, 2);
});

test("文件名带报价号，便于公司归档", () => {
  assert.match(quoteFilename(quote({ id: "q_abc123", total: fromDollars("100") })), /q_abc123.*\.pdf$/);
});

// ── 贸易账号：多项目 ──────────────────────────────────────────────────────

test("项目列表按最近活动倒序，并带最低报价", () => {
  const acct = account({ id: "ca_t", accountType: "trade" });
  const convs = [
    conversation({
      id: "cv_old", customerAccountId: "ca_t", designRequirements: "枫树街 12 号",
      messages: [{ role: "user", content: "开始", at: AT }],
    }),
    conversation({
      id: "cv_new", customerAccountId: "ca_t", designRequirements: "湖滨路 3 号",
      messages: [{ role: "user", content: "开始", at: daysAfter(5) }],
    }),
    conversation({ id: "cv_other", customerAccountId: "ca_someone_else" }),
  ];
  const quotes = [
    quote({ id: "q_a", conversationId: "cv_old", companyId: "co_a", total: fromDollars("9000") }),
    quote({ id: "q_b", conversationId: "cv_old", companyId: "co_b", total: fromDollars("7500") }),
  ];

  const projects = listProjects({ account: acct, conversations: convs, quotes, at: daysAfter(6) });
  assert.deepEqual(projects.map((p) => p.conversationId), ["cv_new", "cv_old"]);
  // 别人的会话不能出现在我的项目列表里
  assert.ok(!projects.some((p) => p.conversationId === "cv_other"));

  const old = projects.find((p) => p.conversationId === "cv_old")!;
  assert.equal(old.title, "枫树街 12 号");
  assert.equal(old.quoteCount, 2);
  assert.equal(old.lowestQuote?.companyId, "co_b");
});

test("超过 30 天没动静的项目标为 dormant", () => {
  const acct = account({ id: "ca_t", accountType: "trade" });
  const convs = [conversation({
    id: "cv_1", customerAccountId: "ca_t",
    messages: [{ role: "user", content: "开始", at: AT }],
  })];
  const at = daysAfter(DORMANT_DAYS + 1);
  const projects = listProjects({ account: acct, conversations: convs, quotes: [], at });
  assert.equal(projects[0]!.status, "dormant");
  assert.equal(summarizePortfolio(projects, []).dormant.length, 1);
});

test("已发送的报价让项目进入 sent，且计入采购量级", () => {
  const acct = account({ id: "ca_t", accountType: "trade" });
  const convs = [conversation({
    id: "cv_1", customerAccountId: "ca_t",
    messages: [{ role: "user", content: "开始", at: AT }],
  })];
  const quotes = [
    quote({ id: "q_a", conversationId: "cv_1", total: fromDollars("9000"), status: "sent" }),
    quote({ id: "q_b", conversationId: "cv_1", total: fromDollars("7500"), status: "draft" }),
  ];
  const projects = listProjects({ account: acct, conversations: convs, quotes, at: daysAfter(1) });
  assert.equal(projects[0]!.status, "sent");

  const portfolio = summarizePortfolio(projects, quotes);
  assert.equal(portfolio.byStatus.sent, 1);
  // 只统计已发送的那一笔
  assert.equal(portfolio.sentValue, fromDollars("9000"));
});

test("项目名没有需求摘要时退到首条用户消息，再退到日期", () => {
  const acct = account({ id: "ca_t", accountType: "trade" });
  const withMsg = listProjects({
    account: acct, quotes: [], at: daysAfter(1),
    conversations: [conversation({
      id: "cv_1", customerAccountId: "ca_t",
      messages: [{ role: "user", content: "帮我看看这套房", at: AT }],
    })],
  });
  assert.equal(withMsg[0]!.title, "帮我看看这套房");

  const bare = listProjects({
    account: acct, quotes: [], at: daysAfter(1),
    conversations: [conversation({ id: "cv_2", customerAccountId: "ca_t" })],
  });
  assert.match(bare[0]!.title, /2026-06-01/);
});

// ── 交互模式 ──────────────────────────────────────────────────────────────

test("交互差异只在问法上，不在能力上", () => {
  const consumer = interactionProfile("consumer");
  const trade = interactionProfile("trade");
  assert.ok(trade.maxQuestionsPerTurn > consumer.maxQuestionsPerTurn);
  assert.equal(trade.explainJargon, false);
  // profile 里不该出现任何"跳过校验/闸门"的开关——那会直接破坏 FR-8
  assert.ok(!Object.keys(trade).some((k) => /skipValidation|bypass|autoSend/i.test(k)));
});

// ── 贸易资质核实（开放问题 7）─────────────────────────────────────────────

test("未核实的 trade 账号按 consumer 定价，而不只是界面隐藏", () => {
  const acct = account({ accountType: "trade", subscriptionStatus: "active" });
  assert.equal(effectiveAccountType(acct, undefined), "consumer");
  const gate = canSeeTradePricing(acct, undefined);
  assert.equal(gate.allowed, false);
  assert.equal(gate.nextStep, "submitVerification");
});

test("两道门槛：核实通过但订阅失效同样拿不到贸易价", () => {
  const verified: TradeVerification = {
    id: "ca_1", accountId: "ca_1", status: "verified", reviewedAt: AT, reviewedBy: "ops",
  };
  const noSub = account({ accountType: "trade", subscriptionStatus: "none" });
  assert.equal(effectiveAccountType(noSub, verified), "consumer");
  assert.equal(canSeeTradePricing(noSub, verified).nextStep, "subscribe");

  const active = account({ accountType: "trade", subscriptionStatus: "active" });
  assert.equal(effectiveAccountType(active, verified), "trade");
  assert.equal(canSeeTradePricing(active, verified).allowed, true);

  // 试用期也算——不能让试用账号在试用期里拿不到它买的东西
  const trial = account({ accountType: "trade", subscriptionStatus: "trial" });
  assert.equal(effectiveAccountType(trial, verified), "trade");
});

test("消费者账号即使伪造 verification 也拿不到贸易价", () => {
  const verified: TradeVerification = { id: "ca_1", accountId: "ca_1", status: "verified" };
  assert.equal(effectiveAccountType(account({ accountType: "consumer" }), verified), "consumer");
});

test("提交资质：号码归一化，缺字段被拒", () => {
  const v = submitVerification(undefined, {
    accountId: "ca_1", businessNumber: " 123456789 rt 0001 ", legalName: "Riverside Builders Ltd", at: AT,
  });
  assert.equal(v.status, "pending");
  assert.equal(v.businessNumber, "123456789RT0001");
  assert.ok(looksLikeGstNumber(v.businessNumber!));

  assert.throws(() => submitVerification(undefined, {
    accountId: "ca_1", businessNumber: "123", legalName: "X", at: AT,
  }), VerificationError);
  assert.throws(() => submitVerification(undefined, {
    accountId: "ca_1", businessNumber: "123456789RT0001", legalName: "  ", at: AT,
  }), VerificationError);
});

test("不存证件影像 —— 结构里就没有这个字段（PIPEDA 最小化）", () => {
  const v = submitVerification(undefined, {
    accountId: "ca_1", businessNumber: "123456789RT0001", legalName: "X Ltd", at: AT,
  });
  assert.ok(!Object.keys(v).some((k) => /image|photo|document|scan|upload/i.test(k)));
});

test("审核：驳回必须给原因，已通过的不能重复提交", () => {
  const pending = submitVerification(undefined, {
    accountId: "ca_1", businessNumber: "123456789RT0001", legalName: "X Ltd", at: AT,
  });

  assert.throws(() => reviewVerification(pending, {
    approve: false, reviewedBy: "ops", at: AT,
  }), /reason|必须给出原因/i);

  const rejected = reviewVerification(pending, {
    approve: false, reviewedBy: "ops", reason: "GST 号查无此号", at: AT,
  });
  assert.equal(rejected.status, "rejected");
  // 驳回原因要能原样展示给申请人
  assert.match(canSeeTradePricing(
    account({ accountType: "trade" }), rejected).reason!, /查无此号/);
  assert.equal(canSeeTradePricing(account({ accountType: "trade" }), rejected).nextStep, "resubmit");

  const approved = reviewVerification(pending, { approve: true, reviewedBy: "ops", at: AT });
  assert.equal(approved.status, "verified");
  assert.throws(() => reviewVerification(approved, { approve: true, reviewedBy: "ops", at: AT }),
    /only pending|只有 pending/i);
  assert.throws(() => submitVerification(approved, {
    accountId: "ca_1", businessNumber: "123456789RT0001", legalName: "X Ltd", at: AT,
  }), /already verified|已通过资质审核/i);
});

test("被驳回后可以重新提交", () => {
  const rejected: TradeVerification = {
    id: "ca_1", accountId: "ca_1", status: "rejected", rejectionReason: "号码有误",
  };
  const again = submitVerification(rejected, {
    accountId: "ca_1", businessNumber: "987654321RT0002", legalName: "X Ltd", at: AT,
  });
  assert.equal(again.status, "pending");
  assert.equal(again.rejectionReason, undefined);
});

test("审核中按零售价，并说明还要等多久", () => {
  const pending = submitVerification(undefined, {
    accountId: "ca_1", businessNumber: "123456789RT0001", legalName: "X Ltd", at: AT,
  });
  const acct = account({ accountType: "trade", subscriptionStatus: "active" });
  assert.equal(effectiveAccountType(acct, pending), "consumer");
  assert.equal(canSeeTradePricing(acct, pending).nextStep, "awaitReview");
});

test("号码归一化去空格并转大写", () => {
  assert.equal(normalizeBusinessNumber(" 12 34 rt 0001 "), "1234RT0001");
});
