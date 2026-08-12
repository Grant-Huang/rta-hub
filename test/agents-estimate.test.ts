/**
 * Agent 编排、EstimateDraft、邮件 CASL 校验。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromDollars } from "../src/domain/money.js";
import {
  buildCompanyAgentSystem, companyAgentReply, companyAgentRestateHandoff, deterministicSpecAnswer,
  mergeRequirements, missingFields, optionsFor, orchestratorReply, proposeDesign,
} from "../src/agents/orchestrator.js";
import type { CompletionClient } from "../src/agents/types.js";
import {
  buildHandoff, deterministicHandoffRestate, renderHandoffContextNote,
} from "../src/session/company-engagement.js";
import {
  buildEstimateDraft, estimateCountsFromText, isSendable, renderEstimateText,
} from "../src/estimate/generic.js";
import {
  assertCaslCompliant, assertSubscribed, buildInviteEmail, buildQuoteEmail,
  CaslComplianceError, deIdentifySignal, sendEmail, type SenderIdentity,
} from "../src/email/sender.js";
import { SEED_TAX_RULES } from "../src/pricing/tax.js";
import { genericCatalog } from "../src/app/seed.js";
import type { EmailSubscription, GenericCatalog } from "../src/domain/types.js";
import { importSpecTemplates } from "../src/spec/import.js";
import type { SpecBundle } from "../src/spec/bundle.js";
import { formatModulePriceHint, priceSummaryForModule, standardAutoQuotableDiscount } from "../src/pricing/informal-quote.js";

const AT = "2026-06-01T00:00:00.000Z";

const bundle = importSpecTemplates("sv1", "co_1", {
  priceGroups: "code,displayName\nA,Standard\n",
  doorStyles: "name,priceGroup\nShaker White,A\n",
  modules: "code,type,widths,heights,depths\nB30,base,30,34-1/2,24\nW3030,wall,30,30|36|42,12\nSB36,sinkBase,36,34-1/2,24\n",
  priceMatrix: "moduleCode,priceGroup,listPrice\nB30,A,245.50\nW3030,A,178.00\nSB36,A,284.00\n",
}).bundle;

// ── 总控助手 ──────────────────────────────────────────────────────────────

test("无 LLM 时降级为确定性引导，核心链路不中断", async () => {
  const r = await orchestratorReply(undefined,
    { conversationId: "cv", requirements: "", history: [] },
    "我要装修厨房", optionsFor("consumer"));
  assert.ok(r.content.length > 0);
  assert.equal(r.requirements, "我要装修厨房");
});

test("需求摘要累积而不是被覆盖（旧实现的空串清空问题）", () => {
  assert.equal(mergeRequirements("厨房 12 尺", ""), "厨房 12 尺");
  assert.equal(mergeRequirements("厨房 12 尺", "预算 2 万"), "厨房 12 尺\n预算 2 万");
  assert.equal(mergeRequirements("厨房 12 尺", "厨房 12 尺"), "厨房 12 尺");
  assert.equal(mergeRequirements("", "第一句"), "第一句");
});

test("缺失字段识别", () => {
  assert.deepEqual(missingFields(""), ["kitchen size", "layout", "style", "budget", "province"]);
  const full = "厨房 12 尺，L 型布局，现代风格，预算 2 万加币，安大略省";
  assert.deepEqual(missingFields(full), []);
});

test("追问同一批字段的话术会逐轮退让，不会一字不差地重复", async () => {
  const ctx = { conversationId: "cv", requirements: "", history: [] };
  const say = async (repeatedAsk: number) =>
    (await orchestratorReply(undefined, ctx, "想换厨房",
      { ...optionsFor("consumer"), repeatedAsk, language: "zh" })).content;

  const first = await say(0);
  const second = await say(1);
  const third = await say(2);
  const fourth = await say(3);

  // 三个阶段：正常问 → 软化+指向选项 → 放弃再造词、稳定指向选项。
  // 追问两次还没结果就该停下（见 OrchestratorOptions.repeatedAsk 文档注释）——
  // 第三次起是稳定终态文案，不需要每轮都造一句新说法，第三轮和第四轮理应相同。
  assert.equal(new Set([first, second, third]).size, 3,
    "问 → 软化 → 换选择题，这三个阶段的话术应该不同");
  assert.equal(third, fourth, "追问两次已经停下换选择题，第三次不必再造一种新说法");
  assert.match(second, /点.*选项|下面.*选/, "第二次该指向可点选的选项");
  // 第三次起就别再念字段名了——客户已经在说话了，只是说法对不上关键词表
  for (const field of ["厨房尺寸", "布局", "风格", "预算", "所在省份"]) {
    assert.equal(third.includes(field), false, `第三轮不该再点名「${field}」：${third}`);
    assert.equal(fourth.includes(field), false, `第四轮不该再点名「${field}」：${fourth}`);
  }
});

test("布尔形式的 repeatedAsk 仍按「第二次」处理，旧调用方不会退化", async () => {
  const ctx = { conversationId: "cv", requirements: "", history: [] };
  const bool = await orchestratorReply(undefined, ctx, "想换厨房",
    { ...optionsFor("consumer"), repeatedAsk: true, language: "zh" });
  const num = await orchestratorReply(undefined, ctx, "想换厨房",
    { ...optionsFor("consumer"), repeatedAsk: 1, language: "zh" });
  assert.equal(bool.content, num.content);
});

test("贸易账号得到更直给的话术", async () => {
  const consumer = await orchestratorReply(undefined,
    { conversationId: "cv", requirements: "", history: [] }, "开始",
    { ...optionsFor("consumer"), language: "zh" });
  const trade = await orchestratorReply(undefined,
    { conversationId: "cv", requirements: "", history: [] }, "开始",
    { ...optionsFor("trade"), language: "zh" });
  assert.notEqual(consumer.content, trade.content);
  assert.match(trade.content, /一次给全/);
});

// ── 公司 Agent ────────────────────────────────────────────────────────────

test("公司 Agent 的 system prompt 只含本公司规格且允许报 MSRP 参考价", () => {
  const sys = buildCompanyAgentSystem("Maple Ridge", bundle);
  assert.match(sys, /B30/);
  assert.match(sys, /You may quote prices/i);
  assert.match(sys, /MSRP/);
  assert.match(sys, /do not invent|不要编/i);
});

test("明确 language=zh 时公司 Agent prompt 为中文", () => {
  const sys = buildCompanyAgentSystem("Maple Ridge", bundle, "zh");
  assert.match(sys, /可以报价/);
  assert.match(sys, /不要编，也不要提别家公司/);
});

test("无标准折扣时，模块参考价就是 MSRP 原价", () => {
  const b30 = bundle.modules.find((m) => m.code === "B30")!;
  const summary = priceSummaryForModule(bundle, b30);
  assert.ok(summary);
  assert.equal(summary!.minListPrice, fromDollars("245.50"));
  assert.equal(summary!.standardDiscountPercent, undefined);
  assert.match(formatModulePriceHint(summary!), /no standard discount/i);
});

test("有 autoQuotable 标准折扣时，参考价包含折后价", () => {
  const discounted: SpecBundle = {
    ...bundle,
    discountRules: [{
      id: "disc_std", specVersionId: "sv1", companyId: "co_1",
      audience: "consumer", kind: "percentOffList", value: 10, stackable: false,
      description: "Standard -10%", autoQuotable: true,
    }],
  };
  const b30 = discounted.modules.find((m) => m.code === "B30")!;
  const summary = priceSummaryForModule(discounted, b30);
  assert.equal(summary!.standardDiscountPercent, 10);
  // 245.50 的 10% 折后是 220.95 —— 必须是算出来的数字，不是随便一个非零值
  assert.equal(summary!.minDiscountedPrice, fromDollars("220.95"));
  assert.match(formatModulePriceHint(summary!), /standard 10% off/);
});

test("按价格组细分或非 percentOffList 的折扣，不进厂商 Agent 的口头参考价", () => {
  const scoped: SpecBundle = {
    ...bundle,
    discountRules: [{
      id: "disc_scoped", specVersionId: "sv1", companyId: "co_1",
      audience: "consumer", kind: "percentOffList", value: 10, stackable: false,
      description: "Only door style A", autoQuotable: true, appliesToPriceGroupIds: ["pg_a"],
    }],
  };
  assert.equal(standardAutoQuotableDiscount(scoped), undefined);

  const tiered: SpecBundle = {
    ...bundle,
    discountRules: [{
      id: "disc_tiered", specVersionId: "sv1", companyId: "co_1",
      audience: "consumer", kind: "tieredByOrderValue", stackable: false,
      description: "Volume discount", autoQuotable: true,
      tiers: [{ minSubtotal: fromDollars("1000"), percentOff: 5 }],
    }],
  };
  assert.equal(standardAutoQuotableDiscount(tiered), undefined);
});

test("公司 Agent system prompt 里每个 SKU 都带着算好的参考价，不是让模型自己算", () => {
  const sys = buildCompanyAgentSystem("Maple Ridge", bundle);
  assert.match(sys, /B30\([^)]*\)\s*·\s*MSRP/);
});

test("规格问答只答本公司有的型号", () => {
  const a = deterministicSpecAnswer("Maple Ridge", bundle, "B30 有多大");
  assert.match(a, /B30/);
  assert.match(a, /30"/);
});

test("规格库里没有的尺寸，明确说没有并给出可选值", () => {
  const a = deterministicSpecAnswer("Maple Ridge", bundle, "有 37 寸的柜子吗");
  assert.match(a, /no 37"|没有 37"/i);
  assert.match(a, /30|36/);
});

test("公司 Agent 回复带 companyId 归属", async () => {
  const r = await companyAgentReply(undefined, "Maple Ridge", bundle,
    { conversationId: "cv", requirements: "", history: [] }, "B30 有多大");
  assert.equal(r.companyId, "co_1");
});

test("handoff 注入进公司 Agent system；开线复述含门板", async () => {
  const handoff = buildHandoff({
    at: AT,
    designRequirements: "Kitchen L-shape chat dump should not appear in facts.",
    requirementsDigest: "Space: L-shape ~10x10. Style: Shaker White.",
    briefFacts: [
      { key: "brief_space", label: "Space & sizes", display: "L-shape ~10x10" },
      { key: "brief_intent", label: "Style", display: "Shaker White" },
    ],
    sharedPreferences: { storage: "balanced", tradeoff: "price", assembly: "RTA" },
    companyPreferences: { doorStyleId: "ds_shaker_white" },
    doorStyleNames: { ds_shaker_white: "Shaker White" },
    revision: 1,
  });
  assert.equal(handoff.companyPreferences?.doorStyleId, "ds_shaker_white");
  assert.ok(handoff.confirmedFacts?.some((f) => f.key === "doorStyleId"));
  assert.ok(!handoff.confirmedFacts?.some((f) => /chat dump/i.test(f.display)));
  assert.match(handoff.sharedSummary, /Shaker White|L-shape/i);
  assert.ok(!/chat dump/i.test(handoff.sharedSummary));

  const note = renderHandoffContextNote(handoff, "en");
  assert.match(note, /ds_shaker_white|Shaker White/);
  assert.match(note, /Do not re-ask/);
  assert.ok(!/chat dump/i.test(note));

  const fake: CompletionClient = {
    async complete({ system }) {
      assert.match(system, /Handoff revision 1/);
      assert.match(system, /Shaker White/);
      return "I see door style Shaker White (ds_shaker_white). Confirm?";
    },
  };
  const reply = await companyAgentReply(
    fake, "Maple Ridge", bundle,
    {
      conversationId: "cv",
      requirements: handoff.requirementsDigest ?? "",
      history: [],
      handoff,
    },
    "What door style did I confirm?",
  );
  assert.match(reply.content, /Shaker White|ds_shaker_white/);

  const restate = await companyAgentRestateHandoff(
    undefined, "Maple Ridge", bundle, handoff, "en", undefined, "open",
  );
  assert.match(restate.content, /Shaker White/);
  assert.equal(
    deterministicHandoffRestate("Maple Ridge", handoff, "en", "open").includes("Shaker White"),
    true,
  );
});

// ── 设计意图必须过价格过滤 ────────────────────────────────────────────────

test("Agent 产出的设计意图里，模型编的价格被丢弃", async () => {
  const fake: CompletionClient = {
    async complete() { return ""; },
    async completeJson<T>() {
      return {
        selections: [{
          moduleId: "m_b30", qty: 2, width: 30, height: 34.5, depth: 24, assembly: "RTA",
          hardwareOptionIds: [], accessoryOptionIds: [],
          // 模型编造的价格
          unitPrice: 9.99, listPrice: 1, total: 19.98, lineSubtotal: 19.98,
        }],
        doorStyleId: "ds_shaker_white",
        notes: "一版基础方案",
      } as T;
    },
  };
  const intent = await proposeDesign(fake, "Maple Ridge", bundle, "厨房 12 尺");
  assert.equal(intent.selections.length, 1);
  const keys = Object.keys(intent.selections[0]!);
  for (const bad of ["unitPrice", "listPrice", "total", "lineSubtotal"]) {
    assert.ok(!keys.includes(bad), `${bad} 不应出现在设计意图里`);
  }
  assert.equal(intent.doorStyleId, "ds_shaker_white");
});

test("模型给了不属于本公司的门板 id 时回落到合法值", async () => {
  const fake: CompletionClient = {
    async complete() { return ""; },
    async completeJson<T>() {
      return { selections: [], doorStyleId: "ds_someone_elses", notes: "" } as T;
    },
  };
  const intent = await proposeDesign(fake, "Maple Ridge", bundle, "需求");
  assert.equal(intent.doorStyleId, bundle.doorStyles[0]!.id);
});

// ── EstimateDraft ─────────────────────────────────────────────────────────

test("通用预估给区间不给精确数字", () => {
  const draft = buildEstimateDraft(genericCatalog, {
    conversationId: "cv_1", moduleCounts: { base: 5, wall: 4 }, at: AT,
  });
  assert.equal(draft.lineItems.length, 2);
  assert.ok(draft.totalRange.high > draft.totalRange.low);
  assert.equal(draft.basedOn, "genericCatalog");
});

test("EstimateDraft 结构上没有 companyId，不可能被发送", () => {
  const draft = buildEstimateDraft(genericCatalog, {
    conversationId: "cv_1", moduleCounts: { base: 3 }, at: AT,
  });
  assert.ok(!("companyId" in draft));
  assert.equal(isSendable(draft), false);
});

test("来源未核实时 disclaimer 必须如实说明", () => {
  const draft = buildEstimateDraft(genericCatalog, {
    conversationId: "cv_1", moduleCounts: { base: 3 }, at: AT,
  }, { sourceVerified: false, language: "zh" });
  assert.match(draft.disclaimer, /not a real quote from any specific company|不是任何具体公司的真实报价/i);
  assert.match(draft.disclaimer, /unverified placeholder|未经核实的占位数据/i);
});

test("来源已核实时不再显示占位警告", () => {
  const draft = buildEstimateDraft(genericCatalog, {
    conversationId: "cv_1", moduleCounts: { base: 3 }, at: AT,
  }, { sourceVerified: true, language: "zh" });
  assert.match(draft.disclaimer, /not a real quote from any specific company|不是任何具体公司的真实报价/i);
  assert.ok(!/unverified|未经核实/.test(draft.disclaimer));
});

test("给了省份则区间含税", () => {
  const untaxed = buildEstimateDraft(genericCatalog, {
    conversationId: "cv", moduleCounts: { base: 5 }, at: AT,
  });
  const taxed = buildEstimateDraft(genericCatalog, {
    conversationId: "cv", moduleCounts: { base: 5 }, province: "ON", at: AT,
  }, { taxRules: SEED_TAX_RULES, language: "zh" });
  assert.ok(taxed.totalRange.low > untaxed.totalRange.low);
  assert.match(taxed.disclaimer, /ON.*13%/);
});

test("目录里没有的柜类不臆造区间", () => {
  const sparse: GenericCatalog = { id: "gc", sourceNote: "test", modules: [] };
  const draft = buildEstimateDraft(sparse, {
    conversationId: "cv", moduleCounts: { base: 5 }, at: AT,
  });
  assert.equal(draft.lineItems.length, 0);
  assert.equal(draft.totalRange.low, 0);
});

test("纯文本呈现包含免责声明", () => {
  const draft = buildEstimateDraft(genericCatalog, {
    conversationId: "cv", moduleCounts: { base: 5, wall: 4 }, at: AT,
  });
  const text = renderEstimateText(draft, "zh");
  assert.match(text, /Generic estimate|通用预估/i);
  assert.match(text, /Range total|合计区间/i);
  assert.ok(text.includes(draft.disclaimer));
});

test("从需求文本粗估柜体数量", () => {
  const counts = estimateCountsFromText("厨房大概 14 尺长");
  assert.ok((counts.base ?? 0) > 0);
  assert.equal(counts.sinkBase, 1);
  assert.ok((counts.wall ?? 0) > 0);
});

// ── 邮件 CASL ─────────────────────────────────────────────────────────────

const sender: SenderIdentity = { name: "RTA-Hub", email: "hello@rta-hub.example", contact: "+1-416-555-0100" };

test("报价邮件包含发件人身份与一次性询价说明", () => {
  const email = buildQuoteEmail({
    companyName: "Maple Ridge", customerName: "Alex", customerEmail: "alex@example.com",
    province: "ON", quoteText: "B30 × 3 …", quoteId: "q_1",
  }, sender);
  assert.equal(email.kind, "lead");
  assert.match(email.text, /RTA-Hub/);
  assert.match(email.text, /not a marketing message|不是营销邮件/i);
  assert.doesNotThrow(() => assertCaslCompliant({ ...email, to: "x@y.com" }, sender));
});

test("招商邮件没有退订链接则被拒发", () => {
  const bad = { kind: "invite" as const, to: "a@b.com", subject: "s", text: "RTA-Hub 你好" };
  assert.throws(
    () => assertCaslCompliant(bad, sender),
    (e: unknown) => e instanceof CaslComplianceError && e.code === "MISSING_UNSUBSCRIBE",
  );
});

test("退订链接必须真的出现在正文里", () => {
  const bad = {
    kind: "mailing" as const, to: "a@b.com", subject: "s",
    text: "RTA-Hub 你好", unsubscribeUrl: "https://x.example/unsub?token=abc",
  };
  assert.throws(
    () => assertCaslCompliant(bad, sender),
    (e: unknown) => e instanceof CaslComplianceError && e.code === "UNSUBSCRIBE_NOT_IN_BODY",
  );
});

test("发件人身份不完整时拒发", () => {
  const email = buildInviteEmail({
    companyName: "X", deIdentifiedSignal: "近期有客户点名寻找贵司。",
    unsubscribeUrl: "https://x.example/unsub?token=abc",
  }, sender);
  assert.throws(
    () => assertCaslCompliant(email, { name: "", email: "", contact: "" }),
    (e: unknown) => e instanceof CaslComplianceError && e.code === "MISSING_IDENTITY",
  );
});

test("招商邮件的线索描述已去标识化，不含客户身份", () => {
  const signal = deIdentifySignal(3, "多伦多");
  const email = buildInviteEmail({
    companyName: "X", deIdentifiedSignal: signal,
    unsubscribeUrl: "https://x.example/unsub?token=abc",
  }, sender);
  assert.match(email.text, /3 customers|3 位客户/i);
  for (const pii of ["@example.com", "Alex", "电话", "地址："]) {
    assert.ok(!email.text.includes(pii), `邮件泄露了 ${pii}`);
  }
  assert.doesNotThrow(() => assertCaslCompliant(email, sender));
});

const subs: EmailSubscription[] = [
  {
    id: "s1", email: "active@x.example", companyName: "Active Co",
    consentDate: AT, consentChannel: "web_form", termsVersion: "2026-01",
    unsubscribeToken: "tok1", status: "active",
  },
  {
    id: "s2", email: "gone@x.example", companyName: "Gone Co",
    consentDate: AT, consentChannel: "web_form", termsVersion: "2026-01",
    unsubscribeToken: "tok2", status: "unsubscribed", unsubscribedAt: AT,
  },
];

test("营销邮件只能发给已订阅且未退订的地址", () => {
  assert.doesNotThrow(() => assertSubscribed("active@x.example", subs));
  assert.throws(
    () => assertSubscribed("gone@x.example", subs),
    (e: unknown) => e instanceof CaslComplianceError && e.code === "UNSUBSCRIBED",
  );
  assert.throws(
    () => assertSubscribed("never@x.example", subs),
    (e: unknown) => e instanceof CaslComplianceError && e.code === "NOT_SUBSCRIBED",
  );
});

test("未配置 SMTP 时 dry-run，不发起网络请求", async () => {
  const email = buildQuoteEmail({
    companyName: "X", customerName: "A", customerEmail: "a@b.com",
    province: "ON", quoteText: "…", quoteId: "q_1",
  }, sender);
  const r = await sendEmail({ ...email, to: "quotes@x.example" }, { smtp: null, sender });
  assert.equal(r.delivered, false);
  assert.equal(r.dryRun, true);
});

test("配置了传输器时正常发送并带 List-Unsubscribe 头", async () => {
  const sent: Record<string, unknown>[] = [];
  const email = buildInviteEmail({
    companyName: "X", deIdentifiedSignal: "近期有客户点名寻找贵司。",
    unsubscribeUrl: "https://x.example/unsub?token=abc",
  }, sender);
  const r = await sendEmail({ ...email, to: "active@x.example" }, {
    sender,
    transport: { async sendMail(msg) { sent.push(msg); return {}; } },
  });
  assert.equal(r.delivered, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!["headers"], { "List-Unsubscribe": "<https://x.example/unsub?token=abc>" });
});
