/**
 * FR-17 / FR-18：户型后抑制尺寸 quick replies；无默认厂商。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pruneTestSessions, testSessionDataDir } from "../src/session/runs.js";

process.env.SITE_PASSWORD_DISABLED = "true";

let app: { fetch: (req: Request) => Response | Promise<Response> };

before(async () => {
  const { runId, dataDir } = testSessionDataDir();
  const mod = await import("../src/server.js");
  app = await mod.createApp({
    dataDir,
    origin: "test",
    runId,
    llm: undefined,
  });
});

after(() => {
  pruneTestSessions({ keepLast: 5 });
});

const CONSUMER = "ca_demo_consumer";

function req(path: string, init: RequestInit & { accountId?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.accountId) headers.set("x-account-id", init.accountId);
  return app.fetch(new Request("http://test" + path, { ...init, headers }));
}

test("未 @ 时消息接口 questionCompanyId 为空（不默认第一家）", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const r = await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "Hi, I want new cabinets" }),
  });
  assert.equal(r.status, 200);
  const body = await r.json() as {
    questionCompanyId: string | null;
    designBrief: {
      openItems: { id: string; status: string; brief: string }[];
      sections: { id: string; body: string }[];
    };
  };
  assert.ok(body.questionCompanyId == null || body.questionCompanyId === "");
  const seller = body.designBrief?.openItems?.find((i) => i.id === "seller");
  assert.ok(seller);
  assert.equal(seller!.status, "missing");
  assert.match(seller!.brief, /No seller|尚未选定|@/i);
});

test("户型有有效墙长后 quickReplies 不含 kitchen size / layout", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };

  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const fpBody = await fpRes.json() as {
    floorPlan: { id: string };
    interpretation?: string;
  };
  assert.ok(fpBody.interpretation);

  await req(`/api/floorplans/${fpBody.floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ addRun: { label: "North", length: 144 } }),
  });
  await req(`/api/floorplans/${fpBody.floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ ceilingHeight: 96 }),
  });

  const msg = await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "Modern style, budget CAD $10-20k, Ontario ON" }),
  });
  const body = await msg.json() as {
    quickReplies: { field: string }[];
    geometryUsable?: boolean;
  };
  assert.equal(body.geometryUsable, true);
  assert.ok(!(body.quickReplies ?? []).some((q) => q.field === "kitchen size"));
  assert.ok(!(body.quickReplies ?? []).some((q) => q.field === "layout"));
});

/**
 * 关键现场/意图项齐备，足以问「要不要出图」（seller 非关键）。
 *
 * 墙长给 192"——144" 那面墙留了 60"/24" 的上下水后，NKBA 两侧落台净空一算，
 * 冰箱(38")+灶具(30") 实际放不下（这是家电落位算法本身的正确行为，不是
 * bug）。之前这个夹缝能凑过是因为 historyBlob 污染 bug 会把助手示例文案里的
 * "East 108"" 当成客户又报了一段墙，平白多出一段墙来兜底——修掉那个数据
 * 污染 bug 后，这里必须给一段真的装得下的墙长，不能再依赖那个副作用。
 */
async function seedDesignIntake(conversationId: string, floorPlanId: string) {
  const add = await req(`/api/floorplans/${floorPlanId}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ addRun: { label: "North", length: 204 } }),
  });
  const { floorPlan } = await add.json() as {
    floorPlan: { parsedGeometry: { wallRuns: { id: string }[] } };
  };
  const runId = floorPlan.parsedGeometry.wallRuns[0]!.id;
  await req(`/api/floorplans/${floorPlanId}/resolve`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ ceilingHeight: 96 }),
  });
  await req(`/api/floorplans/${floorPlanId}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      addFeature: { wallRunId: runId, kind: "plumbing", offset: 60, width: 24 },
    }),
  });
  await req(`/api/floorplans/${floorPlanId}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      appliances: [
        { kind: "refrigerator", width: 36 },
        { kind: "range", width: 30 },
        // 灶具几乎总要配抽油烟机，客户给了实测尺寸就不必再走"推定值待确认"
        { kind: "rangeHood", width: 30 },
        { kind: "dishwasher", width: 24 },
      ],
    }),
  });
  await req(`/api/conversations/${conversationId}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      text: "Modern style, budget CAD $10–20k, Ontario ON. No windows. "
        + "Fridge 36\", stove 30\", range hood 30\", dishwasher 24\".",
    }),
  });
}

