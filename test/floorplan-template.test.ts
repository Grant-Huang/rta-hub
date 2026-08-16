/**
 * 户型模板快选（FR-17.4）：选模板只建墙面**结构**（几段墙、罗盘方位、是否
 * 转角相接、有没有岛台）——这是客户点选形状这个动作本身就告诉我们的事实。
 *
 * 不预填任何数值（墙长、层高、门窗/上下水/燃气/强电的位置宽度）：客户只
 * 报了户型形状，从没报过任何尺寸，系统没有依据替他填一个"常见值"——哪怕
 * 这个值常见到写进了参考图的标注说明。选「其他」维持零墙段。
 *
 * 上传户型图走视觉识图（另见 `test/template-match.test.ts`），那条路径读的
 * 是客户真实上传的图，读到的值仍然要走待确认，但至少有真实依据，不受这份
 * 文件的改动影响。
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
    parsedGeometry: { wallRuns: { id: string; label: string; length: number; kind?: string; features: { id: string; kind: string }[] }[]; ceilingHeight?: number };
    unresolvedItems: { id: string; target: { kind: string; id?: string }; field: string; resolved: boolean }[];
  };
  ready: boolean;
  questions: { id: string; question: string }[];
  siteQuestions: { q: number; kind: string; prompt: string }[];
  designBrief: {
    confirmedFacts: { key: string; status: string; value: string }[];
    openItems: { id: string; status: string; brief: string; askHint?: string }[];
    readyToAskDesign: boolean;
  };
}

test("选 u-shaped-kitchen 模板 → 只建 3 段墙的结构，不预填任何长度/层高/门窗数字", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/floorplan-template`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ templateId: "u-shaped-kitchen" }),
  });
  assert.equal(r.status, 201, await r.clone().text());
  const body = await r.json() as TemplateResponse;

  const runs = body.floorPlan.parsedGeometry.wallRuns;
  assert.equal(runs.length, 3, "U 型三段墙的结构（客户点选形状本身告诉我们的事实）");
  assert.deepEqual(runs.map((w) => w.label), ["West", "North", "East"]);
  // 长度没有任何依据——客户只报了形状，没报过尺寸，一律留 0（跟"还没量"是
  // 同一种状态，不是"模板猜了一个数、等你确认"）。
  assert.deepEqual(runs.map((w) => w.length), [0, 0, 0],
    "墙长不能预填模板的常见值——客户压根没提供过这个数据");
  assert.equal(body.floorPlan.parsedGeometry.ceilingHeight, undefined,
    "层高同样没有依据，不能预填");

  // 不预填任何门/窗/上下水——客户没说过这些，不能因为"大多数厨房都有"
  // 就替他编一个位置/宽度出来。
  const allFeatures = runs.flatMap((w) => w.features);
  assert.equal(allFeatures.length, 0, "模板不该带来任何门窗/上下水特征");

  // 没有任何预填数字，也就不该有"确认这个模板猜测"的待确认项——墙长/
  // 层高本身就是"缺口"，走既有的缺口追问，不是"待确认"。
  const unresolved = body.floorPlan.unresolvedItems.filter((u) => !u.resolved);
  assert.equal(unresolved.length, 0,
    "没预填任何数字，就不该凭空生成待确认项");

  assert.equal(body.ready, false);

  // Q# 清单：墙长应该是"硬缺口"提问（wall_length），不是"确认模板猜测"
  // （wall_confirm）。
  const wallQs = body.siteQuestions.filter((q) => q.kind === "wall_length" || q.kind === "wall_confirm");
  assert.ok(wallQs.length > 0, "应该有墙长相关的提问");
  assert.ok(wallQs.every((q) => q.kind === "wall_length"),
    `墙长没有任何依据，必须是硬缺口提问（wall_length），不能是"确认"口吻（wall_confirm）：${JSON.stringify(wallQs)}`);

  // 已确认面板：墙长/层高都应该是"未定"（missing），不是"needs_confirm"——
  // needs_confirm 意味着"有一个值、等你点头"，但这里压根没有值。
  const wallFact = body.designBrief.confirmedFacts.find((f) => f.key === `wall:${runs[0]!.id}`);
  assert.ok(wallFact);
  assert.equal(wallFact!.status, "missing");
  assert.equal(wallFact!.value, "not set");
  const ceilingFact = body.designBrief.confirmedFacts.find((f) => f.key === "ceiling");
  assert.ok(ceilingFact);
  assert.equal(ceilingFact!.status, "missing");

  // readiness 检查表：上下水/窗一律是 missing（真缺口，需要客户主动提供），
  // 门洞在没有的时候压根不出现在 checklist 里（有才报）。
  const plumbingItem = body.designBrief.openItems.find((i) => i.id === "plumbing");
  const windowsItem = body.designBrief.openItems.find((i) => i.id === "windows");
  const doorsItem = body.designBrief.openItems.find((i) => i.id === "doors");
  assert.ok(plumbingItem);
  assert.equal(plumbingItem!.status, "missing");
  assert.ok(windowsItem);
  assert.equal(windowsItem!.status, "missing");
  assert.equal(doorsItem, undefined, "没有门洞数据时不该在 checklist 里凭空出现一条");
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

test("走廊型（galley）两段墙不相接的结构保留，但同样不预填长度", async () => {
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
  assert.deepEqual(runs.map((w) => w.length), [0, 0]);
});

test("L型+岛台模板：岛台结构（kind=island）保留，但岛台尺寸同样不预填", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/floorplan-template`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ templateId: "l-island-kitchen" }),
  });
  assert.equal(r.status, 201, await r.clone().text());
  const body = await r.json() as TemplateResponse;
  const runs = body.floorPlan.parsedGeometry.wallRuns;
  const island = runs.find((w) => w.kind === "island");
  assert.ok(island, "客户选了带岛台的模板——岛台这个结构性事实应该保留");
  assert.equal(island!.length, 0, "岛台具体尺寸没有依据，不能预填 72x36 这类常见值");
});

test("套用模板后墙长是硬缺口，按 Q# 报实测长度后正确写入几何", async () => {
  const id = await createConversation();
  const created = await req(`/api/conversations/${id}/floorplan-template`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ templateId: "one-wall-kitchen" }),
  });
  const createdBody = await created.json() as TemplateResponse;
  assert.equal(createdBody.floorPlan.parsedGeometry.wallRuns.length, 1);
  assert.equal(createdBody.floorPlan.parsedGeometry.wallRuns[0]!.length, 0);

  const wallQ = createdBody.siteQuestions.find((q) => q.kind === "wall_length");
  assert.ok(wallQ, `expected a wall_length question (hard gap), got kinds: ${createdBody.siteQuestions.map((q) => q.kind)}`);

  const chat = await req(`/api/conversations/${id}/messages`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ text: `Q${wallQ!.q}: 144"` }),
  });
  assert.equal(chat.status, 200, await chat.clone().text());

  const after = await req(`/api/floorplans/${createdBody.floorPlan.id}`, { accountId: CONSUMER });
  const afterBody = await after.json() as TemplateResponse;
  assert.equal(afterBody.floorPlan.parsedGeometry.wallRuns[0]!.length, 144,
    "客户实测报的长度应该正确写入几何");
});
