/**
 * 户型形状文字按钮（Phase 2 之后：不再用缩略图）——两处回归：
 *   1. 新会话打开时，欢迎语说"点下面的快捷选项"，按钮必须跟着一起出现，
 *      不能等客户发完第一条消息才有（之前 GET /conversations/:id 压根不带
 *      quickReplies）。
 *   2. 已经有户型（不管是照片上传来的还是之前选过形状）之后，客户点/打出
 *      布局 chip 上的原话（"L-shape"这种精确匹配）应该能换成另一个形状，
 *      不该被"已经有 planChat 就不认"的旧逻辑静默吃掉。同时，长句子里顺带
 *      提一句形状词（"我朋友家是U型的"）仍然不该触发重置。
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

async function json<T>(r: Response): Promise<T> {
  return r.json() as Promise<T>;
}

async function createConversation(accountId = CONSUMER): Promise<string> {
  const r = await req("/api/conversations", { method: "POST", accountId });
  assert.equal(r.status, 201);
  const body = await json<{ conversation: { id: string } }>(r);
  return body.conversation.id;
}

test("新会话打开：GET 响应带 layout quickReplies，跟欢迎语一起出现", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}`, { accountId: CONSUMER });
  assert.equal(r.status, 200);
  const body = await json<{
    welcome?: string;
    quickReplies?: { field: string; options: string[] }[];
  }>(r);
  assert.ok(body.welcome, "应该有开场欢迎语");
  assert.match(body.welcome!, /quick option|快捷选项/i, "欢迎语承诺了按钮");
  const layout = body.quickReplies?.find((q) => q.field === "layout");
  assert.ok(layout, "quickReplies 里应该有 layout 这一组——欢迎语说的按钮");
  assert.ok(layout!.options.includes("L-shape"));
});

test("已经发过消息的会话：GET 响应不再带 quickReplies（避免跟 /messages 的重复）", async () => {
  const id = await createConversation();
  await req(`/api/conversations/${id}/messages`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ text: "hi" }),
  });
  const r = await req(`/api/conversations/${id}`, { accountId: CONSUMER });
  const body = await json<{ quickReplies?: unknown[] }>(r);
  assert.ok(!body.quickReplies?.length, "有历史了就不该再重复给一次开场按钮");
});

test("上传户型图之后，点/打 L-shape chip 原文应该真的换形状，而不是静默无反应", async () => {
  const id = await createConversation();
  // 先上传一张照片（未配视觉模型，读不出墙段，但会建一个 FloorPlan 记录——
  // 关键是这一步之后 planChat 已经存在，模拟"先传图、后来想换成点选形状"）。
  const up = await req(`/api/conversations/${id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "kitchen.png", mimeType: "image/png", sizeBytes: 12345 }),
  });
  assert.equal(up.status, 201);
  const upBody = await json<{ floorPlan: { id: string; parsedGeometry: { wallRuns: unknown[] } } }>(up);
  assert.equal(upBody.floorPlan.parsedGeometry.wallRuns.length, 0, "本用例前提：上传没读出墙段");

  const r = await req(`/api/conversations/${id}/messages`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ text: "L-shape" }),
  });
  assert.equal(r.status, 200);
  const body = await json<{ floorPlanId?: string; replies?: { content: string }[] }>(r);
  assert.ok(body.floorPlanId, "应该已经有户型");
  assert.notEqual(body.floorPlanId, upBody.floorPlan.id, "应该换成了 L-shape 模板生成的新户型，不是原来那个空壳");

  const g = await req(`/api/floorplans/${body.floorPlanId}`, { accountId: CONSUMER });
  const gBody = await json<{ floorPlan: { parsedGeometry: { wallRuns: { length: number }[] } } }>(g);
  // L-shape 模板只带来墙面结构（几段墙、罗盘方位）——不预填任何长度数字，
  // 客户只报了形状，没报过尺寸，系统没依据替他填一个数（见 applyFloorplanTemplate
  // 顶部注释）。这里验证的是"点选形状真的生效了、不是静默无反应"，不是
  // "带来了预填数值"。
  assert.equal(gBody.floorPlan.parsedGeometry.wallRuns.length, 2,
    "L-shape 应该建出 2 段墙的结构（North/East）");
  assert.ok(
    gBody.floorPlan.parsedGeometry.wallRuns.every((w) => w.length === 0),
    "墙长没有任何依据，必须留空等客户实测，不能预填模板的常见值",
  );
});

test("已有户型时，长句子里顺带提一句形状词——不该被当成明确重选、静默重置几何", async () => {
  const id = await createConversation();
  await req(`/api/conversations/${id}/messages`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ text: "L-shape" }),
  });
  const before = await req(`/api/conversations/${id}`, { accountId: CONSUMER });
  const beforeBody = await json<{ floorPlanId?: string }>(before);
  const planIdBefore = beforeBody.floorPlanId;
  assert.ok(planIdBefore);

  await req(`/api/conversations/${id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "our neighbor's kitchen is a U-shape, quite nice" }),
  });
  const after = await req(`/api/conversations/${id}`, { accountId: CONSUMER });
  const afterBody = await json<{ floorPlanId?: string }>(after);
  assert.equal(afterBody.floorPlanId, planIdBefore, "长句子里顺带提到的形状词不该重置已有户型");
});
