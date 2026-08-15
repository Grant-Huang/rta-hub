/**
 * 邮箱验证码登录（E1 第一步）—— 见 auth/session.ts + auth/email-otp.ts。
 *
 * 核心断言：拿到会话 cookie 之后，**不带** X-Account-Id 头也能读到自己的账号数据，
 * 这就是"同一个人在任何浏览器/设备上都能看到以往会话"的机制本身。
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearRateLimit } from "../src/app/site-gate.js";
import { resetLoginCodesForTest } from "../src/auth/email-otp.js";

process.env.SMTP_HOST = "";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";
process.env.SENDER_NAME = "RTA Hub";
process.env.SMTP_FROM = "quotes@rta-hub.test";
process.env.SENDER_PHONE = "+1-800-555-0100";

let app: { fetch: (req: Request) => Response | Promise<Response> };

before(async () => {
  const mod = await import("../src/server.js");
  app = await mod.createApp({ ephemeral: true, llm: undefined });
});

beforeEach(() => {
  clearRateLimit();
  resetLoginCodesForTest();
});

const base = "http://localhost";

function req(pathname: string, init: RequestInit & { cookie?: string; accountId?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.accountId) headers.set("x-account-id", init.accountId);
  return app.fetch(new Request(base + pathname, { ...init, headers }));
}

/** 从响应的 Set-Cookie 里摘出 `name=value`，去掉 Path/Max-Age 等属性，供下一个请求带上。 */
function cookieFrom(res: Response): string {
  const raw = res.headers.get("set-cookie");
  assert.ok(raw, "expected a Set-Cookie header");
  return raw!.split(";")[0]!;
}

test("没有 cookie/头，请求受保护端点 401", async () => {
  const r = await req("/api/conversations", { method: "GET" });
  assert.equal(r.status, 401);
});

test("请求验证码 → dry-run 下响应里带 devCode（本地没配 SMTP 时的唯一取回方式）", async () => {
  const r = await req("/api/auth/request-code", {
    method: "POST", body: JSON.stringify({ email: "new-customer@example.com" }),
  });
  assert.equal(r.status, 200);
  const body = await r.json() as { ok: boolean; devCode?: string };
  assert.equal(body.ok, true);
  assert.match(body.devCode ?? "", /^\d{6}$/);
});

test("验证码错误 → 401，不建号", async () => {
  await req("/api/auth/request-code", {
    method: "POST", body: JSON.stringify({ email: "wrong-code@example.com" }),
  });
  const r = await req("/api/auth/verify-code", {
    method: "POST", body: JSON.stringify({ email: "wrong-code@example.com", code: "000000" }),
  });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("set-cookie"), null);
});

test("验证码正确 → 建新账号、签发 cookie；仅凭这个 cookie（不带 X-Account-Id）就能读到自己的会话", async () => {
  const email = "alice-cross-device@example.com";
  const codeRes = await req("/api/auth/request-code", {
    method: "POST", body: JSON.stringify({ email }),
  });
  const { devCode } = await codeRes.json() as { devCode: string };

  const verifyRes = await req("/api/auth/verify-code", {
    method: "POST", body: JSON.stringify({ email, code: devCode }),
  });
  assert.equal(verifyRes.status, 200);
  const { account } = await verifyRes.json() as { account: { id: string; email: string } };
  assert.equal(account.email, email);

  const cookie = cookieFrom(verifyRes);

  // 关键断言：这次请求完全没有 X-Account-Id 头，只靠 cookie。
  const created = await req("/api/conversations", { method: "POST", cookie });
  assert.equal(created.status, 201);
  const { conversation } = await created.json() as { conversation: { id: string } };
  assert.ok(conversation.id);

  const list = await req("/api/conversations", { method: "GET", cookie });
  const { conversations } = await list.json() as { conversations: { id: string }[] };
  assert.ok(conversations.some((c) => c.id === conversation.id));
});

test("同一邮箱第二次登录复用同一账号，不重复建号", async () => {
  const email = "repeat-login@example.com";

  const code1 = await req("/api/auth/request-code", {
    method: "POST", body: JSON.stringify({ email }),
  });
  const { devCode: devCode1 } = await code1.json() as { devCode: string };
  const verify1 = await req("/api/auth/verify-code", {
    method: "POST", body: JSON.stringify({ email, code: devCode1 }),
  });
  const { account: account1 } = await verify1.json() as { account: { id: string } };

  const code2 = await req("/api/auth/request-code", {
    method: "POST", body: JSON.stringify({ email }),
  });
  const { devCode: devCode2 } = await code2.json() as { devCode: string };
  const verify2 = await req("/api/auth/verify-code", {
    method: "POST", body: JSON.stringify({ email, code: devCode2 }),
  });
  const { account: account2 } = await verify2.json() as { account: { id: string } };

  assert.equal(account1.id, account2.id);
});

test("/api/auth/me：无 cookie 返回 null，带合法 cookie 返回对应账号，登出后失效", async () => {
  const anon = await req("/api/auth/me");
  assert.deepEqual(await anon.json(), { account: null });

  const email = "me-endpoint@example.com";
  const codeRes = await req("/api/auth/request-code", {
    method: "POST", body: JSON.stringify({ email }),
  });
  const { devCode } = await codeRes.json() as { devCode: string };
  const verifyRes = await req("/api/auth/verify-code", {
    method: "POST", body: JSON.stringify({ email, code: devCode }),
  });
  const cookie = cookieFrom(verifyRes);

  const me = await req("/api/auth/me", { cookie });
  const meBody = await me.json() as { account: { email: string } | null };
  assert.equal(meBody.account?.email, email);

  const logout = await req("/api/auth/logout", { method: "POST", cookie });
  const logoutCookie = cookieFrom(logout);
  // 登出后再带着"新 cookie"（已被置空/过期）请求，应视为未登录
  const meAfter = await req("/api/auth/me", { cookie: logoutCookie });
  assert.deepEqual(await meAfter.json(), { account: null });
});

test("有效的会话 cookie 优先于（不匹配的）X-Account-Id 头——不能靠加个头跳到别的账号", async () => {
  const email = "priority-check@example.com";
  const codeRes = await req("/api/auth/request-code", {
    method: "POST", body: JSON.stringify({ email }),
  });
  const { devCode } = await codeRes.json() as { devCode: string };
  const verifyRes = await req("/api/auth/verify-code", {
    method: "POST", body: JSON.stringify({ email, code: devCode }),
  });
  const { account } = await verifyRes.json() as { account: { id: string } };
  assert.notEqual(account.id, "ca_demo_consumer");
  const cookie = cookieFrom(verifyRes);

  // 同一个请求既带真实登录 cookie，又带一个指向别的账号（demo 账号）的 X-Account-Id 头。
  const created = await req("/api/conversations", { method: "POST", cookie, accountId: "ca_demo_consumer" });
  assert.equal(created.status, 201);
  const { conversation } = await created.json() as { conversation: { id: string } };

  // 新建的会话必须挂在 cookie 对应的账号下……
  const viaCookie = await req("/api/conversations", { method: "GET", cookie });
  const { conversations: ownList } = await viaCookie.json() as { conversations: { id: string }[] };
  assert.ok(ownList.some((c) => c.id === conversation.id));

  // ……而不是挂在头里那个 demo 账号下——证明存在 cookie 时头被忽略，不能靠加个头跳账号。
  const viaHeaderOnly = await req("/api/conversations", { method: "GET", accountId: "ca_demo_consumer" });
  const { conversations: demoList } = await viaHeaderOnly.json() as { conversations: { id: string }[] };
  assert.ok(!demoList.some((c) => c.id === conversation.id));
});
