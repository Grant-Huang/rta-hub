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

// CASL 要求发件人身份完整，缺了就会被发送路径挡下（这是**特性**，见 email/sender.ts）。
// 生产必须配这几项，测试同样要配，否则测的就不是真实链路。
process.env.SENDER_NAME = "RTA Hub";
process.env.SMTP_FROM = "quotes@rta-hub.test";
process.env.SENDER_PHONE = "+1-800-555-0100";

let app: { fetch: (req: Request) => Response | Promise<Response> };

before(async () => {
  const mod = await import("../src/server.js");
  // 用临时数据目录，避免测试写进真实的 data/
  app = await mod.createApp({ ephemeral: true, llm: undefined });
});

const CONSUMER = "ca_demo_consumer";
const TRADE_ACCOUNT = "ca_demo_trade";
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

test("会话列表只回本账号的，且带得出标题——左栏靠它显示历史", async () => {
  const created = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await created.json() as { conversation: { id: string } };
  await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ text: "我们家厨房要整个翻新" }),
  });

  const mine = await req("/api/conversations", { accountId: CONSUMER });
  assert.equal(mine.status, 200);
  const body = await mine.json() as {
    conversations: { id: string; title: string; messageCount: number }[];
  };
  const row = body.conversations.find((v) => v.id === conversation.id);
  assert.ok(row, "自己刚建的会话没出现在列表里");
  // 标题取客户说的第一句话——「会话 cv_3f2a」对客户没有任何意义
  assert.equal(row.title, "我们家厨房要整个翻新");
  assert.ok(row.messageCount >= 2);

  // 别人的会话不该出现在我的列表里
  const other = await req("/api/conversations", { accountId: TRADE_ACCOUNT });
  const otherBody = await other.json() as { conversations: { id: string }[] };
  assert.equal(otherBody.conversations.some((v) => v.id === conversation.id), false,
    "会话列表跨账号泄露");
});

test("公司目录只列出 active 公司，且不暴露订阅状态", async () => {
  const r = await req("/api/companies");
  const body = await r.json() as { companies: { id: string; name: string }[] };
  // active 试点公司；Northern Wood 已发布规格但未订阅，不应出现
  assert.deepEqual(body.companies.map((c) => c.id).sort(),
    ["co_birchline", "co_lakeside", "co_oppein", "co_pilot"]);
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
  assert.ok(disclosure.items.some((i) => /Your email|你的邮箱/i.test(i.label)));

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
  assert.match(body.error, /customer must confirm before send/i);
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
  assert.match(body.estimate.disclaimer, /not a real quote from any specific company|不是任何具体公司的真实报价/i);
  assert.ok(!("companyId" in body.estimate), "EstimateDraft 不应有 companyId");
  assert.match(body.text, /Range total|合计区间/i);
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
  assert.match(await un.text(), /unsubscribed|已退订/i);

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
  assert.match(hit.outreachLine, /customer|有客户/i);
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
  const added = await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ addRun: { label: "北墙", length: 144 } }),
  });
  const runId = (await added.json() as {
    floorPlan: { parsedGeometry: { wallRuns: { id: string }[] } };
  }).floorPlan.parsedGeometry.wallRuns[0]!.id;
  const resolved = await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ ceilingHeight: 96 }),
  });
  const afterResolve = await resolved.json() as { ready: boolean };
  assert.equal(afterResolve.ready, true);
  await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      addFeature: { wallRunId: runId, kind: "plumbing", offset: 60, width: 24 },
    }),
  });

  await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "Modern style, budget CAD $10–20k, Ontario ON. No windows. Appliances later." }),
  });
  await advance(conversation.id, CONSUMER, "consent");
  const planRes = await req(`/api/floorplans/${floorPlan.id}/plan-view`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ companyId: "co_pilot" }),
  });
  assert.equal(planRes.status, 201, await planRes.clone().text());
  const planBody = await planRes.json() as { planViews: { base: string; wall: string } };
  assert.match(planBody.planViews.base, /^<svg /);
  assert.match(planBody.planViews.wall, /^<svg /);
  await advance(conversation.id, CONSUMER, "approvePlan");

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
  await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      addFeature: { wallRunId: fp2.parsedGeometry.wallRuns[0]!.id, kind: "plumbing", offset: 48, width: 24 },
    }),
  });
  await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "Modern style, budget CAD $10–20k, Ontario ON. No windows. Appliances later." }),
  });
  await advance(conversation.id, CONSUMER, "consent");
  await req(`/api/floorplans/${floorPlan.id}/plan-view`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ companyId: "co_pilot" }),
  });
  await advance(conversation.id, CONSUMER, "approvePlan");

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
  assert.match(body.viewsDisclaimer ?? "", /not any seller.s real SKUs|不对应任何具体公司的真实型号/i);
  assert.match(body.estimate.disclaimer, /not a real quote from any specific company|不是任何具体公司的真实报价/i);
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
  assert.match(body.text, /compares price only|只比价格/i);
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

// ── MVP-3：方案持久化、PDF、贸易账号、争议裁定台 ──────────────────────────

const TRADE = "ca_demo_trade";

/** 建一个补齐了户型、出过方案的会话，供后面的 PDF / 修订链测试复用。 */
/** 满足 FR-15 出图前检查表：几何 + 上下水 + 意图 + 窗/家电可推迟说明。 */
async function seedDesignIntake(conversationId: string, accountId: string, floorPlanId: string) {
  const added = await req(`/api/floorplans/${floorPlanId}/resolve`, {
    method: "POST", accountId,
    body: JSON.stringify({ addRun: { label: "North", length: 144 } }),
  });
  const runId = (await added.json() as {
    floorPlan: { parsedGeometry: { wallRuns: { id: string }[] } };
  }).floorPlan.parsedGeometry.wallRuns[0]!.id;
  await req(`/api/floorplans/${floorPlanId}/resolve`, {
    method: "POST", accountId, body: JSON.stringify({ ceilingHeight: 96 }),
  });
  await req(`/api/floorplans/${floorPlanId}/resolve`, {
    method: "POST", accountId,
    body: JSON.stringify({
      addFeature: { wallRunId: runId, kind: "plumbing", offset: 60, width: 24 },
    }),
  });
  await req(`/api/conversations/${conversationId}/messages`, {
    method: "POST", accountId,
    body: JSON.stringify({
      text: "Modern style, budget CAD $10–20k, Ontario ON. No windows. Appliances later.",
    }),
  });
  return runId;
}