test("FR-18：无 companyId 时可 consent + generic-plan-view（示意俯视）", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const { floorPlan } = await fpRes.json() as { floorPlan: { id: string } };
  await seedDesignIntake(conversation.id, floorPlan.id);

  const design = await (await req(
    `/api/conversations/${conversation.id}/design`,
    { accountId: CONSUMER },
  )).json() as {
    generic: boolean;
    companyId: string | null;
    session: { stage: string; companyId: string };
    prompt: { awaiting?: string };
  };
  assert.equal(design.generic, true);
  assert.equal(design.companyId, null);
  assert.equal(design.session.companyId, "__generic__");
  assert.equal(design.session.stage, "readyToDraw");
  assert.equal(design.prompt.awaiting, "drawingConsent");

  const consent = await req(`/api/conversations/${conversation.id}/design/advance`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ action: "consent" }),
  });
  assert.equal(consent.status, 200);
  const consentBody = await consent.json() as {
    generic: boolean;
    session: { stage: string };
  };
  assert.equal(consentBody.generic, true);
  assert.equal(consentBody.session.stage, "planReview");

  const pv = await req(`/api/floorplans/${floorPlan.id}/generic-plan-view`, {
    method: "POST", accountId: CONSUMER, body: "{}",
  });
  assert.equal(pv.status, 201);
  const pvBody = await pv.json() as {
    generic: boolean;
    planViews: { base?: string; wall?: string };
    viewsDisclaimer: string;
    estimate?: { basedOn?: string };
  };
  assert.equal(pvBody.generic, true);
  assert.ok(pvBody.planViews?.base?.includes("<svg"));
  assert.ok(pvBody.planViews?.wall?.includes("<svg"));
  assert.match(pvBody.viewsDisclaimer, /不对应任何|not any seller/i);
  assert.equal(pvBody.estimate?.basedOn, "genericCatalog");

  // 通用示意不能直接 approvePlan / revise
  const bad = await req(`/api/conversations/${conversation.id}/design/advance`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ action: "approvePlan" }),
  });
  assert.equal(bad.status, 409);
  const badBody = await bad.json() as { code?: string };
  assert.equal(badBody.code, "GENERIC_NEEDS_COMPANY");
});

test("FR-18：@ 厂商后走现有 plan-view（公司规格库）", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const { floorPlan } = await fpRes.json() as { floorPlan: { id: string } };
  await seedDesignIntake(conversation.id, floorPlan.id);

  // 先通用 consent
  await req(`/api/conversations/${conversation.id}/design/advance`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ action: "consent" }),
  });
  await req(`/api/floorplans/${floorPlan.id}/generic-plan-view`, {
    method: "POST", accountId: CONSUMER, body: "{}",
  });

  // @ 厂商后换真实 DesignSession + plan-view
  const withCo = await req(`/api/conversations/${conversation.id}/design?companyId=co_pilot`, {
    accountId: CONSUMER,
  });
  assert.equal(withCo.status, 200);
  const withBody = await withCo.json() as {
    generic?: boolean;
    session: { companyId: string; stage: string };
  };
  assert.equal(withBody.session.companyId, "co_pilot");
  // 换公司重开进程 → collecting → readyToDraw（资料仍齐）
  assert.equal(withBody.session.stage, "readyToDraw");

  await req(`/api/conversations/${conversation.id}/design/advance`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ companyId: "co_pilot", action: "consent" }),
  });
  const pv = await req(`/api/floorplans/${floorPlan.id}/plan-view`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ companyId: "co_pilot" }),
  });
  assert.equal(pv.status, 201);
  const pvBody = await pv.json() as { planViews: { base?: string }; generic?: boolean };
  assert.ok(pvBody.planViews?.base?.includes("<svg"));
  assert.ok(!pvBody.generic);
});

test("打开会话时 GET 带回已存设计图 deliverables（刷新可还原）", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const { floorPlan } = await fpRes.json() as { floorPlan: { id: string } };
  await seedDesignIntake(conversation.id, floorPlan.id);

  await req(`/api/conversations/${conversation.id}/design/advance`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ action: "consent" }),
  });
  const pv = await req(`/api/floorplans/${floorPlan.id}/generic-plan-view`, {
    method: "POST", accountId: CONSUMER, body: "{}",
  });
  assert.equal(pv.status, 201);

  const reopen = await req(`/api/conversations/${conversation.id}`, { accountId: CONSUMER });
  assert.equal(reopen.status, 200);
  const body = await reopen.json() as {
    floorPlanId: string | null;
    deliverables: {
      kind: string;
      restored: boolean;
      generic: boolean;
      planViews: { base?: string; wall?: string };
      designLayoutId: string;
    } | null;
  };
  assert.equal(body.floorPlanId, floorPlan.id);
  assert.ok(body.deliverables);
  assert.equal(body.deliverables!.restored, true);
  assert.equal(body.deliverables!.kind, "planView");
  assert.equal(body.deliverables!.generic, true);
  assert.ok(body.deliverables!.planViews.base?.includes("<svg"));
  assert.ok(body.deliverables!.planViews.wall?.includes("<svg"));
  assert.ok(body.deliverables!.designLayoutId);
});

test("聊天说 yes generate 时自动授权出图，不再返回 designPrompt", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const { floorPlan } = await fpRes.json() as { floorPlan: { id: string } };
  await seedDesignIntake(conversation.id, floorPlan.id);

  // 先进入 readyToDraw（资料齐）
  const design = await (await req(
    `/api/conversations/${conversation.id}/design`,
    { accountId: CONSUMER },
  )).json() as { session: { stage: string }; prompt: { awaiting?: string } };
  assert.equal(design.session.stage, "readyToDraw");
  assert.equal(design.prompt.awaiting, "drawingConsent");

  const msg = await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "yes please generate the design now" }),
  });
  assert.equal(msg.status, 200);
  const body = await msg.json() as {
    designConsentGranted?: boolean;
    designPrompt?: { awaiting?: string };
    designSession?: { stage: string };
    replies?: { content: string }[];
  };
  assert.equal(body.designConsentGranted, true);
  assert.equal(body.designPrompt, undefined);
  assert.equal(body.designSession?.stage, "planReview");
  assert.match(body.replies?.[0]?.content ?? "", /generating a layout|开始根据已确认/i);
});
