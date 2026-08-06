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

let app: { fetch: (req: Request) => Response | Promise<Response> };

before(async () => {
  ({ app } = await import("../src/server.js"));
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
  assert.equal(body.companies.length, 1);
  assert.equal(body.companies[0]!.id, "co_pilot");
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
