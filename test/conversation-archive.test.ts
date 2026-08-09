/**
 * 会话存档 / 恢复 API（UI_SHELL_REDESIGN S1）。
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
const TRADE = "ca_demo_trade";
const base = "http://localhost";

function req(pathname: string, init: RequestInit & { accountId?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.accountId) headers.set("x-account-id", init.accountId);
  return app.fetch(new Request(base + pathname, { ...init, headers }));
}

async function createConversation(accountId = CONSUMER): Promise<string> {
  const r = await req("/api/conversations", { method: "POST", accountId });
  assert.equal(r.status, 201);
  const body = await r.json() as { conversation: { id: string; status?: string } };
  assert.equal(body.conversation.status ?? "active", "active");
  return body.conversation.id;
}

test("新建会话默认为 active，列表含 status 与 fullTitle", async () => {
  const id = await createConversation();
  await req(`/api/conversations/${id}/messages`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ text: "很长的一句话用来验证完整标题不会在列表里被截断丢失" }),
  });

  const list = await req("/api/conversations", { accountId: CONSUMER });
  assert.equal(list.status, 200);
  const body = await list.json() as {
    conversations: {
      id: string;
      title: string;
      fullTitle: string;
      status: string;
    }[];
  };
  const row = body.conversations.find((v) => v.id === id);
  assert.ok(row);
  assert.equal(row.status, "active");
  assert.equal(row.fullTitle, "很长的一句话用来验证完整标题不会在列表里被截断丢失");
  assert.ok(row.title.length <= 40);
  assert.ok(row.fullTitle.startsWith(row.title.slice(0, 10)));
});

test("存档后 status=archived，可恢复为 active", async () => {
  const id = await createConversation();

  const arch = await req(`/api/conversations/${id}/archive`, {
    method: "POST",
    accountId: CONSUMER,
  });
  assert.equal(arch.status, 200);
  const archBody = await arch.json() as {
    conversation: { id: string; status: string; archivedAt?: string };
  };
  assert.equal(archBody.conversation.status, "archived");
  assert.ok(archBody.conversation.archivedAt);

  const getArchived = await req(`/api/conversations/${id}`, { accountId: CONSUMER });
  assert.equal(getArchived.status, 200);
  const got = await getArchived.json() as { conversation: { status: string } };
  assert.equal(got.conversation.status, "archived");

  const list = await req("/api/conversations", { accountId: CONSUMER });
  const rows = (await list.json() as { conversations: { id: string; status: string }[] })
    .conversations;
  assert.equal(rows.find((v) => v.id === id)?.status, "archived");

  const unarch = await req(`/api/conversations/${id}/unarchive`, {
    method: "POST",
    accountId: CONSUMER,
  });
  assert.equal(unarch.status, 200);
  const unBody = await unarch.json() as { conversation: { status: string; archivedAt?: string } };
  assert.equal(unBody.conversation.status, "active");
  assert.equal(unBody.conversation.archivedAt, undefined);
});

test("archived 会话禁止发消息与上传户型（409）", async () => {
  const id = await createConversation();
  await req(`/api/conversations/${id}/archive`, { method: "POST", accountId: CONSUMER });

  const msg = await req(`/api/conversations/${id}/messages`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ text: "存档后不应发出" }),
  });
  assert.equal(msg.status, 409);
  const msgBody = await msg.json() as { code?: string };
  assert.equal(msgBody.code, "CONVERSATION_ARCHIVED");

  const fp = await req(`/api/conversations/${id}/floorplan`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({
      fileName: "x.png",
      mimeType: "image/png",
      sizeBytes: 4,
      image: "data:image/png;base64,xxxx",
    }),
  });
  assert.equal(fp.status, 409);

  await req(`/api/conversations/${id}/unarchive`, { method: "POST", accountId: CONSUMER });
  const again = await req(`/api/conversations/${id}/messages`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ text: "恢复后可以聊" }),
  });
  assert.equal(again.status, 200);
});

test("不能存档他人会话", async () => {
  const id = await createConversation(CONSUMER);
  const r = await req(`/api/conversations/${id}/archive`, {
    method: "POST",
    accountId: TRADE,
  });
  assert.equal(r.status, 404);
});

test("重复存档 / 对 active 恢复保持幂等语义", async () => {
  const id = await createConversation();
  assert.equal(
    (await req(`/api/conversations/${id}/archive`, { method: "POST", accountId: CONSUMER })).status,
    200,
  );
  assert.equal(
    (await req(`/api/conversations/${id}/archive`, { method: "POST", accountId: CONSUMER })).status,
    200,
  );
  const un1 = await req(`/api/conversations/${id}/unarchive`, {
    method: "POST",
    accountId: CONSUMER,
  });
  assert.equal(un1.status, 200);
  const un2 = await req(`/api/conversations/${id}/unarchive`, {
    method: "POST",
    accountId: CONSUMER,
  });
  assert.equal(un2.status, 200);
  const body = await un2.json() as { conversation: { status: string } };
  assert.equal(body.conversation.status, "active");
});
