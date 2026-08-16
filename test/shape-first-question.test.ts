/**
 * 户型是开场第一问，纯文字回答（Phase 2）：客户直接打字点名已知户型
 * （"U型"/"L型+岛台"…），系统套用该户型的标准墙壳，并在同一句回复里
 * 解释墙名对应关系（主墙/左墙/右墙）。跟点按钮选模板走同一份底层逻辑
 * （`applyFloorplanTemplate`），只是入口从点击换成了打字——见
 * `test/floorplan-template.test.ts` 覆盖点击入口，这里覆盖打字入口。
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

async function createConversation(): Promise<string> {
  const r = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  assert.equal(r.status, 201);
  const body = await r.json() as { conversation: { id: string } };
  return body.conversation.id;
}

interface WallRun { id: string; label: string; length: number; kind?: string; features: { kind: string }[] }
interface MessagesResponse {
  replies: { content: string }[];
  floorPlanId?: string;
}
interface FloorPlanResponse {
  floorPlan: {
    parsedGeometry: { wallRuns: WallRun[]; ceilingHeight?: number };
    unresolvedItems: { resolved: boolean }[];
  };
}

test("客户打字说「U-shape」→ 套用 U 型模板，回复里讲解主墙/左墙/右墙", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "U-shape" }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json() as MessagesResponse;

  const text = body.replies.map((m) => m.content).join("\n");
  assert.match(text, /main wall/i);
  assert.match(text, /left wall/i);
  assert.match(text, /right wall/i);

  assert.ok(body.floorPlanId);
  const planRes = await req(`/api/floorplans/${body.floorPlanId}`, { accountId: CONSUMER });
  const planBody = await planRes.json() as FloorPlanResponse;
  const runs = planBody.floorPlan.parsedGeometry.wallRuns;
  assert.equal(runs.length, 3);
  // 只建墙面结构——客户只说了"U-shape"，从没报过任何尺寸，长度不能预填
  // 模板的常见值（144"/120"），必须留空等客户实测。
  assert.deepEqual(runs.map((w) => w.length), [0, 0, 0]);
});

test("客户打字说「galley kitchen」→ 套用走廊型模板（两段墙不相接）", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "It's a galley kitchen" }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json() as MessagesResponse;
  const planRes = await req(`/api/floorplans/${body.floorPlanId}`, { accountId: CONSUMER });
  const planBody = await planRes.json() as FloorPlanResponse;
  const runs = planBody.floorPlan.parsedGeometry.wallRuns;
  assert.equal(runs.length, 2);
  // 走廊型两段墙的长度同样没有依据，不能预填 144"。
  assert.deepEqual(runs.map((w) => w.length), [0, 0]);
});

test("「L-shape with an island」命中带岛台的模板，不是纯 L 型", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "L-shape with an island" }),
  });
  const body = await r.json() as MessagesResponse;
  const planRes = await req(`/api/floorplans/${body.floorPlanId}`, { accountId: CONSUMER });
  const planBody = await planRes.json() as FloorPlanResponse;
  const runs = planBody.floorPlan.parsedGeometry.wallRuns;
  // 客户选了带岛台的模板，说明"有岛台"这个结构性事实是客户确认过的——
  // 但岛台具体尺寸（72x36 这类常见值）没有依据，不能预填，必须留 0 等客户
  // 实测或后续在对话里报出来。
  const island = runs.find((w) => w.kind === "island");
  assert.ok(island, "should include an island wall run (structure), not a plain L-shape");
  assert.equal(island!.length, 0, "island size should not be pre-filled");
});

test("没提户型名、只报墙长——不套模板，走原有的手输建墙路径", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: 'North wall 144"' }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json() as MessagesResponse;
  const planRes = await req(`/api/floorplans/${body.floorPlanId}`, { accountId: CONSUMER });
  const planBody = await planRes.json() as FloorPlanResponse;
  const runs = planBody.floorPlan.parsedGeometry.wallRuns;
  // 手输路径只建了客户提到的这一段墙，不是模板的整套三段/两段
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.length, 144);
});

test("户型已经存在时，后面聊天里再提一句户型词不会重置几何", async () => {
  const id = await createConversation();
  const first = await req(`/api/conversations/${id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "U-shape" }),
  });
  const firstBody = await first.json() as MessagesResponse;
  const planId = firstBody.floorPlanId!;

  // 客户后面顺口提了句别的形状——不该把已经建好的 U 型几何冲掉
  await req(`/api/conversations/${id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "My friend has a galley kitchen, looks nice" }),
  });

  const planRes = await req(`/api/floorplans/${planId}`, { accountId: CONSUMER });
  const planBody = await planRes.json() as FloorPlanResponse;
  const runs = planBody.floorPlan.parsedGeometry.wallRuns;
  assert.equal(runs.length, 3, "还是 U 型的三段墙，没被后面那句话重置成走廊型");
});
