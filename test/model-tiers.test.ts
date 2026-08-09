/**
 * LLM 模型分层 —— 轻量 / 主力 / 视觉。
 *
 * 两条最要紧的断言：
 *   1. **视觉层不回退到文本模型** —— 文本模型看不了图，回退过去只会得到瞎猜的尺寸；
 *   2. **升级判断有确定性兜底** —— 不能全靠轻量模型自己举手说要升级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CALL_SITE_TIER, escalationDecision, modelFor, NO_PROGRESS_TURNS, resolveModelTiers,
  resolveTestModelTiers, tierForTurn, tierReport, type CallSite,
} from "../src/agents/model-tiers.js";

const env = (o: Record<string, string> = {}): NodeJS.ProcessEnv => o;

// ── 调用点的层级分配 ──────────────────────────────────────────────────────

test("按「错了的代价」分层，不是按「看起来难不难」", () => {
  // 答错一句常识，客户再问一遍就好
  assert.equal(CALL_SITE_TIER.orchestratorChat, "chat");
  assert.equal(CALL_SITE_TIER.companySpecQa, "chat");
  // 理解错修改要求 / 解析错价目表 → 错的方案、错的报价
  assert.equal(CALL_SITE_TIER.designIntent, "reasoning");
  assert.equal(CALL_SITE_TIER.layoutRevision, "reasoning");
  assert.equal(CALL_SITE_TIER.specTemplateParse, "reasoning");
  // 户型图是图，文本模型无从下手
  assert.equal(CALL_SITE_TIER.floorPlanExtract, "vision");
  assert.equal(CALL_SITE_TIER.designCritique, "reasoning");
});

// ── 配置与回退 ────────────────────────────────────────────────────────────

test("三层各自配置时按各自的来", () => {
  const cfg = resolveModelTiers(env({
    LLM_MODEL_CHAT: "small-1", LLM_MODEL_REASONING: "big-1", LLM_MODEL_VISION: "eye-1",
  }));
  assert.equal(modelFor(cfg, "orchestratorChat"), "small-1");
  assert.equal(modelFor(cfg, "designIntent"), "big-1");
  assert.equal(modelFor(cfg, "floorPlanExtract"), "eye-1");
  assert.equal(cfg.anyConfigured, true);
});

test("轻量层没配 → 回退到主力（只是贵，不会错）", () => {
  const cfg = resolveModelTiers(env({ LLM_MODEL_REASONING: "big-1" }));
  assert.equal(modelFor(cfg, "orchestratorChat"), "big-1");
  assert.equal(cfg.chat.fellBackTo, "reasoning");
});

test("主力层没配 → 回退到轻量，但这是有风险的降级，必须能被看见", () => {
  const cfg = resolveModelTiers(env({ LLM_MODEL_CHAT: "small-1" }));
  assert.equal(modelFor(cfg, "designIntent"), "small-1");
  assert.equal(cfg.reasoning.fellBackTo, "chat");
  assert.ok(tierReport(cfg).some((l) => l.includes("准确度会下降")),
    "主力层降级必须在启动日志里明说");
});

test("视觉层**不回退** —— 文本模型看不了图", () => {
  const cfg = resolveModelTiers(env({ LLM_MODEL_CHAT: "small-1", LLM_MODEL_REASONING: "big-1" }));
  assert.equal(modelFor(cfg, "floorPlanExtract"), undefined,
    "没有多模态模型就是没有，装作有会读出一堆瞎猜的尺寸");
  assert.ok(tierReport(cfg).some((l) => l.includes("降级为手动")),
    "要说清后果：户型录入变成手动");
});

test("单模型部署仍然能跑（向后兼容 OPENAI_MODEL）", () => {
  const cfg = resolveModelTiers(env({ OPENAI_MODEL: "only-1" }));
  assert.equal(modelFor(cfg, "orchestratorChat"), "only-1");
  assert.equal(modelFor(cfg, "designIntent"), "only-1");
  // 视觉仍然不蒙混过关
  assert.equal(modelFor(cfg, "floorPlanExtract"), undefined);
});

test("测试分层读 LLM_MODEL_TEST_*，不回落生产 LLM_MODEL_* / OPENAI_MODEL", () => {
  const cfg = resolveTestModelTiers(env({
    LLM_MODEL_CHAT: "prod-chat",
    LLM_MODEL_REASONING: "prod-reason",
    LLM_MODEL_VISION: "prod-vision",
    OPENAI_MODEL: "prod-only",
    LLM_MODEL_TEST_CHAT: "qwen2.5:14b-instruct",
    LLM_MODEL_TEST_REASONING: "qwen2.5:14b-instruct",
    LLM_MODEL_TEST_VISION: "qwen2.5vl:latest",
  }));
  assert.equal(modelFor(cfg, "orchestratorChat"), "qwen2.5:14b-instruct");
  assert.equal(modelFor(cfg, "designIntent"), "qwen2.5:14b-instruct");
  assert.equal(modelFor(cfg, "floorPlanExtract"), "qwen2.5vl:latest");
});

test("未配 TEST 模型时测试分层为空（即使生产已配）", () => {
  const cfg = resolveTestModelTiers(env({
    LLM_MODEL_CHAT: "prod-chat", OPENAI_MODEL: "prod-only",
  }));
  assert.equal(cfg.anyConfigured, false);
  assert.equal(modelFor(cfg, "orchestratorChat"), undefined);
});

test("一个都没配 → 对话降级为确定性问答，核心链路不受影响", () => {
  const cfg = resolveModelTiers(env());
  assert.equal(cfg.anyConfigured, false);
  for (const site of Object.keys(CALL_SITE_TIER) as CallSite[]) {
    assert.equal(modelFor(cfg, site), undefined);
  }
  const report = tierReport(cfg).join("\n");
  assert.match(report, /确定性问答/);
  assert.match(report, /报价\/闸门\/计费不受影响/);
});

test("空白配置等同未配置", () => {
  const cfg = resolveModelTiers(env({ LLM_MODEL_CHAT: "   " }));
  assert.equal(cfg.anyConfigured, false);
});

// ── 升级判断 ──────────────────────────────────────────────────────────────

const base = { userText: "", turnsWithoutProgress: 0 };

test("日常闲聊不升级 —— 这是分层存在的理由", () => {
  for (const t of ["厨房大概 12 尺", "喜欢现代风格", "shaker 是什么意思？", "多伦多"]) {
    const d = escalationDecision({ ...base, userText: t });
    assert.equal(d.escalate, false, `「${t}」不该升级`);
  }
  assert.equal(tierForTurn({ escalate: false }), "chat");
});

test("要出方案/报价 → 确定性升级", () => {
  for (const t of ["帮我出一版方案", "可以报个价吗", "帮我设计一下", "做个方案看看"]) {
    const d = escalationDecision({ ...base, userText: t });
    assert.equal(d.escalate, true, `「${t}」应该升级`);
    assert.equal(d.reason, "designRequest");
  }
  assert.equal(tierForTurn({ escalate: true }), "reasoning");
});

test("多约束修改 → 升级（轻量模型容易顾此失彼）", () => {
  const d = escalationDecision({
    ...base, userText: "把水槽挪到窗下，但是洗碗机别动",
  });
  assert.equal(d.escalate, true);
  assert.equal(d.reason, "multiConstraintEdit");
  assert.match(d.detail!, /水槽/);

  // 单约束不升级
  assert.equal(escalationDecision({ ...base, userText: "水槽往左挪一点" }).escalate, false);
  // 提了多个部位但没有转折，属于陈述，不算复杂修改
  assert.equal(
    escalationDecision({ ...base, userText: "水槽和灶台都在这面墙" }).escalate, false);
});

test("户型刚解析完、规格导入 → 确定性升级", () => {
  assert.equal(
    escalationDecision({ ...base, userText: "嗯", justParsedFloorPlan: true }).reason,
    "floorPlanReview");
  assert.equal(
    escalationDecision({ ...base, userText: "嗯", importingSpec: true }).reason,
    "specImport");
});

test("确定性条件优先于模型自述 —— 模型判断力不足时最需要升级", () => {
  // 模型说不用升级，但客户明确要方案 → 仍然升级
  const d = escalationDecision({
    ...base, userText: "帮我出一版方案", modelRequestedEscalation: false,
  });
  assert.equal(d.escalate, true);
  assert.equal(d.reason, "designRequest", "确定性理由要排在模型信号之前");
});

test("模型举手也认，但只是辅助信号", () => {
  const d = escalationDecision({ ...base, userText: "唔", modelRequestedEscalation: true });
  assert.equal(d.escalate, true);
  assert.equal(d.reason, "modelRequested");
});

test("兜底：连续没进展就强制升级，不让轻量模型原地打转", () => {
  assert.equal(
    escalationDecision({ ...base, userText: "嗯", turnsWithoutProgress: NO_PROGRESS_TURNS - 1 }).escalate,
    false);
  const d = escalationDecision({ ...base, userText: "嗯", turnsWithoutProgress: NO_PROGRESS_TURNS });
  assert.equal(d.escalate, true);
  assert.equal(d.reason, "noProgress");
  assert.match(d.detail!, new RegExp(`${NO_PROGRESS_TURNS} 轮`));
});

test("每条升级都带原因，便于事后核对成本与效果", () => {
  const cases = [
    { ...base, userText: "帮我出方案" },
    { ...base, userText: "水槽挪到窗下但洗碗机保留" },
    { ...base, userText: "嗯", importingSpec: true },
    { ...base, userText: "嗯", turnsWithoutProgress: 5 },
  ];
  for (const c of cases) {
    const d = escalationDecision(c);
    assert.equal(d.escalate, true);
    assert.ok(d.reason, "升级必须有 reason");
    assert.ok(d.detail && d.detail.length > 5, "升级必须说清为什么");
  }
});
