/**
 * Phase 4 后端部分：
 * 1. `/resolve` 新增 editFeature——改一个已存在特征（窗/门/上下水）的位置/宽度，
 *    而不是像 addFeature 那样再加一个。
 * 2. `ConfirmedFact.editTarget`——已确认面板据此知道"这一行该传什么去 /resolve"，
 *    不用自己解析 key 字符串猜。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

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

interface FloorPlanFeature { id: string; kind: string; offset: number; width: number }
interface FloorPlanRun { id: string; label: string; length: number; features: FloorPlanFeature[] }
interface FloorPlanBody { id: string; parsedGeometry: { wallRuns: FloorPlanRun[] } }
interface ConfirmedFact { key: string; label: string; status: string; editTarget?: Record<string, unknown> }

async function seedPlanWithWindow(): Promise<{ floorPlanId: string; wallRunId: string; featureId: string }> {
  const created = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await created.json() as { conversation: { id: string } };
  const msg = await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: 'North wall 168", ceiling 96"' }),
  });
  const msgBody = await msg.json() as { floorPlanId: string };
  const floorPlanId = msgBody.floorPlanId;

  const plan1 = await req(`/api/floorplans/${floorPlanId}`, { accountId: CONSUMER });
  const plan1Body = await plan1.json() as { floorPlan: FloorPlanBody };
  const wallRunId = plan1Body.floorPlan.parsedGeometry.wallRuns[0]!.id;

  const withFeature = await req(`/api/floorplans/${floorPlanId}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ addFeature: { wallRunId, kind: "window", offset: 24, width: 36 } }),
  });
  const withFeatureBody = await withFeature.json() as { floorPlan: FloorPlanBody };
  const featureId = withFeatureBody.floorPlan.parsedGeometry.wallRuns[0]!.features[0]!.id;
  return { floorPlanId, wallRunId, featureId };
}

test("editFeature 改窗的位置/宽度，不是新加一个", async () => {
  const { floorPlanId, wallRunId, featureId } = await seedPlanWithWindow();

  const r = await req(`/api/floorplans/${floorPlanId}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ editFeature: { wallRunId, featureId, offset: 60, width: 40 } }),
  });
  assert.equal(r.status, 200);
  const body = await r.json() as { floorPlan: FloorPlanBody };
  const run = body.floorPlan.parsedGeometry.wallRuns.find((w) => w.id === wallRunId)!;
  assert.equal(run.features.length, 1, "应该是改了原来那一条，不是加了一条新的");
  assert.equal(run.features[0]!.id, featureId, "特征 id 应该保持不变");
  assert.equal(run.features[0]!.offset, 60);
  assert.equal(run.features[0]!.width, 40);
});

test("editFeature 只改 offset 时，width 保持原值不变", async () => {
  const { floorPlanId, wallRunId, featureId } = await seedPlanWithWindow();
  const r = await req(`/api/floorplans/${floorPlanId}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ editFeature: { wallRunId, featureId, offset: 10 } }),
  });
  const body = await r.json() as { floorPlan: FloorPlanBody };
  const run = body.floorPlan.parsedGeometry.wallRuns.find((w) => w.id === wallRunId)!;
  assert.equal(run.features[0]!.offset, 10);
  assert.equal(run.features[0]!.width, 36, "没传 width 就不该被改掉");
});

test("editFeature 改到超出墙长范围时被拒绝，原值不变", async () => {
  const { floorPlanId, wallRunId, featureId } = await seedPlanWithWindow();
  const r = await req(`/api/floorplans/${floorPlanId}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ editFeature: { wallRunId, featureId, offset: 160, width: 36 } }), // 160+36 > 168
  });
  assert.equal(r.status, 400);
  const plan = await req(`/api/floorplans/${floorPlanId}`, { accountId: CONSUMER });
  const planBody = await plan.json() as { floorPlan: FloorPlanBody };
  const run = planBody.floorPlan.parsedGeometry.wallRuns.find((w) => w.id === wallRunId)!;
  assert.equal(run.features[0]!.offset, 24, "拒绝时原值不该被改动");
});

test("editFeature 找不到对应特征时报错，不静默创建", async () => {
  const { floorPlanId, wallRunId } = await seedPlanWithWindow();
  const r = await req(`/api/floorplans/${floorPlanId}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ editFeature: { wallRunId, featureId: "wf_not_real", offset: 10 } }),
  });
  assert.equal(r.status, 400);
});

test("已确认面板的每一条事实都带 editTarget，前端不用解析 key 猜目标", async () => {
  const created = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await created.json() as { conversation: { id: string } };
  const msg = await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: 'North wall 168", ceiling 96", fridge 33"' }),
  });
  const body = await msg.json() as { designBrief?: { confirmedFacts: ConfirmedFact[] } };
  const facts = body.designBrief?.confirmedFacts ?? [];

  const wallFact = facts.find((f) => f.key.startsWith("wall:"));
  assert.ok(wallFact?.editTarget, "墙长事实应该带 editTarget");
  assert.equal((wallFact!.editTarget as { kind: string }).kind, "wall");

  const ceilingFact = facts.find((f) => f.key === "ceiling");
  assert.ok(ceilingFact?.editTarget);
  assert.equal((ceilingFact!.editTarget as { kind: string }).kind, "ceiling");

  const applianceFact = facts.find((f) => f.key.startsWith("appliance:"));
  assert.ok(applianceFact?.editTarget);
  assert.equal((applianceFact!.editTarget as { kind: string }).kind, "appliance");
});