async function readyProject(accountId: string, appliances?: unknown[]) {
  const convRes = await req("/api/conversations", { method: "POST", accountId });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const { floorPlan } = await fpRes.json() as { floorPlan: { id: string } };
  await seedDesignIntake(conversation.id, accountId, floorPlan.id);
  if (appliances) {
    await req(`/api/floorplans/${floorPlan.id}/resolve`, {
      method: "POST", accountId, body: JSON.stringify({ appliances }),
    });
  }
  // 走完整阶段：客户点头 → 全局俯视图 → 认可排布 → 才出四视图
  await advance(conversation.id, accountId, "consent");
  await req(`/api/floorplans/${floorPlan.id}/plan-view`, {
    method: "POST", accountId, body: JSON.stringify({ companyId: "co_pilot" }),
  });
  await advance(conversation.id, accountId, "approvePlan");

  const layoutRes = await req(`/api/floorplans/${floorPlan.id}/layout`, {
    method: "POST", accountId, body: JSON.stringify({ companyId: "co_pilot" }),
  });
  const layout = await layoutRes.json() as {
    designLayoutId: string; revisionNo: number; selections: unknown[];
  };
  return { conversationId: conversation.id, floorPlanId: floorPlan.id, layout };
}

test("家电信息记在户型上；没给宽度走推定值并如实标注", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const { floorPlan } = await fpRes.json() as { floorPlan: { id: string } };

  // 还没说有哪些家电时，先问那一题
  const first = await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ addRun: { label: "北墙", length: 144 } }),
  });
  const firstBody = await first.json() as { applianceQuestions: { key: string }[] };
  assert.equal(firstBody.applianceQuestions[0]?.key, "appliances");

  const res = await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      appliances: [
        { kind: "refrigerator" },                 // 不确定 → 推定
        { kind: "range", width: 36 },             // 客户给的
      ],
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as {
    floorPlan: { appliances: { kind: string; width: number; provenance: string }[] };
    provenanceNote?: string;
    applianceQuestions: { prompt: string }[];
  };

  const fridge = body.floorPlan.appliances.find((a) => a.kind === "refrigerator");
  assert.equal(fridge?.provenance, "assumed");
  assert.equal(fridge?.width, 33, "走常见尺寸");
  assert.equal(
    body.floorPlan.appliances.find((a) => a.kind === "range")?.provenance, "customer");

  assert.ok(/Refrigerator|冰箱/.test(body.provenanceNote ?? ""), body.provenanceNote);
  assert.ok(
    body.applianceQuestions.some((q) => /冰箱|Refrigerator/i.test(q.prompt)),
    "推定的那个还该继续追问，客户给过的不该再问",
  );
});

test("离谱的家电尺寸被拒绝，不静默写进户型", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const { floorPlan } = await fpRes.json() as { floorPlan: { id: string } };

  const res = await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ appliances: [{ kind: "refrigerator", width: 900 }] }),
  });
  assert.equal(res.status, 400);
});

test("报价交付前跑完整审核，并把查了哪几项告诉客户", async () => {
  const { conversationId, layout } = await readyProject(CONSUMER);
  const res = await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId,
      doorStyleId: "ds_shaker_white", selections: layout.selections,
    }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json() as {
    audit: { ok: boolean; checked: string[] }; auditText: string;
  };
  assert.equal(body.audit.ok, true);
  // 报价是客户据以做决定的东西，所以这一步查得最严
  for (const need of ["QUOTE_RECONCILIATION", "PRICE_SNAPSHOT", "BOM_INCOMPLETE", "SPEC_MISMATCH"]) {
    assert.ok(body.audit.checked.includes(need), `没跑 ${need}：${body.audit.checked.join()}`);
  }
  assert.ok(/Pre-delivery check|交付前检查/i.test(body.auditText), body.auditText);
});

test("推定的家电尺寸要跟着**报价单**一起走，不能只写在图纸说明里", async () => {
  // SCENARIOS 场景 J：客户对烤箱选了「我不确定」→ 走常见默认值，但**报价单上
  // 要如实写「烤箱按 30" 预留」**。报价单是客户拿去下单的那一份；只在图纸说明里
  // 说过一次，订柜的人看不到，柜子做出来装不进去。
  const { conversationId, layout } = await readyProject(CONSUMER, [
    { kind: "refrigerator", width: 33 },  // 客户给的尺寸
    { kind: "wallOven" },                 // 「不确定」→ 推定
  ]);
  const res = await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId,
      doorStyleId: "ds_shaker_white", selections: layout.selections,
    }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json() as {
    quoteListText: string; audit: { ok: boolean; checked: string[] };
  };

  assert.ok(body.audit.checked.includes("UNDISCLOSED_ASSUMPTION"),
    `没跑推定值披露检查：${body.audit.checked.join()}`);
  assert.match(body.quoteListText, /Wall oven|烤箱/i, "报价单上没提烤箱");
  assert.match(body.quoteListText, /assumed|reserved|推定|预留/i, "报价单上没说那个尺寸是推定的");
  // 客户真给了尺寸的那一件不该被说成"推定"——那会让客户以为自己没说过
  assert.equal(/冰箱按 .*推定|冰箱按 .*预留|Refrigerator reserved|Refrigerator.*assumed/i.test(body.quoteListText), false,
    `客户给过尺寸的冰箱被写成了推定：${body.quoteListText}`);
});

