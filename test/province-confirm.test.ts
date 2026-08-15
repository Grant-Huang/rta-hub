/**
 * Phase 4：省份从"账号默认值=已确认"改成"建议值，需要客户明确确认"，
 * 并可在已确认面板用下拉框改（走跟风格/预算共用的 /preferences 接口）。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.SMTP_HOST = "";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";
process.env.ADMIN_TOKEN = "test-admin-token";

let app: { fetch: (req: Request) => Response | Promise<Response> };
const base = "http://localhost";
const CONSUMER = "ca_demo_consumer"; // seed.ts: province "ON"

before(async () => {
  const mod = await import("../src/server.js");
  app = await mod.createApp({ ephemeral: true, llm: undefined });
});

function req(pathname: string, init: RequestInit & { accountId?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.accountId) headers.set("x-account-id", init.accountId);
  return app.fetch(new Request(base + pathname, { ...init, headers }));
}

async function json<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

interface ConfirmedFact {
  key: string;
  value: string;
  status: string;
  editTarget?: { kind: string; currentCode?: string };
}
interface ConvGetResponse {
  designBrief: { confirmedFacts: ConfirmedFact[]; openItems: { id: string; status: string }[] };
}

test("账号有默认省份，但从未在对话里确认——已确认面板显示 needs_confirm，带下拉编辑入口", async () => {
  const created = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await json<{ conversation: { id: string } }>(created);

  const snap = await json<ConvGetResponse>(
    await req(`/api/conversations/${conversation.id}`, { accountId: CONSUMER }),
  );
  const province = snap.designBrief.confirmedFacts.find((f) => f.key === "province");
  assert.ok(province, "账号有默认省份时，province 事实行应该出现（即便未确认）");
  assert.equal(province!.status, "needs_confirm");
  assert.equal(province!.editTarget?.kind, "province");
  assert.equal(province!.editTarget?.currentCode, "ON");
  assert.ok(
    snap.designBrief.openItems.some((i) => i.id === "province"),
    "未确认的省份应出现在待办项里",
  );
});

test("用已确认面板的下拉框改省份——走 /preferences，不需要先聊天提过", async () => {
  const created = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await json<{ conversation: { id: string } }>(created);

  const save = await req(`/api/conversations/${conversation.id}/preferences`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ companyId: "", province: "BC" }),
  });
  assert.equal(save.status, 200, await save.clone().text());

  const snap = await json<ConvGetResponse>(
    await req(`/api/conversations/${conversation.id}`, { accountId: CONSUMER }),
  );
  const province = snap.designBrief.confirmedFacts.find((f) => f.key === "province");
  assert.equal(province!.status, "ok");
  assert.match(province!.value, /British Columbia|BC/);
  assert.equal(province!.editTarget?.currentCode, "BC", "下拉编辑应回显改后的值，不是账号默认值");
  assert.ok(!snap.designBrief.openItems.some((i) => i.id === "province"));
});

test("非法省码被 /preferences 拒绝", async () => {
  const created = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await json<{ conversation: { id: string } }>(created);

  const save = await req(`/api/conversations/${conversation.id}/preferences`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ companyId: "", province: "XX" }),
  });
  assert.equal(save.status, 400);
});

test("客户在聊天里直接说出省份——同样算已确认，不需要走下拉框", async () => {
  const created = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await json<{ conversation: { id: string } }>(created);

  await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: "We're located in Quebec QC." }),
  });

  const snap = await json<ConvGetResponse>(
    await req(`/api/conversations/${conversation.id}`, { accountId: CONSUMER }),
  );
  const province = snap.designBrief.confirmedFacts.find((f) => f.key === "province");
  assert.equal(province!.status, "ok");
  assert.match(province!.value, /Quebec|QC/);
});
