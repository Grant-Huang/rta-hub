/**
 * /api/me/profile capabilities + GET /me（UI_SHELL_REDESIGN S3）。
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
const ADMIN = "ca_demo_admin";
const TRADE = "ca_demo_trade";
const base = "http://localhost";

function req(pathname: string, init: RequestInit & { accountId?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.accountId) headers.set("x-account-id", init.accountId);
  return app.fetch(new Request(base + pathname, { ...init, headers }));
}

test("consumer profile：capabilities.adminConsole / trainer 为 false", async () => {
  const r = await req("/api/me/profile", { accountId: CONSUMER });
  assert.equal(r.status, 200);
  const body = await r.json() as {
    displayName: string;
    email: string;
    province: string;
    capabilities: { adminConsole: boolean; trainer: boolean };
  };
  assert.equal(body.displayName, "Alex");
  assert.equal(body.email, "alex@example.com");
  assert.equal(body.province, "ON");
  assert.equal(body.capabilities.adminConsole, false);
  assert.equal(body.capabilities.trainer, false);
});

test("ca_demo_admin：capabilities.adminConsole / trainer 为 true", async () => {
  const r = await req("/api/me/profile", { accountId: ADMIN });
  assert.equal(r.status, 200);
  const body = await r.json() as {
    displayName: string;
    email: string;
    capabilities: { adminConsole: boolean; trainer: boolean };
  };
  assert.equal(body.displayName, "Platform Ops");
  assert.equal(body.email, "ops@example.com");
  assert.equal(body.capabilities.adminConsole, true);
  assert.equal(body.capabilities.trainer, true);
});

test("trade profile 带 companyName，capabilities 仍为 false", async () => {
  const r = await req("/api/me/profile", { accountId: TRADE });
  assert.equal(r.status, 200);
  const body = await r.json() as {
    companyName?: string;
    capabilities: { adminConsole: boolean; trainer: boolean };
  };
  assert.equal(body.companyName, "Riverside Builders Ltd");
  assert.equal(body.capabilities.adminConsole, false);
  assert.equal(body.capabilities.trainer, false);
});

test("GET /me 返回用户页 HTML", async () => {
  const r = await req("/me");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes("/api/me/profile"));
  assert.ok(html.includes("ca_demo_admin"));
  assert.ok(html.includes("/admin/trainer"));
  assert.ok(html.includes("companyLinks") || html.includes("/api/companies"));
});

test("GET /company/:id 返回厂商工作台 HTML（含 Oppein）", async () => {
  const r = await req("/company/co_oppein");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes("x-company-token") || html.includes("X-Company-Token") || html.includes("companyToken"));
  assert.ok(html.includes("co_oppein") || html.includes("companyId"));
});

test("公开公司目录含 Oppein Canada", async () => {
  const r = await req("/api/companies");
  assert.equal(r.status, 200);
  const body = await r.json() as { companies: { id: string; name: string }[] };
  const oppein = body.companies.find((c) => c.id === "co_oppein");
  assert.ok(oppein, "co_oppein missing from active directory");
  assert.match(oppein.name, /Oppein/i);
});