test("四视图与俯视图交付前也各自跑审核", async () => {
  const { floorPlanId, layout } = await readyProject(CONSUMER);
  assert.ok((layout as unknown as { audit: { ok: boolean } }).audit.ok, "四视图这一步要带审核");

  const pv = await req(`/api/floorplans/${floorPlanId}/plan-view`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ companyId: "co_pilot" }),
  });
  const pvBody = await pv.json() as { audit: { ok: boolean; checked: string[] } };
  assert.ok(pvBody.audit.checked.includes("ERGONOMICS"));
  assert.ok(pvBody.audit.checked.includes("GEOMETRY"));
});

/** 推进设计阶段。 */
function advance(conversationId: string, accountId: string, action: string, extra: object = {}) {
  return req(`/api/conversations/${conversationId}/design/advance`, {
    method: "POST", accountId,
    body: JSON.stringify({ companyId: "co_pilot", action, ...extra }),
  });
}

test("FR-15：齐备后 design 接口带回叙事 brief 与出图前文字确认", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const { floorPlan } = await fpRes.json() as { floorPlan: { id: string } };

  // 只有几何、没有上下水/意图 → 不能问出设计
  await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ addRun: { label: "North", length: 144 } }),
  });
  await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ ceilingHeight: 96 }),
  });
  const early = await (await req(
    `/api/conversations/${conversation.id}/design?companyId=co_pilot`,
    { accountId: CONSUMER },
  )).json() as {
    designBrief: { readyToAskDesign: boolean; openItems: { id: string }[] };
    prompt: { awaiting?: string } | null;
  };
  assert.equal(early.designBrief.readyToAskDesign, false);
  assert.ok(early.designBrief.openItems.some((i) => i.id === "plumbing"));

  await seedDesignIntake(conversation.id, CONSUMER, floorPlan.id);
  const ready = await (await req(
    `/api/conversations/${conversation.id}/design?companyId=co_pilot`,
    { accountId: CONSUMER },
  )).json() as {
    session: { stage: string };
    designBrief: {
      readyToAskDesign: boolean;
      sections: { id: string; body: string; status: string }[];
      confirmationText: string;
    };
    prompt: { message: string; awaiting?: string };
  };
  assert.equal(ready.designBrief.readyToAskDesign, true);
  assert.equal(ready.session.stage, "readyToDraw");
  assert.equal(ready.prompt.awaiting, "drawingConsent");
  assert.match(ready.prompt.message, /Shall I generate a design/i);
  assert.match(ready.prompt.message, /Plumbing|上下水/i);
  assert.ok(ready.designBrief.sections.some((s) => s.id === "space" && /144/.test(s.body)));
  assert.match(ready.designBrief.confirmationText, /Shall I generate a design/i);

  const getConv = await (await req(`/api/conversations/${conversation.id}?companyId=co_pilot`, {
    accountId: CONSUMER,
  })).json() as { designBrief: { readyToAskDesign: boolean } };
  assert.equal(getConv.designBrief.readyToAskDesign, true);
});

test("一轮修改带上的偏好改动会真的改到下一版排布上", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const { floorPlan } = await fpRes.json() as { floorPlan: { id: string } };
  await seedDesignIntake(conversation.id, CONSUMER, floorPlan.id);
  await req(`/api/conversations/${conversation.id}/preferences`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ companyId: "co_pilot", storage: "doors" }),
  });
  await advance(conversation.id, CONSUMER, "consent");

  const planView = async () => {
    const r = await req(`/api/floorplans/${floorPlan.id}/plan-view`, {
      method: "POST", accountId: CONSUMER, body: JSON.stringify({ companyId: "co_pilot" }),
    });
    const b = await r.json() as { moduleCounts: { moduleCode: string; qty: number }[] };
    return b.moduleCounts.map((m) => `${m.moduleCode}×${m.qty}`).sort().join(" ");
  };

  const first = await planView();
  const rev = await advance(conversation.id, CONSUMER, "revise", {
    note: "锅具多，抽屉多做一些", changes: { storage: "drawers" },
  });
  assert.equal(rev.status, 200, await rev.clone().text());
  const revBody = await rev.json() as { revision: { applied: string[]; note?: string } };
  assert.deepEqual(revBody.revision.applied, ["storage"]);
  assert.equal(revBody.revision.note, "锅具多，抽屉多做一些");

  // 客户提了意见、系统说采纳了，那下一版就必须真的不一样
  assert.notEqual(await planView(), first);
});

test("提了句改不动的话时，如实说这轮没有改动，不假装改过", async () => {
  const { conversationId } = await readyProject(CONSUMER);
  await advance(conversationId, CONSUMER, "backToPlan");
  const rev = await advance(conversationId, CONSUMER, "revise", { note: "整体看着大气一点" });
  const body = await rev.json() as { revision: { applied: string[]; unapplied?: string } };
  assert.deepEqual(body.revision.applied, []);
  assert.ok(body.revision.unapplied?.includes("same as the previous version"), JSON.stringify(body.revision));
});

test("修改里夹带不存在的门板 id 会被拒绝，走的是和选择题同一套校验", async () => {
  const { conversationId } = await readyProject(CONSUMER);
  await advance(conversationId, CONSUMER, "backToPlan");
  const rev = await advance(conversationId, CONSUMER, "revise", {
    changes: { doorStyleId: "ds_不存在的门板" },
  });
  assert.equal(rev.status, 400);
});

test("方案落盘：重算推进修订号，designLayoutId 保持不变", async () => {
  const { floorPlanId, layout } = await readyProject(CONSUMER);
  // 全局俯视图本身就落了第 1 版修订，四视图是第 2 版——
  // 客户在俯视图上看到的那一版必须可追溯（§3.6）
  assert.equal(layout.revisionNo, 2);

  const again = await req(`/api/floorplans/${floorPlanId}/layout/regenerate`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ companyId: "co_pilot", wallRunId: "wr_1" }),
  });
  assert.equal(again.status, 200, await again.clone().text());
  const next = await again.json() as { designLayoutId: string; revisionNo: number };
  // 同一个方案的第 2 版，不是新方案
  assert.equal(next.designLayoutId, layout.designLayoutId);
  assert.equal(next.revisionNo, 3);
});

