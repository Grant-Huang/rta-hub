/**
 * 示例图静态路由 + 开场 intakeSamples。
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

test("GET /samples/sample-design-sketch.jpg → image/jpeg", async () => {
  const r = await req("/samples/sample-design-sketch.jpg");
  assert.equal(r.status, 200);
  assert.ok((r.headers.get("content-type") || "").includes("jpeg"));
  const buf = Buffer.from(await r.arrayBuffer());
  assert.ok(buf.length > 1000);
});

test("GET /samples/sample-floorplan-minimal.png → image/png", async () => {
  const r = await req("/samples/sample-floorplan-minimal.png");
  assert.equal(r.status, 200);
  assert.ok((r.headers.get("content-type") || "").includes("png"));
});

test("非法 sample 名 → 404", async () => {
  const r = await req("/samples/../../.env");
  assert.equal(r.status, 404);
});

test("新会话 welcome 优先户型，并返回 intakeSamples", async () => {
  const create = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  assert.equal(create.status, 201);
  const { conversation } = await create.json() as { conversation: { id: string } };
  const get = await req(`/api/conversations/${conversation.id}`, { accountId: CONSUMER });
  assert.equal(get.status, 200);
  const body = await get.json() as {
    welcome: string;
    language: string;
    intakeSamples: { file: string; url: string }[];
  };
  assert.ok(body.welcome.includes("户型") || body.welcome.toLowerCase().includes("floor"));
  assert.ok(Array.isArray(body.intakeSamples));
  assert.ok(body.intakeSamples.some((s) => s.file === "sample-design-sketch.jpg"));
  assert.ok(body.intakeSamples.some((s) => s.url.startsWith("/samples/")));
});
