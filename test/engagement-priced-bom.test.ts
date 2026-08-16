/**
 * 厂商会话的产品清单加价格栏（4/4 阶段）：只展示主会话已出的报价，不触发生成。
 * engagementConfirmedPayload -> pricedProductListFor 按 conversationId + companyId
 * 找该厂商最新一份报价；没有报价时是 undefined，前端提示"还没有报价"。
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

type PricedProductList = {
  quoteId: string;
  currency: string;
  lineItems: { moduleCode: string; qty: number; lineSubtotal: number }[];
  subtotal: number;
  total: number;
} | undefined;

async function openEngagement(conversationId: string, companyId: string) {
  const r = await req(`/api/conversations/${conversationId}/engagements`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ companyId }),
  });
  assert.ok(r.status === 200 || r.status === 201, await r.clone().text());
  const body = await r.json() as { engagement: { id: string } };
  return body.engagement.id;
}

async function getEngagementConfirmed(conversationId: string, eid: string) {
  const r = await req(`/api/conversations/${conversationId}/engagements/${eid}`, { accountId: CONSUMER });
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json() as { confirmed: { pricedProductList: PricedProductList } };
  return body.confirmed;
}

test("厂商还没出报价：pricedProductList 是 undefined，不是空数组", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "厨房翻新想找 Pilot" }),
  });

  const eid = await openEngagement(conversation.id, "co_pilot");
  const confirmed = await getEngagementConfirmed(conversation.id, eid);
  assert.equal(confirmed.pricedProductList, undefined);
});

test("主会话对某厂商出过报价后，对应 engagement 能看到带价格的产品清单", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "厨房翻新想找 Pilot" }),
  });
  const eid = await openEngagement(conversation.id, "co_pilot");

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
  const { quote } = await quoteRes.json() as {
    quote: { id: string; total: number; subtotal: number; lineItems: unknown[] };
  };

  const confirmed = await getEngagementConfirmed(conversation.id, eid);
  const list = confirmed.pricedProductList;
  assert.ok(list, "对应厂商出过报价后 pricedProductList 不该是 undefined");
  assert.equal(list!.quoteId, quote.id);
  assert.equal(list!.total, quote.total);
  assert.equal(list!.subtotal, quote.subtotal);
  assert.equal(list!.lineItems.length, quote.lineItems.length);
  assert.ok(list!.lineItems.every((l) => l.lineSubtotal > 0), "每行都该有正的行小计");
});

test("换一家没出过报价的厂商：即便同会话对另一家出过报价，这家仍是 undefined", async () => {
  const convRes = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await convRes.json() as { conversation: { id: string } };
  await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "厨房翻新，先看看几家" }),
  });

  await req("/api/quotes", {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({
      companyId: "co_pilot", conversationId: conversation.id, doorStyleId: "ds_shaker_white",
      selections: [
        { moduleId: "m_b30", qty: 2, width: 30, height: 34.5, depth: 24, assembly: "RTA", hardwareOptionIds: [], accessoryOptionIds: [] },
      ],
    }),
  });

  const otherEid = await openEngagement(conversation.id, "co_oppein");
  const confirmed = await getEngagementConfirmed(conversation.id, otherEid);
  assert.equal(confirmed.pricedProductList, undefined,
    "报价按 companyId 隔离——别家厂商的报价不该泄露到这家的产品清单里");
});