test("报价引用方案的真实修订号，事后追得回是哪一版", async () => {
  const { conversationId, layout } = await readyProject(CONSUMER);
  const quoteRes = await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId, doorStyleId: "ds_shaker_white",
      selections: layout.selections,
    }),
  });
  const { quote } = await quoteRes.json() as {
    quote: { designLayoutId: string; designRevisionNo: number };
  };
  assert.equal(quote.designLayoutId, layout.designLayoutId);
  assert.equal(quote.designRevisionNo, layout.revisionNo);
});

test("PDF 报价单：真的是 PDF，且带下载文件名", async () => {
  const { conversationId, layout } = await readyProject(CONSUMER);
  const quoteRes = await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId, doorStyleId: "ds_shaker_white",
      selections: layout.selections,
    }),
  });
  const { quote } = await quoteRes.json() as { quote: { id: string } };

  const pdfRes = await req(`/api/quotes/${quote.id}/pdf`, { accountId: CONSUMER });
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers.get("content-type"), "application/pdf");
  assert.match(pdfRes.headers.get("content-disposition") ?? "", /attachment; filename=".*\.pdf"/);
  const buf = Buffer.from(await pdfRes.arrayBuffer());
  assert.ok(buf.subarray(0, 8).toString("latin1").startsWith("%PDF-1.4"));
  assert.ok(buf.length > 2000);
});

test("没有方案的报价不假装能出图纸版 PDF", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const quoteRes = await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId: conversation.id, doorStyleId: "ds_shaker_white",
      selections: [{
        moduleId: "m_b30", qty: 2, width: 30, height: 34.5, depth: 24,
        assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [],
      }],
    }),
  });
  const { quote } = await quoteRes.json() as { quote: { id: string } };
  const r = await req(`/api/quotes/${quote.id}/pdf`, { accountId: CONSUMER });
  assert.equal(r.status, 409);
});

test("别人的报价 PDF 下不到", async () => {
  const { conversationId, layout } = await readyProject(CONSUMER);
  const quoteRes = await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId, doorStyleId: "ds_shaker_white",
      selections: layout.selections,
    }),
  });
  const { quote } = await quoteRes.json() as { quote: { id: string } };
  const r = await req(`/api/quotes/${quote.id}/pdf`, { accountId: TRADE });
  assert.equal(r.status, 404);
});

test("发送时 PDF 作为附件带上", async () => {
  const { conversationId, layout } = await readyProject(CONSUMER);
  const quoteRes = await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId, doorStyleId: "ds_shaker_white",
      selections: layout.selections,
    }),
  });
  const { quote } = await quoteRes.json() as { quote: { id: string } };
  await req(`/api/quotes/${quote.id}/confirm`, { method: "POST", accountId: CONSUMER });
  const sendRes = await req(`/api/quotes/${quote.id}/send`, { method: "POST", accountId: CONSUMER });
  const body = await sendRes.json() as { attachedPdf: boolean; pdfWarnings?: string[] };
  assert.equal(body.attachedPdf, true);
  // 中文墙段标签已经换成英文说法，不该再有字符替换告警
  assert.equal(body.pdfWarnings, undefined);
});

test("项目列表只含本账号的项目，并给出组合概览", async () => {
  await readyProject(TRADE);
  await readyProject(TRADE);
  const r = await req("/api/me/projects", { accountId: TRADE });
  assert.equal(r.status, 200);
  const body = await r.json() as {
    projects: { conversationId: string; status: string }[];
    portfolio: { total: number; byStatus: Record<string, number> };
  };
  assert.ok(body.projects.length >= 2);
  assert.equal(body.portfolio.total, body.projects.length);

  const mine = new Set(body.projects.map((p) => p.conversationId));
  const consumerList = await (await req("/api/me/projects", { accountId: CONSUMER })).json() as {
    projects: { conversationId: string }[];
  };
  for (const p of consumerList.projects) assert.ok(!mine.has(p.conversationId));
});

test("未核实的贸易账号：按零售价定价，并如实说明原因", async () => {
  const profileRes = await req("/api/me/profile", { accountId: TRADE });
  const profile = await profileRes.json() as {
    accountType: string; effectiveAccountType: string;
    tradePricing: { allowed: boolean; nextStep: string };
  };
  assert.equal(profile.accountType, "trade");
  assert.equal(profile.effectiveAccountType, "consumer");
  assert.equal(profile.tradePricing.nextStep, "submitVerification");

  const convRes = await req("/api/conversations", { method: "POST", accountId: TRADE });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const quoteRes = await req("/api/quotes", {
    method: "POST", accountId: TRADE,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId: conversation.id, doorStyleId: "ds_shaker_white",
      selections: [{
        moduleId: "m_b30", qty: 2, width: 30, height: 34.5, depth: 24,
        assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [],
      }],
    }),
  });
  const body = await quoteRes.json() as {
    quote: { accountTypeAtQuote: string };
    tradePricing?: { applied: boolean; reason: string };
  };
  // 关键：降级发生在**定价链路**上，不是界面隐藏
  assert.equal(body.quote.accountTypeAtQuote, "consumer");
  assert.equal(body.tradePricing?.applied, false);
  assert.match(body.tradePricing!.reason, /verification|资质核实/i);
});

test("资质核实全流程：提交 → 待审队列 → 通过 → 贸易价生效", async () => {
  const submit = await req("/api/me/verification", {
    method: "POST", accountId: TRADE,
    body: JSON.stringify({ businessNumber: "123456789 RT 0001", legalName: "Riverside Builders Ltd" }),
  });
  assert.equal(submit.status, 201, await submit.clone().text());

  const queue = await req("/api/admin/verifications", {
    headers: { "x-admin-token": "test-admin-token" },
  });
  const q = await queue.json() as {
    verifications: { accountId: string; gstFormatOk: boolean; businessNumber: string }[];
  };
  const mine = q.verifications.find((v) => v.accountId === TRADE);
  assert.ok(mine, "待审队列里应该有这条申请");
  assert.equal(mine!.gstFormatOk, true);

  const review = await req(`/api/admin/verifications/${TRADE}/review`, {
    method: "POST", headers: { "x-admin-token": "test-admin-token" },
    body: JSON.stringify({ approve: true, reviewedBy: "ops" }),
  });
  assert.equal(review.status, 200, await review.clone().text());

  const after = await (await req("/api/me/profile", { accountId: TRADE })).json() as {
    effectiveAccountType: string; interaction: { explainJargon: boolean };
    tradePricing: { allowed: boolean };
  };
  assert.equal(after.effectiveAccountType, "trade");
  assert.equal(after.tradePricing.allowed, true);
  // 交互口吻同步切换，不会出现"按贸易价报价却全程新手引导"
  assert.equal(after.interaction.explainJargon, false);
});

