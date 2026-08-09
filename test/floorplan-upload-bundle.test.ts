/**
 * 户型附件一次请求：文字 + 多文件（UI_SHELL_REDESIGN S5）。
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

async function createConversation(accountId = CONSUMER): Promise<string> {
  const r = await req("/api/conversations", { method: "POST", accountId });
  assert.equal(r.status, 201);
  const body = await r.json() as { conversation: { id: string } };
  return body.conversation.id;
}

test("text + 两个文件一次 POST → 201，用户消息含文字与两个文件名，助手有解读", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/floorplan`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({
      text: "这是我们的厨房，请看两张图",
      files: [
        {
          fileName: "kitchen-a.png",
          mimeType: "image/png",
          sizeBytes: 12,
          image: "aaa",
        },
        {
          fileName: "kitchen-b.pdf",
          mimeType: "application/pdf",
          sizeBytes: 20,
          image: "bbb",
        },
      ],
    }),
  });
  assert.equal(r.status, 201, await r.clone().text());
  const body = await r.json() as {
    floorPlan: { id: string; conversationId: string };
    interpretation: string;
    replies: { role: string; content: string }[];
  };
  assert.ok(body.floorPlan?.id);
  assert.equal(body.floorPlan.conversationId, id);
  assert.ok(body.interpretation);
  assert.ok(body.replies?.length >= 1);
  assert.equal(body.replies[0]!.role, "assistant");
  assert.ok(body.replies[0]!.content.length > 0);

  const get = await req(`/api/conversations/${id}`, { accountId: CONSUMER });
  assert.equal(get.status, 200);
  const conv = await get.json() as {
    conversation: { messages: { role: string; content: string }[] };
  };
  const userMsg = [...conv.conversation.messages].reverse()
    .find((m) => m.role === "user");
  assert.ok(userMsg);
  assert.ok(userMsg.content.includes("这是我们的厨房，请看两张图"));
  assert.ok(userMsg.content.includes("kitchen-a.png"));
  assert.ok(userMsg.content.includes("kitchen-b.pdf"));

  const assistantMsg = [...conv.conversation.messages].reverse()
    .find((m) => m.role === "assistant");
  assert.ok(assistantMsg);
  assert.ok(assistantMsg.content.length > 0);
});

test("显式空 files 数组 → 400", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/floorplan`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ text: "只有文字", files: [] }),
  });
  assert.equal(r.status, 400);
});
