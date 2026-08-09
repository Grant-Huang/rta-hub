/**
 * FR-21/22：训练 / 知识 admin HTTP。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.SITE_PASSWORD_DISABLED = "true";
process.env.ADMIN_TOKEN = "test-admin-token";

let app: { fetch: (req: Request) => Response | Promise<Response> };
const ADMIN = "test-admin-token";

before(async () => {
  const mod = await import("../src/server.js");
  app = await mod.createApp({ ephemeral: true, llm: undefined });
});

function headers(extra: Record<string, string> = {}) {
  return { "content-type": "application/json", "x-admin-token": ADMIN, ...extra };
}

async function req(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://test${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers as Record<string, string> | undefined) },
  }));
}

test("trainer conversation: stove message → draft cards → publish → overlays", async () => {
  const create = await req("/api/admin/trainer/conversations", { method: "POST", body: "{}" });
  assert.equal(create.status, 201);
  const created = await create.json() as { data: { conversation: { id: string } } };
  const id = created.data.conversation.id;

  const msg = await req(`/api/admin/trainer/conversations/${id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      text: "通常不需要灶台柜，北美 stove 通常跟烤箱一体，而且有标准尺寸。",
    }),
  });
  assert.equal(msg.status, 200);
  const body = await msg.json() as {
    data: { proposedCards: { id: string; settleTarget: string }[] };
  };
  assert.ok(body.data.proposedCards.length >= 2);

  const cardId = body.data.proposedCards.find((c) => c.settleTarget.startsWith("config."))!.id;
  // confirm then publish (publishCard allows draft→publish too)
  await req(`/api/admin/knowledge/${cardId}`, {
    method: "PATCH",
    body: JSON.stringify({ confirm: true }),
  });
  const pub = await req(`/api/admin/knowledge/${cardId}/publish`, { method: "POST", body: "{}" });
  assert.equal(pub.status, 200);

  const ov = await req("/api/admin/knowledge/overlays");
  assert.equal(ov.status, 200);
  const ovBody = await ov.json() as { data: { overlays: { layoutHeuristic?: { preferNoCooktopBase?: boolean }; appliance?: { preferNoCooktopBase?: boolean } } } };
  assert.equal(
    Boolean(ovBody.data.overlays.layoutHeuristic?.preferNoCooktopBase
      || ovBody.data.overlays.appliance?.preferNoCooktopBase),
    true,
  );
});

test("customer cannot list knowledge cards via admin API", async () => {
  const r = await app.fetch(new Request("http://test/api/admin/knowledge", {
    headers: { "x-account-id": "ca_demo_consumer", "content-type": "application/json" },
  }));
  assert.equal(r.status, 401);
});