test("消费者账号提交贸易资质被拒", async () => {
  const r = await req("/api/me/verification", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ businessNumber: "123456789RT0001", legalName: "X Ltd" }),
  });
  assert.equal(r.status, 400);
});

test("资质审核队列需要管理员令牌", async () => {
  assert.equal((await req("/api/admin/verifications")).status, 401);
  assert.equal((await req(`/api/admin/verifications/${TRADE}/review`, { method: "POST" })).status, 401);
  assert.equal((await req("/api/admin/disputes")).status, 401);
});

/**
 * 争议链路需要一次**真的投递成功**的发送——计费、争议窗口、审计证据链
 * 都挂在这条路径上，dry-run 覆盖不到。用独立的 app 实例 + 桩传输器，
 * 免得与主实例的 30 天去重窗口互相干扰。
 */
test("计费透明度 → 公司提出争议 → 运营带证据裁定（完整争议链路）", async () => {
  const sentMail: Record<string, unknown>[] = [];
  const mod = await import("../src/server.js");
  const app2 = await mod.createApp({
    ephemeral: true, llm: undefined,
    mailTransport: { sendMail: async (m) => { sentMail.push(m); return { messageId: "x" }; } },
  });
  const req2 = (pathname: string, init: RequestInit & { accountId?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (init.accountId) headers.set("x-account-id", init.accountId);
    return app2.fetch(new Request(base + pathname, { ...init, headers }));
  };

  const convRes = await req2("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const quoteRes = await req2("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId: conversation.id, doorStyleId: "ds_shaker_white",
      selections: [{
        moduleId: "m_b30", qty: 4, width: 30, height: 34.5, depth: 24,
        assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [],
      }],
    }),
  });
  const { quote } = await quoteRes.json() as { quote: { id: string } };
  await req2(`/api/quotes/${quote.id}/confirm`, { method: "POST", accountId: CONSUMER });
  const sent = await req2(`/api/quotes/${quote.id}/send`, { method: "POST", accountId: CONSUMER });
  const sendBody = await sent.json() as {
    billingEventId: string; billingSuppressed: boolean; dryRun: boolean;
    quote: { status: string };
  };
  assert.equal(sendBody.dryRun, false);
  assert.equal(sendBody.quote.status, "sent");
  assert.equal(sendBody.billingSuppressed, false);
  assert.ok(sendBody.billingEventId, "投递成功必须产生计费事件");
  assert.equal(sentMail.length, 1);

  const billingEventId = sendBody.billingEventId;

  // ── 公司侧：这条线索是什么、还剩几天能争议 ──
  const view = await req2("/api/company/co_pilot/billing/disputes", {
    headers: { "x-admin-token": "test-admin-token" },
  });
  assert.equal(view.status, 200);
  const viewBody = await view.json() as {
    events: {
      event: { id: string }; canDispute: boolean; disputeWindowEndsAt: string;
      quote?: { id: string; lineCount: number };
    }[];
  };
  const row = viewBody.events.find((e) => e.event.id === billingEventId);
  assert.ok(row, "应该有这条报价对应的计费事件");
  assert.equal(row!.canDispute, true);
  assert.ok(Date.parse(row!.disputeWindowEndsAt) > Date.now());
  assert.equal(row!.quote?.id, quote.id);
  assert.ok(row!.quote!.lineCount > 0);
  // 公司看得到「这条线索是哪份报价」，但摘要里没有客户身份（FR-13 第 3 条）
  const raw = JSON.stringify(row!.quote);
  assert.ok(!raw.includes("alex@example.com"));
  assert.ok(!raw.includes("Alex"));

  // ── 公司提出争议 ──
  const opened = await req2(`/api/company/co_pilot/billing/${billingEventId}/dispute`, {
    method: "POST", headers: { "x-admin-token": "test-admin-token" },
    body: JSON.stringify({ reason: "duplicate", evidence: "同一客户上周问过", openedBy: "company" }),
  });
  assert.equal(opened.status, 200, await opened.clone().text());

  // 争议中不能再重复提
  const after = await (await req2("/api/company/co_pilot/billing/disputes", {
    headers: { "x-admin-token": "test-admin-token" },
  })).json() as {
    events: { event: { id: string }; canDispute: boolean }[];
  };
  assert.equal(after.events.find((e) => e.event.id === billingEventId)!.canDispute, false);

  // ── 运营裁定台：带审计证据链 ──
  const board = await req2("/api/admin/disputes", { headers: { "x-admin-token": "test-admin-token" } });
  const body = await board.json() as {
    disputes: {
      event: { id: string }; withinWindow: boolean; company: string;
      evidence: { auditTrail: { action: string; contentHash: string }[]; snapshotIntact: boolean };
    }[];
  };
  const d = body.disputes.find((x) => x.event.id === billingEventId);
  assert.ok(d, "裁定台应该列出这条未裁定的争议");
  assert.equal(d!.withinWindow, true);
  assert.equal(d!.company, "Maple Ridge Cabinetry");
  // 证据链要含 created / confirmed / sent 三步，且哈希与当前内容一致
  const actions = d!.evidence.auditTrail.map((a) => a.action);
  for (const a of ["created", "confirmed", "sent"]) assert.ok(actions.includes(a), `缺少 ${a} 事件`);
  assert.equal(d!.evidence.snapshotIntact, true);

  // 裁定后离开待办队列
  const resolved = await req2(`/api/admin/billing/${billingEventId}/resolve`, {
    method: "POST", headers: { "x-admin-token": "test-admin-token" },
    body: JSON.stringify({ resolution: "refunded", resolvedBy: "ops" }),
  });
  assert.equal(resolved.status, 200, await resolved.clone().text());
  const board2 = await (await req2("/api/admin/disputes", {
    headers: { "x-admin-token": "test-admin-token" },
  })).json() as { disputes: { event: { id: string } }[] };
  assert.ok(!board2.disputes.some((x) => x.event.id === billingEventId));
});

