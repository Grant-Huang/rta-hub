/**
 * Phase 4：客户在聊天里想改已经确认的数据时，委婉拒绝 + 引导去"已确认"面板。
 * 端到端走真实 HTTP 层，验证的是 server.ts 里汇总 blockedEdits 后推的那句回复，
 * 而不是只测底层的锁本身（那部分已经在 confirmed-field-lock.test.ts 覆盖过）。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

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

interface ConfirmedFact { key: string; label: string; value: string; status: string }
interface MessagesResponse {
  replies: { role: string; content: string }[];
  designBrief?: { confirmedFacts: ConfirmedFact[] };
  floorPlanId?: string | null;
}

test("已确认的墙长被聊天里的新数字撞上时，回复委婉拒绝并指向已确认面板；数值不变", async () => {
  const created = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await created.json() as { conversation: { id: string } };

  const first = await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: 'North wall 168", East wall 120", ceiling 96"' }),
  });
  const firstBody = await first.json() as MessagesResponse;
  const northBefore = firstBody.designBrief?.confirmedFacts.find((f) => f.label.includes("North"));
  assert.ok(northBefore, "第一轮应该已经把北墙记成 168");
  assert.match(northBefore!.value, /168/);

  const second = await req(`/api/conversations/${conversation.id}/messages`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ text: 'Actually the North wall is 100" not 168"' }),
  });
  const secondBody = await second.json() as MessagesResponse;

  const decline = secondBody.replies.find((r) =>
    /already confirmed|Confirmed panel|已经确认过|已确认.*面板/.test(r.content));
  assert.ok(decline, `没找到拒绝+引导的回复。实际回复：${JSON.stringify(secondBody.replies)}`);
  assert.match(decline!.content, /168/, "拒绝话术应该报出当前已确认的值");
  assert.match(decline!.content, /100/, "拒绝话术应该报出客户想改成的值");

  const northAfter = secondBody.designBrief?.confirmedFacts.find((f) => f.label.includes("North"));
  assert.ok(northAfter);
  assert.match(northAfter!.value, /168/, "北墙的值不应该被聊天里的新数字悄悄改掉");
  assert.ok(!/100/.test(northAfter!.value));
});
