/**
 * 必备信息门禁：风格/预算/省份在必备信息（户型/上下水/窗门/家电）收完前
 * 不得进入候选问题池。见 design/intake-checklist.ts 头部注释的设计取舍。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { requiredIntakeComplete, stripIntentFields } from "../src/design/intake-checklist.js";
import type { ReadinessItem } from "../src/design/readiness.js";
import {
  guardPrematureIntentQuestions, orchestratorReply,
} from "../src/agents/orchestrator.js";
import { interactionProfile } from "../src/trade/interaction.js";

process.env.SMTP_HOST = "";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";
process.env.ADMIN_TOKEN = "test-admin-token";

let app: { fetch: (req: Request) => Response | Promise<Response> };
const base = "http://localhost";
const CONSUMER = "ca_demo_consumer";

before(async () => {
  const mod = await import("../src/server.js");
  app = await mod.createApp({ ephemeral: true, llm: undefined });
});

function req(pathname: string, init: RequestInit & { accountId?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.accountId) headers.set("x-account-id", init.accountId);
  return app.fetch(new Request(base + pathname, { ...init, headers }));
}

async function json<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

interface QuickReply { field: string }
interface MessagesResponse {
  replies: { content: string }[];
  quickReplies: QuickReply[];
}

function item(partial: Partial<ReadinessItem> & Pick<ReadinessItem, "id" | "category" | "status">): ReadinessItem {
  return { critical: true, brief: "", ...partial };
}

test("requiredIntakeComplete：geometry/site/appliances 全 ok 才算完，intent 状态不影响它", () => {
  const complete: ReadinessItem[] = [
    item({ id: "walls_ceiling", category: "geometry", status: "ok" }),
    item({ id: "plumbing", category: "site", status: "deferred" }),
    item({ id: "appliances_sizes", category: "appliances", status: "assumed" }),
    item({ id: "style", category: "intent", status: "missing" }),
  ];
  assert.equal(requiredIntakeComplete(complete), true);

  const incomplete: ReadinessItem[] = [
    item({ id: "walls_ceiling", category: "geometry", status: "ok" }),
    item({ id: "plumbing", category: "site", status: "missing" }),
    item({ id: "style", category: "intent", status: "ok" }),
  ];
  assert.equal(requiredIntakeComplete(incomplete), false);
});

test("requiredIntakeComplete：非 critical 项缺失不挡门禁（比如窗户不是 critical）", () => {
  const items: ReadinessItem[] = [
    item({ id: "walls_ceiling", category: "geometry", status: "ok" }),
    item({ id: "windows", category: "site", status: "missing", critical: false }),
    item({ id: "appliances_sizes", category: "appliances", status: "ok" }),
  ];
  assert.equal(requiredIntakeComplete(items), true);
});

test("stripIntentFields：只摘 style/budget/province，别的字段原样保留", () => {
  assert.deepEqual(
    stripIntentFields(["kitchen size", "style", "layout", "budget", "province"]),
    ["kitchen size", "layout"],
  );
});

const profile = interactionProfile("consumer");

test("guardPrematureIntentQuestions：门禁关闭时把问风格/预算/省份的回复换回确定性追问", () => {
  const intakeStatus = {
    missing: ["kitchen size"] as string[],
    openAsks: ["Enter each wall length in inches."] as string[],
    floorPlanReady: false,
    readyToAskDesign: false,
    requiredIntakeComplete: false,
  };
  const guarded = guardPrematureIntentQuestions(
    "Thanks! By the way, what style do you prefer?",
    "roughly 12x8",
    profile,
    0,
    "en",
    intakeStatus,
  );
  assert.doesNotMatch(guarded, /what style/i);
  assert.match(guarded, /wall length/i);
});

test("guardPrematureIntentQuestions：门禁打开（或未传状态）时不拦截", () => {
  const content = "What style do you prefer?";
  const openGate = {
    missing: [] as string[],
    openAsks: ["What style do you prefer?"] as string[],
    floorPlanReady: true,
    readyToAskDesign: false,
    requiredIntakeComplete: true,
  };
  assert.equal(guardPrematureIntentQuestions(content, "", profile, 0, "en", openGate), content);
  // 未传 intakeStatus.requiredIntakeComplete（旧调用方/测试）视为不拦截，避免误伤。
  assert.equal(
    guardPrematureIntentQuestions(content, "", profile, 0, "en", { ...openGate, requiredIntakeComplete: undefined }),
    content,
  );
});

test("orchestratorReply 全链路：LLM 未经允许问起预算，被拦回确定性追问", async () => {
  const client = {
    async complete() {
      return "Got the wall length. What's your budget looking like?";
    },
  };
  const r = await orchestratorReply(
    client as never,
    { conversationId: "c1", requirements: "one wall 12ft", history: [] },
    "North wall 144\"",
    {
      profile,
      language: "en",
      intakeStatus: {
        missing: ["style"],
        openAsks: ["What is the ceiling height in inches?"],
        floorPlanReady: false,
        readyToAskDesign: false,
        requiredIntakeComplete: false,
      },
    },
  );
  assert.doesNotMatch(r.content, /budget/i);
  assert.match(r.content, /ceiling/i);
});

test("orchestratorReply 全链路：门禁打开后，LLM 问预算不受影响", async () => {
  const client = {
    async complete() {
      return "What's your budget looking like?";
    },
  };
  const r = await orchestratorReply(
    client as never,
    { conversationId: "c1", requirements: "one wall 12ft, appliances confirmed", history: [] },
    "sounds good",
    {
      profile,
      language: "en",
      intakeStatus: {
        missing: ["style", "budget"],
        openAsks: ["What's your budget looking like?"],
        floorPlanReady: true,
        readyToAskDesign: false,
        requiredIntakeComplete: true,
      },
    },
  );
  assert.match(r.content, /budget/i);
});

test("端到端：必备信息收完之前，快捷回答/回复里都不出现风格/预算/省份；收完之后才出现", async () => {
  const created = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await json<{ conversation: { id: string } }>(created);
  const convId = conversation.id;

  const noIntentFields = (body: MessagesResponse) => {
    const fields = body.quickReplies.map((q) => q.field);
    assert.ok(!fields.includes("style"), `quickReplies 不该有 style，实际：${fields.join(",")}`);
    assert.ok(!fields.includes("budget"), `quickReplies 不该有 budget，实际：${fields.join(",")}`);
    assert.ok(!fields.includes("province"), `quickReplies 不该有 province，实际：${fields.join(",")}`);
    const text = body.replies.map((r) => r.content).join("\n");
    assert.doesNotMatch(text, /budget|预算/i, "回复文案不该主动问预算");
  };

  // 1) 只报了墙长层高，上下水/家电都还没谈——门禁应保持关闭
  const r1 = await req(`/api/conversations/${convId}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: 'North wall 144", ceiling 96"' }),
  });
  noIntentFields(await json<MessagesResponse>(r1));

  // 2) 上下水明确推迟——仍缺家电，门禁仍应关闭
  const r2 = await req(`/api/conversations/${convId}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "plumbing later" }),
  });
  noIntentFields(await json<MessagesResponse>(r2));

  // 3) 补齐家电种类+实测宽度（合计 117"，装得进 144" 的墙）——必备信息应该收完了。
  // 灶具要连带明确给出烟机宽度（而不是让系统自动推定一台）：家电尺寸检查表要求
  // "没有待确认的推定值"才算 ok，推定烟机会让它卡在 needs_confirm（见 #39）。
  const r3 = await req(`/api/conversations/${convId}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: 'fridge 33", range 30", range hood 30", dishwasher 24"' }),
  });
  noIntentFields(await json<MessagesResponse>(r3));

  // 4) 燃气/强电/岛台也答完——必备信息才真正收完，风格/预算/省份才该出现。
  const r4 = await req(`/api/conversations/${convId}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "No gas, electric range. North wall electrical. No island." }),
  });
  const body4 = await json<MessagesResponse>(r4);

  const fields3 = body4.quickReplies.map((q) => q.field);
  assert.ok(
    fields3.includes("style") || fields3.includes("budget") || fields3.includes("province"),
    `必备信息收完后，应该开始出现风格/预算/省份候选，实际 quickReplies field：${fields3.join(",")}`,
  );
});