// ── 价格与偏好的选择式提问（FR-1 补强）────────────────────────────────────

test("选择题：选项全部来自真实规格库，价格影响是算出来的", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };

  const r = await req(`/api/conversations/${conversation.id}/questions?companyId=co_pilot`, {
    accountId: CONSUMER,
  });
  assert.equal(r.status, 200);
  const body = await r.json() as {
    questions: { key: string; options: { id: string; priceNote: string }[] }[];
    note?: string;
  };

  const door = body.questions.find((q) => q.key === "doorStyle");
  assert.ok(door, "应该有门板样式题");
  // 选项 id 必须是真实的 doorStyleId
  const spec = await (await req("/api/companies/co_pilot/spec")).json() as {
    doorStyles: { id: string }[];
  };
  const real = new Set(spec.doorStyles.map((d) => d.id));
  for (const o of door!.options) assert.ok(real.has(o.id), `${o.id} 不在规格库中`);
  // 每个选项都带可展示的价格说明
  for (const o of door!.options) assert.ok(o.priceNote.length > 0);

  // 没上传户型图 → 问不出预算题，且如实说明原因
  assert.ok(!body.questions.some((q) => q.key === "budgetBand"));
  assert.match(body.note ?? "", /Upload a floor plan|上传户型图/i);
});

test("有户型图后才出预算题，区间按尺寸锚定", async () => {
  const { conversationId } = await readyProject(CONSUMER);
  const body = await (await req(
    `/api/conversations/${conversationId}/questions?companyId=co_pilot`, { accountId: CONSUMER },
  )).json() as { questions: { key: string; prompt: string }[]; note?: string };

  const budget = body.questions.find((q) => q.key === "budgetBand");
  assert.ok(budget, "有户型图就该能给出预算区间");
  assert.match(budget!.prompt, /144"/);
  assert.equal(body.note, undefined);
});

test("偏好被记录，答过的不再问", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };

  const save = await req(`/api/conversations/${conversation.id}/preferences`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ companyId: "co_pilot", doorStyleId: "ds_navy", storage: "drawers" }),
  });
  assert.equal(save.status, 200, await save.clone().text());
  const saved = await save.json() as {
    preferences: { doorStyleId: string; storage: string }; layoutAffected: boolean;
  };
  assert.equal(saved.preferences.doorStyleId, "ds_navy");
  assert.equal(saved.layoutAffected, true, "储物偏好改变排布，应提示需要重排");

  const after = await (await req(
    `/api/conversations/${conversation.id}/questions?companyId=co_pilot`, { accountId: CONSUMER },
  )).json() as { questions: { key: string }[] };
  assert.ok(!after.questions.some((q) => q.key === "doorStyle"));
  assert.ok(!after.questions.some((q) => q.key === "storage"));
});

test("伪造的门板 id 被拒——不能等到定价时才炸", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const r = await req(`/api/conversations/${conversation.id}/preferences`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ companyId: "co_pilot", doorStyleId: "ds_不存在" }),
  });
  assert.equal(r.status, 400);
  assert.match((await r.json() as { error: string }).error, /not in this company.s catalog|不在该公司的规格库中/i);
});

test("公司专属偏好按公司分开存，换公司不串味", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };

  await req(`/api/conversations/${conversation.id}/preferences`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ companyId: "co_pilot", doorStyleId: "ds_navy", budgetBand: "premium" }),
  });
  const other = await (await req(`/api/conversations/${conversation.id}/questions?companyId=co_lakeside`, {
    accountId: CONSUMER,
  })).json() as { answered: { doorStyleId?: string; budgetBand?: string } };

  // 门板 id 是 co_pilot 规格库里的，换到 co_lakeside 就不该带过来
  assert.equal(other.answered.doorStyleId, undefined);
  // 预算档位是跨公司的，应该保留——否则比价时两家用的是两套偏好
  assert.equal(other.answered.budgetBand, "premium");
});

test("储物偏好真的改变排布结果", async () => {
  const drawersIn = async (storage: string) => {
    const { floorPlanId, conversationId } = await readyProject(CONSUMER);
    await req(`/api/conversations/${conversationId}/preferences`, {
      method: "POST", accountId: CONSUMER,
      body: JSON.stringify({ companyId: "co_pilot", storage }),
    });
    const body = await (await req(`/api/floorplans/${floorPlanId}/layout`, {
      method: "POST", accountId: CONSUMER, body: JSON.stringify({ companyId: "co_pilot" }),
    })).json() as { moduleCounts: { moduleCode: string; qty: number }[] };
    return body.moduleCounts
      .filter((m) => /^\dDB/i.test(m.moduleCode))
      .reduce((n, m) => n + m.qty, 0);
  };

  assert.ok(await drawersIn("drawers") > await drawersIn("doors"),
    "选了「尽量多做抽屉」就该排出更多抽屉柜");
});

test("选过门板后出报价不必再传 doorStyleId", async () => {
  const { conversationId, layout } = await readyProject(CONSUMER);
  await req(`/api/conversations/${conversationId}/preferences`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ companyId: "co_pilot", doorStyleId: "ds_navy" }),
  });
  const r = await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId, selections: layout.selections,
    }),
  });
  assert.equal(r.status, 201, await r.clone().text());
  const { quote } = await r.json() as { quote: { doorStyleId: string; priceGroupId: string } };
  assert.equal(quote.doorStyleId, "ds_navy");
  assert.equal(quote.priceGroupId, "pg_prem", "Navy 属高档价格组");
});

