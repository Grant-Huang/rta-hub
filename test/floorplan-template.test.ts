/**
 * 户型模板快选（FR-17.4）：选模板预填几何，但预填不算确认；选「其他」维持零墙段。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.SMTP_HOST = "";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";
process.env.ADMIN_TOKEN = "test-admin-token";
process.env.SENDER_NAME = "RTA Hub";
process.env.SMTP_FROM = "quotes@rta-hub.test";
process.env.SENDER_PHONE = "+1-800-555-0100";

let app: { fetch: (req: Request) => Response | Promise<Response> };

before(async () => {
  const mod = await import("../src/server.js");
  app = await mod.createApp({ ephemeral: true, llm: undefined });
});

const CONSUMER = "ca_demo_consumer";
const base = "http://localhost";

function req(pathname: string, init: RequestInit & { accountId?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.accountId) headers.set("x-account-id", init.accountId);
  return app.fetch(new Request(base + pathname, { ...init, headers }));
}

async function createConversation(accountId = CONSUMER): Promise<string> {
  const r = await req("/api/conversations", { method: "POST", accountId });
  assert.equal(r.status, 201);
  const body = await r.json() as { conversation: { id: string } };
  return body.conversation.id;
}

interface TemplateResponse {
  floorPlan: {
    id: string;
    parsedGeometry: { wallRuns: { id: string; label: string; length: number; features: { id: string; kind: string }[] }[]; ceilingHeight?: number };
    unresolvedItems: { id: string; target: { kind: string; id?: string }; field: string; resolved: boolean }[];
  };
  ready: boolean;
  questions: { id: string; question: string }[];
  siteQuestions: { q: number; kind: string; prompt: string }[];
  designBrief: { confirmedFacts: { key: string; status: string }[] };
}

test("选 u-shaped-kitchen 模板 → 预填3段墙+门窗，全部待确认，未 ready", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/floorplan-template`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ templateId: "u-shaped-kitchen" }),
  });
  assert.equal(r.status, 201, await r.clone().text());
  const body = await r.json() as TemplateResponse;

  const runs = body.floorPlan.parsedGeometry.wallRuns;
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map((w) => w.length), [120, 144, 120]);
  assert.equal(body.floorPlan.parsedGeometry.ceilingHeight, 96);

  // 窗/门/上下水都落到了 features 上
  const allFeatures = runs.flatMap((w) => w.features);
  assert.ok(allFeatures.some((f) => f.kind === "window"));
  assert.ok(allFeatures.some((f) => f.kind === "door"));
  assert.ok(allFeatures.some((f) => f.kind === "plumbing"));

  // 预填不算确认：每段墙 + 每个特征 + 层高都留了一条待确认项（FR-15.5）
  const unresolved = body.floorPlan.unresolvedItems.filter((u) => !u.resolved);
  assert.equal(unresolved.filter((u) => u.target.kind === "wallRun").length, 3);
  assert.equal(unresolved.filter((u) => u.target.kind === "feature").length, allFeatures.length);
  assert.ok(unresolved.some((u) => u.field === "ceilingHeight"),
    "模板层高不能悄悄当成已确认——必须跟墙长/特征一样留一条待确认项");

  // 没有客户确认过任何东西，不该是 ready
  assert.equal(body.ready, false);

  // 层高要出现在 Q# 待确认清单里，不能因为没有待确认项而被 site-questions 静默跳过
  assert.ok(body.siteQuestions.some((q) => q.kind === "ceiling"),
    "模板层高必须像墙长/门窗一样被主动问一句「对不对」，不能悄悄默认已确认");

  // 已确认面板：层高必须是 needs_confirm（黄色/待确认），不能是 ok（绿色/已确认）——
  // 否则客户会被误导以为 AI 已经从对话里读到了这个层高
  const ceilingFact = body.designBrief.confirmedFacts.find((f) => f.key === "ceiling");
  assert.ok(ceilingFact);
  assert.equal(ceilingFact!.status, "needs_confirm");
});

test("选「其他」→ 维持零墙段，不套用任何模板", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/floorplan-template`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ templateId: "other" }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json() as TemplateResponse;
  assert.equal(body.floorPlan.parsedGeometry.wallRuns.length, 0);
  assert.equal(body.ready, false);
});

test("未知 templateId → 400", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/floorplan-template`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ templateId: "not-a-real-template" }),
  });
  assert.equal(r.status, 400);
});

test("走廊型（galley）两段墙不相接——按设计如实标注示意排列，不假装拼出真实过道", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/floorplan-template`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ templateId: "galley-kitchen" }),
  });
  assert.equal(r.status, 201, await r.clone().text());
  const body = await r.json() as TemplateResponse;
  const runs = body.floorPlan.parsedGeometry.wallRuns;
  assert.equal(runs.length, 2);
  // 第二段（South）显式声明不相接
  assert.deepEqual(runs.map((w) => w.length), [144, 144]);
});

test("按 Q# 确认模板预填的窗户后，对应待确认项被消解", async () => {
  const id = await createConversation();
  const created = await req(`/api/conversations/${id}/floorplan-template`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ templateId: "one-wall-kitchen" }),
  });
  const createdBody = await created.json() as TemplateResponse;
  const windowUnresolvedBefore = createdBody.floorPlan.unresolvedItems.filter(
    (u) => !u.resolved && u.target.kind === "feature",
  );
  assert.ok(windowUnresolvedBefore.length > 0);
  const windowQ = createdBody.siteQuestions.find((q) => q.kind === "window");
  assert.ok(windowQ, `expected a window confirm question, got kinds: ${createdBody.siteQuestions.map((q) => q.kind)}`);

  const chat = await req(`/api/conversations/${id}/messages`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ text: `Q${windowQ!.q}: 看着没问题，就按这个` }),
  });
  assert.equal(chat.status, 200, await chat.clone().text());

  const after = await req(`/api/floorplans/${createdBody.floorPlan.id}`, { accountId: CONSUMER });
  const afterBody = await after.json() as TemplateResponse;
  const stillPending = afterBody.floorPlan.unresolvedItems.filter(
    (u) => !u.resolved && u.target.kind === "feature",
  );
  assert.ok(stillPending.length < windowUnresolvedBefore.length,
    `expected the window confirm to resolve; before=${windowUnresolvedBefore.length} after=${stillPending.length}`);
});
