/**
 * Debug pull engagement bug + brief alignment probe.
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
const PILOT = "co_pilot";
const base = "http://localhost";

function req(pathname: string, init: RequestInit & { accountId?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.accountId) headers.set("x-account-id", init.accountId);
  return app.fetch(new Request(base + pathname, { ...init, headers }));
}

test("pull latest after open returns 200", async () => {
  const created = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await created.json() as { conversation: { id: string } };
  await req(`/api/conversations/${conversation.id}/preferences`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ companyId: PILOT, doorStyleId: "ds_shaker_white", storage: "balanced" }),
  });
  const open = await req(`/api/conversations/${conversation.id}/engagements`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ companyId: PILOT }),
  });
  assert.equal(open.status, 201);
  const { engagement } = await open.json() as { engagement: { id: string } };

  const pull = await req(
    `/api/conversations/${conversation.id}/engagements/${engagement.id}/pull`,
    { method: "POST", accountId: CONSUMER },
  );
  const body = await pull.json() as {
    engagement: { handoff: { revision: number; requirementsDigest?: string } };
    confirmed: { designBrief?: { sections?: unknown[] } };
  };
  assert.equal(pull.status, 200, JSON.stringify(body));
  assert.ok(body.engagement.handoff.revision >= 2);
  assert.ok(body.confirmed.designBrief?.sections?.length);

  // 错会话 id + 正确 eid 仍应能 pull（容错）
  const other = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation: otherConv } = await other.json() as { conversation: { id: string } };
  const pull2 = await req(
    `/api/conversations/${otherConv.id}/engagements/${engagement.id}/pull`,
    { method: "POST", accountId: CONSUMER },
  );
  assert.equal(pull2.status, 200, await pull2.clone().text());
});