test("五金偏好进报价，且只加到适用柜体上", async () => {
  const { conversationId, floorPlanId } = await readyProject(CONSUMER);
  await req(`/api/conversations/${conversationId}/preferences`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", doorStyleId: "ds_shaker_white",
      hardwareOptionIds: ["hw_softclose"], accessoryOptionIds: ["ac_rollout"],
    }),
  });
  const layoutBody = await (await req(`/api/floorplans/${floorPlanId}/layout`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ companyId: "co_pilot" }),
  })).json() as {
    selections: { moduleId: string; hardwareOptionIds: string[]; accessoryOptionIds: string[] }[];
  };

  // 五金对所有**柜型**适用；填缝条/踢脚板不是柜体，不该配铰链
  const cabinetSel = layoutBody.selections.filter(
    (s) => /^m_(b|w|sb|lsb|pc|tp)/i.test(s.moduleId) && !/^m_(bf|wf|tk|leg|bep|wep)/i.test(s.moduleId));
  assert.ok(cabinetSel.length > 0);
  assert.ok(cabinetSel.every((s) => s.hardwareOptionIds.includes("hw_softclose")));
  const trimSel = layoutBody.selections.filter((s) => /^m_(bf|wf|tk|leg|bep|wep)/i.test(s.moduleId));
  assert.ok(trimSel.every((s) => s.hardwareOptionIds.length === 0),
    "给填缝条配 soft-close 铰链是没有意义的");
  const wall = layoutBody.selections.find((s) => s.moduleId.startsWith("m_w"));
  if (wall) assert.deepEqual(wall.accessoryOptionIds, [], "吊柜装不了抽拉层板");

  // 关键：带着这些偏好出报价必须通过 FR-8 校验，不能被整单拒绝
  const r = await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId, selections: layoutBody.selections,
    }),
  });
  assert.equal(r.status, 201, await r.clone().text());
  const { quote } = await r.json() as {
    quote: { lineItems: { modifiers: { refId: string }[] }[] };
  };
  assert.ok(quote.lineItems.some((l) => l.modifiers.some((m) => m.refId === "hw_softclose")));
});

test("对话回复里带上本轮的选择题", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const r = await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "@枫岭橱柜 你们有什么门板？" }),
  });
  const body = await r.json() as {
    questions: { key: string; options: unknown[] }[]; questionCompanyId: string;
  };
  assert.equal(body.questionCompanyId, "co_pilot");
  assert.ok(body.questions.length > 0);
  assert.ok(body.questions.every((q) => q.options.length > 0), "不出没有选项的题");
});

// ── 户型特征录入（窗/上下水）—— 没有它就永远排不出水槽柜 ──────────────────

test("客户能补充窗户与上下水位置，排布据此放水槽柜", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const { floorPlan } = await fpRes.json() as { floorPlan: { id: string } };
  const added = await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ addRun: { label: "北墙", length: 144 } }),
  });
  const runId = (await added.json() as {
    floorPlan: { parsedGeometry: { wallRuns: { id: string }[] } };
  }).floorPlan.parsedGeometry.wallRuns[0]!.id;
  await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ ceilingHeight: 96 }),
  });

  // 先推迟上下水，才能进入阶段；后面再补特征验证水槽柜
  await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      text: "Modern style, budget CAD $10–20k, Ontario ON. Plumbing later. No windows. Appliances later.",
    }),
  });
  // 走阶段：点头 → 俯视图 → 认可
  const stage = async () => {
    await advance(conversation.id, CONSUMER, "consent");
    await req(`/api/floorplans/${floorPlan.id}/plan-view`, {
      method: "POST", accountId: CONSUMER, body: JSON.stringify({ companyId: "co_pilot" }),
    });
    await advance(conversation.id, CONSUMER, "approvePlan");
  };
  await stage();

  // 没有上下水时排不出水槽柜
  const before = await (await req(`/api/floorplans/${floorPlan.id}/layout`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ companyId: "co_pilot" }),
  })).json() as { moduleCounts: { moduleCode: string }[] };
  assert.ok(!before.moduleCounts.some((m) => m.moduleCode.startsWith("SB")),
    "没告诉系统上下水在哪时，排不出水槽柜");

  // 补上窗与上下水
  for (const f of [
    { kind: "window", offset: 54, width: 36 },
    { kind: "plumbing", offset: 60, width: 24 },
  ]) {
    const r = await req(`/api/floorplans/${floorPlan.id}/resolve`, {
      method: "POST", accountId: CONSUMER,
      body: JSON.stringify({ addFeature: { wallRunId: runId, ...f } }),
    });
    assert.equal(r.status, 200, await r.clone().text());
  }

  const after = await (await req(`/api/floorplans/${floorPlan.id}/layout`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ companyId: "co_pilot" }),
  })).json() as {
    moduleCounts: { moduleCode: string }[];
    explanation: { perRun: { text: string }[] };
  };
  assert.ok(after.moduleCounts.some((m) => m.moduleCode.startsWith("SB")),
    "补上上下水后应该排出水槽柜");
  // 解释里应当提到水槽与窗的关系
  assert.match(after.explanation.perRun[0]!.text, /Sink|水槽/i);
});

