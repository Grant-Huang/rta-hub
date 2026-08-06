/**
 * Agent 编排、EstimateDraft、邮件 CASL 校验。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromDollars } from "../src/domain/money.js";
import {
  buildCompanyAgentSystem, companyAgentReply, deterministicSpecAnswer,
  mergeRequirements, missingFields, optionsFor, orchestratorReply, proposeDesign,
} from "../src/agents/orchestrator.js";
import type { CompletionClient } from "../src/agents/types.js";
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
  assert.deepEqual(missingFields(""), ["厨房尺寸", "布局", "风格", "预算", "所在省份"]);
  const full = "厨房 12 尺，L 型布局，现代风格，预算 2 万加币，安大略省";
  assert.deepEqual(missingFields(full), []);
});

test("贸易账号得到更直给的话术", async () => {
  const consumer = await orchestratorReply(undefined,
    { conversationId: "cv", requirements: "", history: [] }, "开始", optionsFor("consumer"));
  const trade = await orchestratorReply(undefined,
    { conversationId: "cv", requirements: "", history: [] }, "开始", optionsFor("trade"));
  assert.notEqual(consumer.content, trade.content);
  assert.match(trade.content, /一次给全/);
});

// ── 公司 Agent ────────────────────────────────────────────────────────────

test("公司 Agent 的 system prompt 只含本公司规格且禁止报价", () => {
  const sys = buildCompanyAgentSystem("Maple Ridge", bundle);
  assert.match(sys, /B30/);
  assert.match(sys, /绝对不要报价格/);
  assert.match(sys, /不要编，也不要提别家公司/);
});

test("规格问答只答本公司有的型号", () => {
  const a = deterministicSpecAnswer("Maple Ridge", bundle, "B30 有多大");
  assert.match(a, /B30/);
  assert.match(a, /30"/);
});

test("规格库里没有的尺寸，明确说没有并给出可选值", () => {
  const a = deterministicSpecAnswer("Maple Ridge", bundle, "有 37 寸的柜子吗");
  assert.match(a, /没有 37"/);
  assert.match(a, /30|36/);
});

test("公司 Agent 回复带 companyId 归属", async () => {
  const r = await companyAgentReply(undefined, "Maple Ridge", bundle,
    { conversationId: "cv", requirements: "", history: [] }, "B30 有多大");
  assert.equal(r.companyId, "co_1");
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
  }, { sourceVerified: false });
  assert.match(draft.disclaimer, /不是任何具体公司的真实报价/);
  assert.match(draft.disclaimer, /未经核实的占位数据/);
});

test("来源已核实时不再显示占位警告", () => {
  const draft = buildEstimateDraft(genericCatalog, {
    conversationId: "cv_1", moduleCounts: { base: 3 }, at: AT,
  }, { sourceVerified: true });
  assert.match(draft.disclaimer, /不是任何具体公司的真实报价/);
  assert.ok(!draft.disclaimer.includes("未经核实"));
});

test("给了省份则区间含税", () => {
  const untaxed = buildEstimateDraft(genericCatalog, {
    conversationId: "cv", moduleCounts: { base: 5 }, at: AT,
  });
  const taxed = buildEstimateDraft(genericCatalog, {
    conversationId: "cv", moduleCounts: { base: 5 }, province: "ON", at: AT,
  }, { taxRules: SEED_TAX_RULES });
  assert.ok(taxed.totalRange.low > untaxed.totalRange.low);
  assert.match(taxed.disclaimer, /ON 13%/);
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
  const text = renderEstimateText(draft);
  assert.match(text, /通用预估/);
  assert.match(text, /合计区间/);
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
  assert.match(email.text, /不是营销邮件/);
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
  assert.match(email.text, /3 位客户/);
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
