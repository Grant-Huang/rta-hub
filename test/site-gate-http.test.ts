/**
 * 整站口令在真实请求上的行为。
 *
 * 单独一个文件，因为它需要在 `createApp` **之前**设置 `SITE_PASSWORD`——
 * 与 http.test.ts 共用一个进程会互相干扰。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.SITE_PASSWORD = "preview-only-hunter2";
process.env.ADMIN_TOKEN = "test-admin-token";
process.env.SMTP_HOST = "";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";

let app: { fetch: (req: Request) => Response | Promise<Response> };
const base = "http://localhost";

before(async () => {
  const mod = await import("../src/server.js");
  app = await mod.createApp({ ephemeral: true, llm: undefined });
});

function req(pathname: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", init.headers && "content-type" in (init.headers as object)
    ? (init.headers as Record<string, string>)["content-type"]! : "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return app.fetch(new Request(base + pathname, { ...init, headers, redirect: "manual" }));
}

async function unlock(password: string) {
  const r = await app.fetch(new Request(`${base}/__unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
    redirect: "manual",
  }));
  return { res: r, cookie: r.headers.get("set-cookie") ?? "" };
}

test("没有 cookie 时页面返回登录页，API 返回 401", async () => {
  const page = await req("/");
  assert.equal(page.status, 401);
  assert.match(await page.text(), /Access password|访问口令/i);

  const api = await req("/api/companies");
  assert.equal(api.status, 401);
  assert.equal((await api.json() as { code: string }).code, "SITE_LOCKED");
});

test("带账号头也绕不过整站口令——外层闸门在账号鉴权之前", async () => {
  const r = await req("/api/conversations", {
    method: "POST", headers: { "x-account-id": "ca_demo_consumer", "content-type": "application/json" },
  });
  assert.equal(r.status, 401);
  assert.equal((await r.json() as { code: string }).code, "SITE_LOCKED");
});

test("管理端点同样被挡在外面（两道锁是叠加的）", async () => {
  const r = await req("/api/admin/mention-signals", {
    headers: { "x-admin-token": "test-admin-token", "content-type": "application/json" },
  });
  assert.equal(r.status, 401);
  assert.equal((await r.json() as { code: string }).code, "SITE_LOCKED");
});

test("健康检查免于口令——部署平台不必知道密码", async () => {
  const r = await req("/health");
  assert.equal(r.status, 200);
});

test("退订链接免于口令 —— CASL 要求退订真的能用", async () => {
  // 无效 token 会返回 400，但**不是** 401：说明请求确实到了业务逻辑，没被口令挡下
  const r = await req("/unsubscribe?token=whatever");
  assert.notEqual(r.status, 401);
  assert.match(await r.text(), /unsubscribed|unsubscribe|退订/i);
});

test("口令错误不放行，且不泄露细节", async () => {
  const { res } = await unlock("wrong-password");
  assert.equal(res.status, 401);
  const html = await res.text();
  assert.match(html, /Incorrect password|口令不正确/i);
  // 不该把正确口令、长度之类的信息漏出去
  assert.ok(!html.includes("preview-only-hunter2"));
});

test("口令正确后签发 cookie，之后能正常访问", async () => {
  const { res, cookie } = await unlock("preview-only-hunter2");
  assert.equal(res.status, 303);
  assert.match(cookie, /rta_site=/);
  assert.match(cookie, /HttpOnly/);

  const jar = cookie.split(";")[0]!;
  const api = await req("/api/companies", { cookie: jar });
  assert.equal(api.status, 200);
  const body = await api.json() as { companies: unknown[] };
  assert.ok(body.companies.length > 0);

  // 页面也放行了
  assert.equal((await req("/", { cookie: jar })).status, 200);
});

test("伪造的 cookie 不放行", async () => {
  for (const forged of [
    "rta_site=garbage",
    `rta_site=${Date.now() + 86400000}.deadbeef`,
    "rta_site=",
  ]) {
    const r = await req("/api/companies", { cookie: forged });
    assert.equal(r.status, 401, `${forged} 不该被放行`);
  }
});

test("过了整站口令之后，账号鉴权仍然照常生效", async () => {
  const { cookie } = await unlock("preview-only-hunter2");
  const jar = cookie.split(";")[0]!;

  // 有口令、没账号头 → 仍然 401（这次是账号层拒的）
  const noAccount = await req("/api/conversations", { method: "POST", cookie: jar });
  assert.equal(noAccount.status, 401);
  assert.match((await noAccount.json() as { error: string }).error, /X-Account-Id/);

  // 有口令 + 有效账号 → 通过
  const ok = await app.fetch(new Request(`${base}/api/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json", "cookie": jar, "x-account-id": "ca_demo_consumer" },
  }));
  assert.equal(ok.status, 201);

  // 管理端点仍然要自己的令牌——整站口令不替代它
  const noAdmin = await req("/api/admin/mention-signals", { cookie: jar });
  assert.equal(noAdmin.status, 401);
  assert.match((await noAdmin.json() as { error: string }).error, /X-Admin-Token/);
});
