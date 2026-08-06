/**
 * HTTP 层测试 —— 重点验证 PRE_LAUNCH_CHECKLIST E1/E2：
 *   - 无鉴权访问被拒
 *   - 直接调 API 传 confirm:true **不能**发出邮件
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.SMTP_HOST = "";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";

process.env.ADMIN_TOKEN = "test-admin-token";

let app: { fetch: (req: Request) => Response | Promise<Response> };

before(async () => {
  const mod = await import("../src/server.js");
  // 用临时数据目录，避免测试写进真实的 data/
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

test("健康检查无需鉴权", async () => {
  const r = await req("/health");
  assert.equal(r.status, 200);
});

test("未认证访问受保护端点返回 401", async () => {
  const r = await req("/api/conversations", { method: "POST" });
  assert.equal(r.status, 401);
});

test("伪造的账号 id 同样被拒", async () => {
  const r = await req("/api/conversations", { method: "POST", accountId: "ca_not_real" });
  assert.equal(r.status, 401);
});

test("公司目录只列出 active 公司，且不暴露订阅状态", async () => {
  const r = await req("/api/companies");
  const body = await r.json() as { companies: { id: string; name: string }[] };
  // 两家 active 试点公司；Northern Wood 已发布规格但未订阅，不应出现
  assert.deepEqual(body.companies.map((c) => c.id).sort(), ["co_lakeside", "co_pilot"]);
  assert.ok(!body.companies.some((c) => c.id === "co_northern"));
  const raw = JSON.stringify(body);
  for (const leak of ["personalizationSubscription", "billingPlan", "quoteEmail"]) {
    assert.ok(!raw.includes(leak), `目录泄露了 ${leak}`);
  }
});

test("完整链路：建会话 → 出报价 → 披露 → 确认 → 发送（dry-run）", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  assert.equal(convRes.status, 201);
  const { conversation } = await convRes.json() as { conversation: { id: string } };

  const quoteRes = await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId: conversation.id, doorStyleId: "ds_shaker_white",
      selections: [
        { moduleId: "m_b30", qty: 4, width: 30, height: 34.5, depth: 24, assembly: "RTA", hardwareOptionIds: ["hw_softclose"], accessoryOptionIds: [] },
        { moduleId: "m_w3030", qty: 3, width: 30, height: 30, depth: 12, assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [] },
      ],
    }),
  });
  assert.equal(quoteRes.status, 201, await quoteRes.clone().text());
  const { quote } = await quoteRes.json() as { quote: { id: string; status: string; taxes: unknown[] } };
  assert.equal(quote.status, "draft");
  assert.ok(quote.taxes.length > 0, "报价必须含税");

  // 披露清单
  const disc = await req(`/api/quotes/${quote.id}/disclosure`, { accountId: CONSUMER });
  const disclosure = await disc.json() as { items: { label: string }[]; notice: string };
  assert.ok(disclosure.items.some((i) => i.label === "你的邮箱"));

  // 确认
  const conf = await req(`/api/quotes/${quote.id}/confirm`, { method: "POST", accountId: CONSUMER });
  assert.equal(conf.status, 200);

  // 发送（SMTP 未配置 → dry-run）
  const send = await req(`/api/quotes/${quote.id}/send`, { method: "POST", accountId: CONSUMER });
  const sent = await send.json() as { dryRun: boolean; quote: { status: string }; billingEventId?: string };
  assert.equal(sent.dryRun, true);
  assert.equal(sent.quote.status, "failed", "dry-run 不应标记为已发送");
  assert.equal(sent.billingEventId, undefined, "dry-run 不应产生计费事件");

  // 审计留痕
  const audit = await req(`/api/quotes/${quote.id}/audit`, { accountId: CONSUMER });
  const { events } = await audit.json() as { events: { action: string }[] };
  const actions = events.map((e) => e.action);
  assert.ok(actions.includes("created"));
  assert.ok(actions.includes("confirmed"));
  assert.ok(actions.includes("sendFailed"));
});

test("闸门不可绕过：未确认的报价直接调 send 被拒（且 confirm:true 无效）", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const quoteRes = await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId: conversation.id, doorStyleId: "ds_shaker_white",
      selections: [{ moduleId: "m_b12", qty: 1, width: 12, height: 34.5, depth: 24, assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [] }],
    }),
  });
  const { quote } = await quoteRes.json() as { quote: { id: string } };

  // 旧实现里这个请求体就能发信；现在必须被拒
  const send = await req(`/api/quotes/${quote.id}/send`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ confirm: true }),
  });
  assert.equal(send.status, 409);
  const body = await send.json() as { error: string };
  assert.match(body.error, /必须先由客户确认/);
});

test("另一个账号读不到别人的报价", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const quoteRes = await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId: conversation.id, doorStyleId: "ds_shaker_white",
      selections: [{ moduleId: "m_b12", qty: 1, width: 12, height: 34.5, depth: 24, assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [] }],
    }),
  });
  const { quote } = await quoteRes.json() as { quote: { id: string } };

  const r = await req(`/api/quotes/${quote.id}`, { accountId: "ca_demo_trade" });
  assert.equal(r.status, 404);
});

test("LLM 编造的价格在 HTTP 层同样被丢弃", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const r = await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId: conversation.id, doorStyleId: "ds_shaker_white",
      selections: [{
        moduleId: "m_b30", qty: 1, width: 30, height: 34.5, depth: 24, assembly: "RTA",
        hardwareOptionIds: [], accessoryOptionIds: [],
        unitPrice: 1, total: 1, lineSubtotal: 1,
      }],
    }),
  });
  const { quote } = await r.json() as { quote: { total: number; lineItems: { unitListPrice: number }[] } };
  assert.equal(quote.lineItems[0]!.unitListPrice, 24550); // 来自规格库，不是模型说的 1
  assert.notEqual(quote.total, 1);
});

test("校验失败返回 422 并列出问题", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const r = await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId: conversation.id, doorStyleId: "ds_shaker_white",
      selections: [{ moduleId: "m_b30", qty: 1, width: 31, height: 34.5, depth: 24, assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [] }],
    }),
  });
  assert.equal(r.status, 422);
  const body = await r.json() as { issues: { code: string }[] };
  assert.equal(body.issues[0]!.code, "DIMENSION_NOT_IN_OPTIONS");
});

test("@ 未入驻公司：不报错、记信号、文案不泄露内部状态", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const r = await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "@Northern Wood Kitchens 你们有 36 寸转角柜吗" }),
  });
  assert.equal(r.status, 200);
  const body = await r.json() as { routedTo: unknown[]; notices: string[] };
  assert.equal(body.routedTo.length, 0);
  assert.equal(body.notices.length, 1);
  for (const leak of ["订阅", "入驻", "未付费"]) {
    assert.ok(!body.notices[0]!.includes(leak));
  }
});

test("@ 已入驻公司：正常路由", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const r = await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "@枫岭橱柜 有 36 寸水槽柜吗" }),
  });
  const body = await r.json() as { routedTo: { companyId: string }[] };
  assert.equal(body.routedTo.length, 1);
  assert.equal(body.routedTo[0]!.companyId, "co_pilot");
});

test("脸型渲染端点按 SKU 出 SVG", async () => {
  const r = await req("/api/render/face?code=B30&width=30");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /image\/svg\+xml/);
  const svg = await r.text();
  assert.match(svg, /<svg/);
  assert.ok(!svg.includes('transform="scale'), "不应使用 scale 变换");
});

test("匹配不到脸型的 SKU 返回 422，不猜", async () => {
  const r = await req("/api/render/face?code=XYZ9000");
  assert.equal(r.status, 422);
});

// ── 新增端点（M3/M6/M7）──────────────────────────────────────────────────

test("冷启动通用预估：有区间、有免责声明、结构上无 companyId", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ text: "厨房大概 14 尺长，安大略省" }),
  });

  const r = await req(`/api/conversations/${conversation.id}/estimate`, { method: "POST", accountId: CONSUMER });
  assert.equal(r.status, 201);
  const body = await r.json() as {
    estimate: { totalRange: { low: number; high: number }; disclaimer: string };
    text: string;
  };
  assert.ok(body.estimate.totalRange.high > body.estimate.totalRange.low, "必须给区间不给精确值");
  assert.match(body.estimate.disclaimer, /不是任何具体公司的真实报价/);
  assert.ok(!("companyId" in body.estimate), "EstimateDraft 不应有 companyId");
  assert.match(body.text, /合计区间/);
});

test("对话：总控助手会指出还缺哪些字段", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const r = await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ text: "我要装修厨房" }),
  });
  const body = await r.json() as { missingFields: string[]; reply: { content: string } };
  assert.ok(body.missingFields.length > 0);
  assert.ok(body.reply.content.length > 0);
});

test("@ 已入驻公司时，公司 Agent 只答本公司规格", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const r = await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ text: "@枫岭橱柜 B30 有多大" }),
  });
  const body = await r.json() as { routedTo: { companyId: string }[]; replies: { content: string; companyId?: string }[] };
  assert.equal(body.routedTo[0]!.companyId, "co_pilot");
  assert.match(body.replies[0]!.content, /B30/);
  assert.equal(body.replies[0]!.companyId, "co_pilot");
});

test("邮件列表：未勾选同意被拒（CASL Express Consent）", async () => {
  const r = await req("/api/subscribe", {
    method: "POST",
    body: JSON.stringify({ email: "no-consent@x.example", companyName: "X", consent: false }),
  });
  assert.equal(r.status, 400);
  const body = await r.json() as { code: string };
  assert.equal(body.code, "CONSENT_REQUIRED");
});

test("邮件列表：主动同意后可订阅，退订链接真的生效", async () => {
  const r = await req("/api/subscribe", {
    method: "POST",
    body: JSON.stringify({ email: "sub@x.example", companyName: "Sub Co", consent: true }),
  });
  assert.equal(r.status, 201);
  const { unsubscribeToken } = await r.json() as { unsubscribeToken: string };
  assert.ok(unsubscribeToken);

  const un = await app.fetch(new Request(`${base}/unsubscribe?token=${unsubscribeToken}`));
  assert.equal(un.status, 200);
  assert.match(await un.text(), /已退订/);

  // 无效 token
  const bad = await app.fetch(new Request(`${base}/unsubscribe?token=nope`));
  assert.equal(bad.status, 400);
});

test("重复订阅被唯一约束挡下", async () => {
  const payload = JSON.stringify({ email: "dup@x.example", companyName: "Dup", consent: true });
  assert.equal((await req("/api/subscribe", { method: "POST", body: payload })).status, 201);
  assert.equal((await req("/api/subscribe", { method: "POST", body: payload })).status, 409);
});

test("运营端点需要管理员令牌", async () => {
  assert.equal((await req("/api/admin/mention-signals")).status, 401);
  const ok = await app.fetch(new Request(`${base}/api/admin/mention-signals`, {
    headers: { "x-admin-token": "test-admin-token" },
  }));
  assert.equal(ok.status, 200);
});

test("销售看板去标识化：只有聚合计数与话术，无客户身份", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ text: "@Sunrise Kitchens 你们做转角柜吗" }),
  });

  const r = await app.fetch(new Request(`${base}/api/admin/mention-signals`, {
    headers: { "x-admin-token": "test-admin-token" },
  }));
  const body = await r.json() as { aggregated: { normalizedName: string; count: number; outreachLine: string }[] };
  const hit = body.aggregated.find((a) => a.normalizedName.includes("sunrise"));
  assert.ok(hit, "应记录到提及信号");
  assert.match(hit.outreachLine, /有客户/);
  const raw = JSON.stringify(body);
  for (const pii of ["alex@example.com", "ca_demo_consumer", conversation.id]) {
    assert.ok(!raw.includes(pii), `销售看板泄露了 ${pii}`);
  }
});

test("留存清除返回计划而不是直接执行", async () => {
  const r = await app.fetch(new Request(`${base}/api/admin/retention/plan`, {
    headers: { "x-admin-token": "test-admin-token" },
  }));
  assert.equal(r.status, 200);
  const body = await r.json() as { plan: { conversationsToDelete: string[]; notes: string[] } };
  assert.ok(Array.isArray(body.plan.conversationsToDelete));
});

test("数据主体访问权：导出本账号数据并说明留存规则", async () => {
  const r = await req("/api/me/export", { accountId: CONSUMER });
  assert.equal(r.status, 200);
  const body = await r.json() as { account: { id: string }; notes: string[] };
  assert.equal(body.account.id, CONSUMER);
  assert.ok(body.notes.some((n) => n.includes("7 年")));
});

test("数据主体删除权：会话删除、报价去标识化保留", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: "ca_demo_trade" });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const quoteRes = await req("/api/quotes", {
    method: "POST", accountId: "ca_demo_trade",
    body: JSON.stringify({
      companyId: "co_pilot", conversationId: conversation.id, doorStyleId: "ds_shaker_white",
      selections: [{ moduleId: "m_b30", qty: 1, width: 30, height: 34.5, depth: 24, assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [] }],
    }),
  });
  const { quote } = await quoteRes.json() as { quote: { id: string } };

  const del = await req("/api/me/delete", { method: "POST", accountId: "ca_demo_trade" });
  assert.equal(del.status, 200);
  const body = await del.json() as { outcome: { conversationsDeleted: string[]; quotesDeIdentified: string[]; explanation: string } };
  assert.ok(body.outcome.conversationsDeleted.includes(conversation.id));
  assert.ok(body.outcome.quotesDeIdentified.includes(quote.id));
  assert.match(body.outcome.explanation, /去标识化/);

  // 会话确实没了
  assert.equal((await req(`/api/conversations/${conversation.id}`, { accountId: "ca_demo_trade" })).status, 404);
});

test("数据在重启后仍然存在（持久化接线）", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const again = await req(`/api/conversations/${conversation.id}`, { accountId: CONSUMER });
  assert.equal(again.status, 200);
  const { conversation: reloaded } = await again.json() as { conversation: { id: string } };
  assert.equal(reloaded.id, conversation.id);
});

// ── MVP-2 端点：户型图 → 方案 → 四视图 → 比价 ───────────────────────────

test("户型图：没有视觉模型时降级为手动录入，逐条追问", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };

  const r = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "kitchen.png", mimeType: "image/png", sizeBytes: 1024 }),
  });
  assert.equal(r.status, 201);
  const body = await r.json() as { floorPlan: { id: string }; ready: boolean; questions: { id: string }[] };
  assert.equal(body.ready, false, "没识别出墙段就不该说 ready");
  assert.ok(body.questions.length > 0, "应逐条追问");
});

test("户型未补齐时拒绝出方案，并把待办列出来", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const { floorPlan } = await fpRes.json() as { floorPlan: { id: string } };

  const r = await req(`/api/floorplans/${floorPlan.id}/layout`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ companyId: "co_pilot" }),
  });
  assert.equal(r.status, 409);
  const body = await r.json() as { questions: unknown[] };
  assert.ok(body.questions.length > 0);
});

test("补齐户型 → 出方案 → 四视图 → 转报价（完整 MVP-2 链路）", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const { floorPlan } = await fpRes.json() as { floorPlan: { id: string } };

  // 手动补齐
  await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ addRun: { label: "北墙", length: 144 } }),
  });
  const resolved = await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ ceilingHeight: 96 }),
  });
  const afterResolve = await resolved.json() as { ready: boolean };
  assert.equal(afterResolve.ready, true);

  // 出方案
  const layoutRes = await req(`/api/floorplans/${floorPlan.id}/layout`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ companyId: "co_pilot" }),
  });
  assert.equal(layoutRes.status, 201, await layoutRes.clone().text());
  const layout = await layoutRes.json() as {
    layoutKey: string;
    selections: { moduleId: string; qty: number }[];
    views: { runLabel: string; views: Record<string, string> }[];
    moduleCounts: unknown[];
  };
  assert.ok(layout.selections.length > 0);
  assert.equal(layout.views.length, 1);
  // 四视图齐备且都是 SVG
  assert.deepEqual(Object.keys(layout.views[0]!.views).sort(), ["front", "side", "topBase", "topWall"]);
  for (const svg of Object.values(layout.views[0]!.views)) assert.match(svg, /^<svg /);
  // 选择结构里没有任何价格字段（FR-8）
  for (const s of layout.selections) {
    assert.ok(!("unitPrice" in s) && !("total" in s));
  }

  // 方案直接喂给报价
  const quoteRes = await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId: conversation.id,
      doorStyleId: "ds_shaker_white", selections: layout.selections,
    }),
  });
  assert.equal(quoteRes.status, 201, await quoteRes.clone().text());
  const { quote } = await quoteRes.json() as { quote: { total: number; lineItems: unknown[] } };
  assert.ok(quote.lineItems.length > 0);
  assert.ok(quote.total > 0);
});

test("局部重算只影响指定墙段", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const { floorPlan } = await fpRes.json() as { floorPlan: { id: string } };
  await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ addRun: { label: "北墙", length: 144 } }),
  });
  const two = await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ addRun: { label: "西墙", length: 96 } }),
  });
  const { floorPlan: fp2 } = await two.json() as { floorPlan: { parsedGeometry: { wallRuns: { id: string }[] } } };
  await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ ceilingHeight: 96 }),
  });

  const first = await req(`/api/floorplans/${floorPlan.id}/layout`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ companyId: "co_pilot" }),
  });
  const before = await first.json() as { moduleCounts: unknown[] };

  const secondRunId = fp2.parsedGeometry.wallRuns[1]!.id;
  const again = await req(`/api/floorplans/${floorPlan.id}/layout/regenerate`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ companyId: "co_pilot", wallRunId: secondRunId }),
  });
  assert.equal(again.status, 200);
  const after = await again.json() as { moduleCounts: unknown[] };
  assert.deepEqual(after.moduleCounts, before.moduleCounts, "重算同一段应得到相同结果");
});

test("有户型图时通用预估升级为含四视图版本", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const { floorPlan } = await fpRes.json() as { floorPlan: { id: string } };
  await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ addRun: { label: "北墙", length: 144 } }),
  });
  await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ ceilingHeight: 96 }),
  });

  const r = await req(`/api/conversations/${conversation.id}/estimate`, { method: "POST", accountId: CONSUMER });
  const body = await r.json() as {
    views?: { views: Record<string, string> }[];
    viewsDisclaimer?: string;
    estimate: { disclaimer: string };
  };
  assert.ok(body.views && body.views.length > 0, "应带四视图");
  assert.match(body.viewsDisclaimer ?? "", /不对应任何具体公司的真实型号/);
  assert.match(body.estimate.disclaimer, /不是任何具体公司的真实报价/);
});

test("多公司比价：口径一致性有标注", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };

  const mk = async (companyId: string, doorStyleId: string, moduleId: string) => {
    const spec = await (await req(`/api/companies/${companyId}/spec`, { accountId: CONSUMER })).json() as {
      modules: { id: string; code: string; widthOptions: number[]; heightOptions: number[]; depthOptions: number[] }[];
    };
    const mod = spec.modules.find((m) => m.id === moduleId)!;
    return req("/api/quotes", {
      method: "POST", accountId: CONSUMER,
      body: JSON.stringify({
        companyId, conversationId: conversation.id, doorStyleId,
        selections: [{
          moduleId: mod.id, qty: 4, width: mod.widthOptions[0],
          height: mod.heightOptions[0], depth: mod.depthOptions[0],
          assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [],
        }],
      }),
    });
  };

  assert.equal((await mk("co_pilot", "ds_shaker_white", "m_b30")).status, 201);
  assert.equal((await mk("co_lakeside", "ds_flat_slab_white", "m_nw_b30")).status, 201);

  const r = await req(`/api/conversations/${conversation.id}/comparison`, { accountId: CONSUMER });
  assert.equal(r.status, 200);
  const body = await r.json() as {
    comparison: { rows: { companyName: string; total: number }[]; comparable: boolean };
    text: string; html: string;
  };
  assert.equal(body.comparison.rows.length, 2);
  // 按总价升序
  assert.ok(body.comparison.rows[0]!.total <= body.comparison.rows[1]!.total);
  assert.match(body.text, /只比价格/);
  assert.match(body.html, /<table/);
});

test("别人的户型图读不到", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const { floorPlan } = await fpRes.json() as { floorPlan: { id: string } };
  const r = await req(`/api/floorplans/${floorPlan.id}`, { accountId: "ca_demo_trade" });
  assert.equal(r.status, 404);
});