test("超出墙长或缺字段的特征被拒", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  const fpRes = await req(`/api/conversations/${conversation.id}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const { floorPlan } = await fpRes.json() as { floorPlan: { id: string } };
  const added = await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ addRun: { label: "北墙", length: 100 } }),
  });
  const runId = (await added.json() as {
    floorPlan: { parsedGeometry: { wallRuns: { id: string }[] } };
  }).floorPlan.parsedGeometry.wallRuns[0]!.id;

  const tooFar = await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ addFeature: { wallRunId: runId, kind: "window", offset: 90, width: 36 } }),
  });
  assert.equal(tooFar.status, 400);
  assert.match((await tooFar.json() as { error: string }).error, /outside|超出了/i);

  const badRun = await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ addFeature: { wallRunId: "wr_nope", kind: "window", offset: 0, width: 36 } }),
  });
  assert.equal(badRun.status, 400);

  const noWidth = await req(`/api/floorplans/${floorPlan.id}/resolve`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ addFeature: { wallRunId: runId, kind: "window", offset: 0, width: 0 } }),
  });
  assert.equal(noWidth.status, 400);
});

test("组装偏好套到不提供该形式的柜体上时不再整单被拒", async () => {
  const { conversationId, floorPlanId } = await readyProject(CONSUMER);
  await req(`/api/conversations/${conversationId}/preferences`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", doorStyleId: "ds_shaker_white", assembly: "assembled",
    }),
  });
  const layout = await (await req(`/api/floorplans/${floorPlanId}/layout`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ companyId: "co_pilot" }),
  })).json() as {
    selections: { moduleId: string; assembly: string }[];
    unappliedPreferences: string[];
  };

  // 吊柜只提供 RTA，不能被强行改成 assembled
  const wall = layout.selections.find((s) => s.moduleId.startsWith("m_w"));
  if (wall) assert.equal(wall.assembly, "RTA");
  assert.ok(layout.unappliedPreferences.length > 0, "没落实的偏好要如实说明");

  const r = await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId, selections: layout.selections,
    }),
  });
  assert.equal(r.status, 201, await r.clone().text());
});

test("助手不会连着问同一个问题两遍", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };

  const say = async (text: string) => {
    const r = await req(`/api/conversations/${conversation.id}/messages`, {
      method: "POST", accountId: CONSUMER, body: JSON.stringify({ text }),
    });
    return await r.json() as {
      replies: { content: string }[];
      questions?: unknown[];
      quickReplies?: unknown[];
    };
  };

  const first = await say("多伦多，一字型厨房，12 尺");
  // 客户答了风格，但用的是我们关键词表里没有的说法
  const second = await say("想要质感好一点的，门板选深色");

  const firstText = first.replies[0]!.content;
  const secondText = second.replies[0]!.content;
  assert.notEqual(secondText, firstText, "同样的问题不能原样再问一遍");
  // 无模型时走「改用选择题」话术；有模型时至少换话题或给出可点选项，不能复读上一轮
  assert.ok(
    /没问清楚|直接选|I may not have asked|pick below/i.test(secondText)
      || (second.questions?.length ?? 0) > 0
      || (second.quickReplies?.length ?? 0) > 0
      || secondText !== firstText,
    secondText,
  );
});

// ── 公司侧租户隔离：先证明身份，再按身份过滤 ──────────────────────────────

test("公司侧端点没有令牌一律拒绝 —— 隔离不能靠 URL 里的 companyId", async () => {
  // 原来的实现只用 TenantScope 按 URL 里的 companyId 过滤，
  // 而那个 id 是调用方自己填的：换一个 id 就能读到别家的计费事件。
  for (const [p, init] of [
    ["/api/company/co_pilot/billing", {}],
    ["/api/company/co_pilot/billing/disputes", {}],
    ["/api/company/co_pilot/billing/evt_x/dispute", { method: "POST" }],
  ] as [string, RequestInit][]) {
    const r = await req(p, init);
    assert.equal(r.status, 401, `${p} 不该在无令牌时放行`);
    assert.match((await r.json() as { error: string }).error, /X-Company-Token/);
  }
});

test("拿 A 公司的令牌读不到 B 公司的数据", async () => {
  // 用固定数据目录，好让测试能读到与 app 实例同一批公司的令牌
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const nodePath = await import("node:path");
  const dataDir = mkdtempSync(nodePath.join(tmpdir(), "rta-tenant-"));

  const mod = await import("../src/server.js");
  const app2 = await mod.createApp({ dataDir, llm: undefined });

  const { openRepositories } = await import("../src/store/repositories.js");
  const repos = openRepositories(dataDir);
  const pilotToken = repos.companies.byId("co_pilot")?.accessToken;
  const lakesideToken = repos.companies.byId("co_lakeside")?.accessToken;

  assert.ok(pilotToken, "种子应为每家公司发令牌");
  assert.ok(lakesideToken);
  assert.notEqual(pilotToken, lakesideToken, "每家公司应有各自的令牌");

  const raw = (p: string, headers: Record<string, string>) =>
    app2.fetch(new Request(base + p, { headers: { "content-type": "application/json", ...headers } }));

  assert.equal((await raw("/api/company/co_pilot/billing",
    { "x-company-token": pilotToken! })).status, 200, "自家令牌读自家数据应放行");
  assert.equal((await raw("/api/company/co_pilot/billing",
    { "x-company-token": lakesideToken! })).status, 401, "别家的令牌不能读本家数据");
  assert.equal((await raw("/api/company/co_lakeside/billing",
    { "x-company-token": pilotToken! })).status, 401);
});

test("公司目录不暴露访问令牌", async () => {
  const raw = await (await req("/api/companies")).text();
  assert.ok(!raw.includes("accessToken"), "令牌绝不能出现在客户可达的端点上");
});

test("运营令牌可以代公司操作（客服场景），但不存在的公司仍是 404", async () => {
  const ok = await req("/api/company/co_pilot/billing", {
    headers: { "x-admin-token": "test-admin-token", "content-type": "application/json" },
  });
  assert.equal(ok.status, 200);

  const missing = await req("/api/company/co_nope/billing", {
    headers: { "x-admin-token": "test-admin-token", "content-type": "application/json" },
  });
  assert.equal(missing.status, 404);
});

test("不存在的公司与令牌不对返回同样的说法 —— 不让人枚举出有哪些公司", async () => {
  const wrongToken = await req("/api/company/co_pilot/billing", {
    headers: { "x-company-token": "not-the-token", "content-type": "application/json" },
  });
  const noSuchCompany = await req("/api/company/co_totally_fake/billing", {
    headers: { "x-company-token": "not-the-token", "content-type": "application/json" },
  });
  assert.equal(wrongToken.status, 401);
  assert.equal(noSuchCompany.status, 401);
  assert.deepEqual(await wrongToken.json(), await noSuchCompany.json());
});
