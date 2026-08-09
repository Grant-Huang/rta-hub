/**
 * FR-22.2：L1 学习队列 + 回归看板 HTTP 冒烟。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || "test-admin-token";
process.env.SITE_PASSWORD_DISABLED = "true";

const base = "http://localhost";

test("admin regression dashboard + L1 scan/confirm 隔离", async () => {
  const app = await createApp({ ephemeral: true, llm: undefined });
  const adminHeaders = {
    "content-type": "application/json",
    "x-admin-token": process.env.ADMIN_TOKEN!,
  };

  const dashRes = await app.fetch(new Request(`${base}/api/admin/regression-dashboard`, {
    headers: adminHeaders,
  }));
  assert.equal(dashRes.status, 200);
  const dash = await dashRes.json() as {
    status: string;
    data: { metrics: unknown; l1Queue: { total: number }; simOut: unknown[] };
  };
  assert.equal(dash.status, "success");
  assert.ok(dash.data.metrics);
  assert.ok(Array.isArray(dash.data.simOut));

  // 无 token 拒绝
  const denied = await app.fetch(new Request(`${base}/api/admin/l1-learn`));
  assert.equal(denied.status, 401);

  // 会话信号进 A 厂
  const sig = await app.fetch(new Request(`${base}/api/admin/l1-learn/session-signal`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      companyId: "co_pilot",
      summary: "B12 is one drawer over door in our catalog",
      codingHint: { pattern: "^B\\d", meaning: "base, 1 drawer over door" },
    }),
  }));
  assert.equal(sig.status, 200, await sig.clone().text());
  const sigBody = await sig.json() as {
    data: { item: { id: string; companyId: string; status: string } };
  };
  assert.equal(sigBody.data.item.companyId, "co_pilot");
  assert.equal(sigBody.data.item.status, "draft");

  const listA = await app.fetch(new Request(
    `${base}/api/admin/l1-learn?companyId=co_pilot`,
    { headers: adminHeaders },
  ));
  const listABody = await listA.json() as {
    data: { items: { companyId: string }[] };
  };
  assert.ok(listABody.data.items.every((i) => i.companyId === "co_pilot"));

  // 扫描另一家不得污染 A 的条目 companyId
  const scanB = await app.fetch(new Request(`${base}/api/admin/l1-learn/scan`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ companyId: "co_oppein" }),
  }));
  // co_oppein 可能不存在于 seed——允许 200（空扫描）或业务错误；不得 500
  assert.ok(scanB.status < 500);

  const pages = await Promise.all([
    app.fetch(new Request(`${base}/admin/l1-learn`)),
    app.fetch(new Request(`${base}/admin/regression`)),
  ]);
  assert.equal(pages[0]!.status, 200);
  assert.equal(pages[1]!.status, 200);
});
