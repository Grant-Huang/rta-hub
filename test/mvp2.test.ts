/**
 * FR-6 比价表 + FR-7 HTML 邮件 + 含四视图的 EstimateDraft + 第二家试点公司。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromDollars, type Money } from "../src/domain/money.js";
import { buildComparison, renderComparisonHtml, renderComparisonText } from "../src/quote/comparison.js";
import { buildHtmlQuoteEmail } from "../src/email/html-quote.js";
import { assertCaslCompliant, CaslComplianceError, sendEmail, type SenderIdentity } from "../src/email/sender.js";
import { buildIllustratedEstimate, catalogToPseudoModules } from "../src/estimate/generic.js";
import { genericCatalog } from "../src/app/seed.js";
import {
  buildSecondCompanyBundle, secondCompany, secondCompanyFaceOverrides, secondCompanyTemplates,
} from "../src/app/seed-second.js";
import { importSpecTemplates } from "../src/spec/import.js";
import { computePrice } from "../src/pricing/engine.js";
import { toPricingContext } from "../src/spec/bundle.js";
import { SEED_TAX_RULES } from "../src/pricing/tax.js";
import { generateLayout } from "../src/layout/generate.js";
import { renderFourViews } from "../src/render/views.js";
import type { ParsedGeometry, WallRun } from "../src/floorplan/types.js";
import type { Quote } from "../src/domain/types.js";

const AT = "2026-06-01T00:00:00.000Z";

function quote(over: Partial<Quote> & { total: Money }): Quote {
  return {
    id: "q1", designLayoutId: "dl", designRevisionNo: 1, companyId: "co_a",
    conversationId: "cv_1", customerAccountId: "ca_1", specVersionId: "sv",
    accountTypeAtQuote: "consumer", doorStyleId: "ds_a", priceGroupId: "pg_a",
    currency: "CAD", province: "ON",
    taxRuleSnapshot: { id: "t", province: "ON", components: [{ name: "HST", ratePercent: 13 }], compounded: false, effectiveFrom: AT },
    appliedDiscountRuleIds: [], lineItems: [], subtotal: fromDollars("1000.00"),
    discounts: [], shipping: { amount: fromDollars("0") },
    taxes: [{ name: "HST", ratePercent: 13, amount: fromDollars("130.00") }],
    createdAt: AT, validUntil: "2026-07-01T00:00:00.000Z", status: "draft",
    ...over,
  };
}

const names: Record<string, string> = { co_a: "Maple Ridge", co_b: "Lakeside", co_c: "Northern" };
const nameOf = (id: string) => names[id];

// ── FR-6 比价表 ───────────────────────────────────────────────────────────

test("对比表按总价升序，最低价标 delta 为 0", () => {
  const cmp = buildComparison("cv_1", [
    quote({ id: "q1", companyId: "co_a", total: fromDollars("1130.00") }),
    quote({ id: "q2", companyId: "co_b", total: fromDollars("980.00") }),
    quote({ id: "q3", companyId: "co_c", total: fromDollars("1450.00") }),
  ], nameOf, AT);

  assert.deepEqual(cmp.rows.map((r) => r.companyName), ["Lakeside", "Maple Ridge", "Northern"]);
  assert.equal(cmp.rows[0]!.deltaFromLowest, 0);
  assert.equal(cmp.rows[1]!.deltaFromLowest, fromDollars("150.00"));
  assert.equal(cmp.spread, fromDollars("470.00"));
});

test("含税口径不一致时明确警告（FR-6 的关键要求）", () => {
  const cmp = buildComparison("cv_1", [
    quote({ id: "q1", companyId: "co_a", total: fromDollars("1130.00") }),
    quote({ id: "q2", companyId: "co_b", total: fromDollars("1000.00"), taxes: [] }),
  ], nameOf, AT);

  const warn = cmp.warnings.find((w) => w.code === "MIXED_TAX_BASIS");
  assert.ok(warn, "必须提示含税口径不一致");
  assert.match(warn.message, /未税小计/);
  assert.equal(cmp.comparable, false);
});

test("口径一致时不报警告", () => {
  const cmp = buildComparison("cv_1", [
    quote({ id: "q1", companyId: "co_a", total: fromDollars("1130.00") }),
    quote({ id: "q2", companyId: "co_b", total: fromDollars("1300.00") }),
  ], nameOf, AT);
  assert.equal(cmp.warnings.length, 0);
  assert.equal(cmp.comparable, true);
});

test("方案范围差异过大时提示总价不可直接比", () => {
  const cmp = buildComparison("cv_1", [
    quote({ id: "q1", companyId: "co_a", total: fromDollars("1130.00"),
      lineItems: [{ moduleId: "m", moduleCode: "B30", qty: 4, width: 30, height: 34.5, depth: 24, assembly: "RTA", unitListPrice: fromDollars("1"), modifiers: [], unitNetPrice: fromDollars("1"), lineSubtotal: fromDollars("4") }] }),
    quote({ id: "q2", companyId: "co_b", total: fromDollars("1300.00"),
      lineItems: [{ moduleId: "m", moduleCode: "B30", qty: 12, width: 30, height: 34.5, depth: 24, assembly: "RTA", unitListPrice: fromDollars("1"), modifiers: [], unitNetPrice: fromDollars("1"), lineSubtotal: fromDollars("12") }] }),
  ], nameOf, AT);
  assert.ok(cmp.warnings.some((w) => w.code === "DIFFERENT_SCOPE"));
});

test("不同价格组时提示价差部分来自门板档次", () => {
  const cmp = buildComparison("cv_1", [
    quote({ id: "q1", companyId: "co_a", total: fromDollars("1000.00"), priceGroupId: "pg_a" }),
    quote({ id: "q2", companyId: "co_b", total: fromDollars("1800.00"), priceGroupId: "pg_premium" }),
  ], nameOf, AT);
  assert.ok(cmp.warnings.some((w) => w.code === "DIFFERENT_PRICE_GROUP"));
});

test("过期报价被标出，但不影响其他行的可比性", () => {
  const cmp = buildComparison("cv_1", [
    quote({ id: "q1", companyId: "co_a", total: fromDollars("1130.00"), validUntil: "2026-05-01T00:00:00.000Z" }),
    quote({ id: "q2", companyId: "co_b", total: fromDollars("1300.00") }),
  ], nameOf, AT);
  assert.ok(cmp.warnings.some((w) => w.code === "EXPIRED_QUOTE"));
  assert.equal(cmp.comparable, true, "只有过期警告时仍算口径一致");
});

test("草稿状态的报价也能参与对比（随时可拉草稿对比）", () => {
  const cmp = buildComparison("cv_1", [
    quote({ id: "q1", companyId: "co_a", total: fromDollars("1130.00"), status: "draft" }),
    quote({ id: "q2", companyId: "co_b", total: fromDollars("1300.00"), status: "confirmed" }),
  ], nameOf, AT);
  assert.equal(cmp.rows.length, 2);
});

test("只统计本会话的报价", () => {
  const cmp = buildComparison("cv_1", [
    quote({ id: "q1", conversationId: "cv_1", total: fromDollars("100.00") }),
    quote({ id: "q2", conversationId: "cv_other", total: fromDollars("200.00") }),
  ], nameOf, AT);
  assert.equal(cmp.rows.length, 1);
});

test("文本与 HTML 呈现都注明只比价格不比图纸", () => {
  const cmp = buildComparison("cv_1", [
    quote({ id: "q1", companyId: "co_a", total: fromDollars("1130.00") }),
    quote({ id: "q2", companyId: "co_b", total: fromDollars("980.00") }),
  ], nameOf, AT);
  const text = renderComparisonText(cmp);
  const html = renderComparisonHtml(cmp);
  assert.match(text, /只比价格/);
  assert.match(html, /只比价格/);
  assert.match(text, /Lakeside/);
  assert.match(html, /Lakeside/);
});

test("空对比表不崩", () => {
  const cmp = buildComparison("cv_1", [], nameOf, AT);
  assert.equal(cmp.rows.length, 0);
  assert.match(renderComparisonText(cmp), /还没有/);
});

// ── FR-7 HTML 邮件 ────────────────────────────────────────────────────────

const run: WallRun = {
  id: "wr_1", label: "北墙", length: 144, startsAtCorner: false, endsAtCorner: true,
  features: [{ id: "f1", kind: "plumbing", offset: 60, width: 0 }],
};
const geometry: ParsedGeometry = { wallRuns: [run], ceilingHeight: 96, confidence: 0.9 };
const sender: SenderIdentity = { name: "RTA-Hub", email: "hi@rta-hub.example", contact: "+1-416-555-0100" };

function buildViews() {
  const { bundle } = buildSecondCompanyBundle();
  const layout = generateLayout(geometry, bundle.modules, { ceilingHeight: 96 });
  return [{ runLabel: run.label, views: renderFourViews(run, layout.placements) }];
}

test("HTML 邮件四层兜底齐备：内嵌图 + 表格 + 纯文本 + 附件", () => {
  const email = buildHtmlQuoteEmail({
    quote: quote({ lineItems: [{ moduleId: "m", moduleCode: "NW-B30", qty: 4, width: 30, height: 34.5, depth: 24, assembly: "RTA", unitListPrice: fromDollars("233.00"), modifiers: [], unitNetPrice: fromDollars("233.00"), lineSubtotal: fromDollars("932.00") }], total: fromDollars("1130.00") }),
    companyName: "Lakeside", customerName: "Alex", customerEmail: "alex@example.com",
    viewsByRun: buildViews(), senderName: sender.name, senderContact: sender.contact,
  });

  // 1. CID 内嵌
  assert.match(email.html, /<img src="cid:view-0-front@rta-hub"/);
  // 2. HTML 表格
  assert.match(email.html, /<table/);
  assert.match(email.html, /NW-B30/);
  // 3. 纯文本兜底且内容完整（不是"请用 HTML 查看"）
  assert.match(email.text, /NW-B30/);
  assert.match(email.text, /总计/);
  assert.ok(!/请用.*查看/.test(email.text));
  // 4. 附件兜底
  assert.equal(email.attachments.length, 4);
  assert.ok(email.attachments.every((a) => a.cid && a.contentType === "image/svg+xml"));
  assert.match(email.html, /附件中包含同样的四张视图/);
});

test("每段墙各出四张图", () => {
  const twoRuns = [
    { runLabel: "北墙", views: buildViews()[0]!.views },
    { runLabel: "西墙", views: buildViews()[0]!.views },
  ];
  const email = buildHtmlQuoteEmail({
    quote: quote({ total: fromDollars("1000.00") }),
    companyName: "X", customerName: "A", customerEmail: "a@b.com",
    viewsByRun: twoRuns, senderName: sender.name,
  });
  assert.equal(email.attachments.length, 8);
});

test("HTML 报价邮件通过 CASL 校验", () => {
  const email = buildHtmlQuoteEmail({
    quote: quote({ total: fromDollars("1000.00") }),
    companyName: "X", customerName: "A", customerEmail: "a@b.com",
    viewsByRun: buildViews(), senderName: sender.name, senderContact: sender.contact,
  });
  assert.doesNotThrow(() => assertCaslCompliant({
    kind: "lead", to: "q@x.example", subject: email.subject,
    text: email.text, html: email.html,
  }, sender));
});

test("营销类邮件的退订链接必须同时在纯文本与 HTML 里", () => {
  const url = "https://x.example/unsubscribe?token=abc";
  // 只放在纯文本里 → HTML 版收件人无从退订
  assert.throws(
    () => assertCaslCompliant({
      kind: "mailing", to: "a@b.com", subject: "s",
      text: `RTA-Hub 你好\n退订：${url}`,
      html: "<p>RTA-Hub 你好</p>",
      unsubscribeUrl: url,
    }, sender),
    (e: unknown) => e instanceof CaslComplianceError && e.code === "UNSUBSCRIBE_NOT_IN_BODY",
  );
  // 两处都有 → 通过
  assert.doesNotThrow(() => assertCaslCompliant({
    kind: "mailing", to: "a@b.com", subject: "s",
    text: `RTA-Hub 你好\n退订：${url}`,
    html: `<p>RTA-Hub 你好</p><a href="${url}">退订</a>`,
    unsubscribeUrl: url,
  }, sender));
});

test("发送时把 HTML 与 CID 附件都传给传输器", async () => {
  const sent: Record<string, unknown>[] = [];
  const email = buildHtmlQuoteEmail({
    quote: quote({ total: fromDollars("1000.00") }),
    companyName: "X", customerName: "A", customerEmail: "a@b.com",
    viewsByRun: buildViews(), senderName: sender.name, senderContact: sender.contact,
  });
  const r = await sendEmail({
    kind: "lead", to: "quotes@x.example", subject: email.subject,
    text: email.text, html: email.html, attachments: email.attachments,
  }, { sender, transport: { async sendMail(m) { sent.push(m); return {}; } } });

  assert.equal(r.delivered, true);
  const msg = sent[0]!;
  assert.ok(typeof msg["html"] === "string");
  const atts = msg["attachments"] as { cid?: string; contentDisposition?: string }[];
  assert.equal(atts.length, 4);
  assert.ok(atts.every((a) => a.cid && a.contentDisposition === "inline"));
});

// ── 含四视图的 EstimateDraft ──────────────────────────────────────────────

test("通用目录能转成可排布可渲染的伪型号", () => {
  const modules = catalogToPseudoModules(genericCatalog);
  assert.ok(modules.length > 0);
  // ★ 关键：伪型号不属于任何公司，因此不可能通过 FR-8 校验
  assert.ok(modules.every((m) => m.companyId === ""));
  assert.ok(modules.every((m) => m.faceTemplateId));
});

test("含四视图的预估：有图、有区间、有双重免责声明", () => {
  const illustrated = buildIllustratedEstimate(genericCatalog, geometry, {
    conversationId: "cv_1", province: "ON", at: AT,
  }, { taxRules: SEED_TAX_RULES });

  assert.equal(illustrated.viewsByRun.length, 1);
  for (const svg of Object.values(illustrated.viewsByRun[0]!.views)) {
    assert.match(svg, /^<svg /);
  }
  assert.ok(illustrated.draft.totalRange.high > illustrated.draft.totalRange.low);
  // 预估本身的免责
  assert.match(illustrated.draft.disclaimer, /不是任何具体公司的真实报价/);
  // 示意图另有一条免责：画的不是真实型号
  assert.match(illustrated.viewsDisclaimer, /不对应任何具体公司的真实型号/);
});

test("含四视图的预估仍然没有 companyId，不可能被发送", () => {
  const illustrated = buildIllustratedEstimate(genericCatalog, geometry, {
    conversationId: "cv_1", at: AT,
  });
  assert.ok(!("companyId" in illustrated.draft));
});

test("预估数量来自排布结果而不是文本粗估", () => {
  const illustrated = buildIllustratedEstimate(genericCatalog, geometry, {
    conversationId: "cv_1", moduleCounts: { base: 99 }, at: AT,
  });
  const base = illustrated.draft.lineItems.find((l) => l.moduleType === "base");
  assert.ok(base && base.qty !== 99, "排布结果应覆盖粗估值");
});

// ── 第二家试点公司（FR-2 可复制性）────────────────────────────────────────

test("第二家公司完全通过模板导入建立，无待确认项", () => {
  const { bundle, unresolvedCount } = buildSecondCompanyBundle();
  assert.equal(unresolvedCount, 0, "导入应干净通过");
  assert.equal(bundle.modules.length, 16);
  assert.equal(bundle.doorStyles.length, 3);
  assert.equal(bundle.priceGroups.length, 2);
  assert.equal(bundle.priceMatrix.length, 32);
});

test("自有命名体系靠公司覆盖表救回脸型匹配", () => {
  // 不给覆盖表 → 通用规则认不出 NW- 前缀，全部进待确认
  const without = importSpecTemplates("sv", "co", secondCompanyTemplates);
  assert.ok(without.unresolved.some((u) => u.field === "faceTemplate"),
    "无覆盖表时应认不出脸型并进待确认队列");
  assert.equal(without.stats.faceTemplateRuleHits, 0);

  // 给了覆盖表 → 全部命中
  const withOverrides = importSpecTemplates("sv", "co", secondCompanyTemplates, secondCompanyFaceOverrides);
  assert.equal(withOverrides.unresolved.length, 0);
  assert.equal(withOverrides.stats.faceTemplateRuleHits, 16);
});

test("第二家公司的报价能正常算出来（与第一家同一套引擎）", () => {
  const { bundle } = buildSecondCompanyBundle();
  const ctx = toPricingContext(bundle, SEED_TAX_RULES);
  const b30 = bundle.modules.find((m) => m.code === "NW-B30")!;
  const std = bundle.doorStyles.find((d) => d.name === "Flat Slab White")!;

  const result = computePrice(ctx, {
    selections: [{
      moduleId: b30.id, qty: 4, width: 30, height: 34.5, depth: 24,
      assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [],
    }],
    doorStyleId: std.id, accountType: "consumer", province: "ON", at: AT,
  });

  assert.equal(result.lineItems[0]!.unitListPrice, fromDollars("233.00"));
  assert.equal(result.subtotal, fromDollars("932.00"));
  assert.equal(result.shipping.amount, fromDollars("120.00")); // 定额运费
  assert.equal(result.taxes[0]!.name, "HST");
});

test("第二家公司用无框柜 + 半覆盖门板，渲染参数确实不同", () => {
  const { bundle } = buildSecondCompanyBundle();
  const layout = generateLayout(geometry, bundle.modules, { ceilingHeight: 96 });
  const framedFull = renderFourViews(run, layout.placements, {
    overlay: "full", construction: "framed", faceFrameWidth: 1.5, pxPerInch: 6, showDimensions: true,
  });
  const framelessPartial = renderFourViews(run, layout.placements, {
    overlay: "partial", construction: "frameless", faceFrameWidth: 1.5, pxPerInch: 6, showDimensions: true,
  });
  assert.notEqual(framedFull.front, framelessPartial.front,
    "面框与门板覆盖方式应产出不同的正视图");
});

test("两家公司的方案可以放进同一张对比表", () => {
  const { bundle } = buildSecondCompanyBundle();
  const ctx = toPricingContext(bundle, SEED_TAX_RULES);
  const b30 = bundle.modules.find((m) => m.code === "NW-B30")!;
  const std = bundle.doorStyles.find((d) => d.name === "Flat Slab White")!;
  const priced = computePrice(ctx, {
    selections: [{ moduleId: b30.id, qty: 4, width: 30, height: 34.5, depth: 24, assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [] }],
    doorStyleId: std.id, accountType: "consumer", province: "ON", at: AT,
  });

  const cmp = buildComparison("cv_1", [
    quote({ id: "q1", companyId: "co_a", total: fromDollars("1400.00") }),
    quote({
      id: "q2", companyId: secondCompany.id, total: priced.total,
      subtotal: priced.subtotal, taxes: priced.taxes, shipping: priced.shipping,
    }),
  ], (id) => (id === secondCompany.id ? secondCompany.name : names[id]), AT);

  assert.equal(cmp.rows.length, 2);
  assert.ok(cmp.rows.some((r) => r.companyName === "Lakeside Kitchen Works"));
});
