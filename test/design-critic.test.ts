/**
 * FR-21：DesignCritic 确定性降级 + 不污染客户 messages + Admin API。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pruneTestSessions, testSessionDataDir } from "../src/session/runs.js";
import { deterministicCritique, runDesignCritique } from "../src/agents/design-critic.js";
import type { Conversation } from "../src/domain/types.js";

process.env.SITE_PASSWORD_DISABLED = "true";
process.env.ADMIN_TOKEN = "test-admin-token";

after(() => {
  pruneTestSessions({ keepLast: 5 });
});

test("deterministicCritique 对重复尺寸追问给出 dialogue finding", () => {
  const conversation: Conversation = {
    id: "cv_test",
    customerAccountId: "ca_x",
    designRequirements: "",
    perCompanyThreads: [],
    createdAt: new Date().toISOString(),
    messages: [
      { role: "assistant", content: "How large is your kitchen?", at: "t1" },
      { role: "user", content: "About 10x12", at: "t2" },
      { role: "assistant", content: "What is the kitchen size again?", at: "t3" },
    ],
  };
  const { findings, summary } = deterministicCritique(
    {
      conversation,
      audits: [],
      quoteCount: 0,
      layoutCount: 0,
    },
    "manual",
  );
  assert.ok(summary.includes("DesignCritic"));
  assert.ok(findings.some((f) => f.title.includes("Repeated size")));
});

test("runDesignCritique 写入 critique-reviews 且客户 messages 长度不变", async () => {
  const { runId, dataDir } = testSessionDataDir();
  const { createAppContext } = await import("../src/app/context.js");
  const ctx = await createAppContext({
    dataDir, origin: "test", runId, llm: undefined,
  });

  const conv: Conversation = {
    id: `cv_${runId.slice(-8)}`,
    customerAccountId: "ca_demo_consumer",
    messages: [
      { role: "user", content: "Hi", at: new Date().toISOString() },
      { role: "assistant", content: "Hello — how can I help?", at: new Date().toISOString() },
    ],
    designRequirements: "",
    perCompanyThreads: [],
    createdAt: new Date().toISOString(),
    origin: "test",
    runId,
  };
  await ctx.repos.conversations.insert(conv);
  const beforeLen = conv.messages.length;

  const review = await runDesignCritique({
    repos: ctx.repos,
    conversationId: conv.id,
    trigger: "manual",
  });
  assert.ok(review);
  assert.equal(review!.trigger, "manual");
  assert.ok(review!.findings.length >= 1);
  assert.equal(review!.messages[0]?.role, "critic");

  const reloaded = ctx.repos.conversations.byId(conv.id)!;
  assert.equal(reloaded.messages.length, beforeLen);
  assert.ok(ctx.repos.critiqueReviews.byId(review!.id));
});

test("Admin API 可列跨会话并手动触发评审", async () => {
  const { runId, dataDir } = testSessionDataDir();
  const mod = await import("../src/server.js");
  const app = await mod.createApp({
    dataDir, origin: "test", runId, llm: undefined,
  });

  const created = await app.fetch(new Request("http://test/api/conversations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-account-id": "ca_demo_consumer",
    },
    body: "{}",
  }));
  const { conversation } = await created.json() as { conversation: { id: string } };

  await app.fetch(new Request(`http://test/api/conversations/${conversation.id}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-account-id": "ca_demo_consumer",
    },
    body: JSON.stringify({ text: "I want cabinets" }),
  }));

  const list = await app.fetch(new Request("http://test/api/admin/conversations?origin=test", {
    headers: { "x-admin-token": "test-admin-token" },
  }));
  assert.equal(list.status, 200);
  const listBody = await list.json() as { conversations: { id: string }[] };
  assert.ok(listBody.conversations.some((c) => c.id === conversation.id));

  const before = await app.fetch(new Request(`http://test/api/conversations/${conversation.id}`, {
    headers: { "x-account-id": "ca_demo_consumer" },
  }));
  const beforeConv = await before.json() as { conversation: { messages: unknown[] } };
  const msgCount = beforeConv.conversation.messages.length;

  const post = await app.fetch(new Request(
    `http://test/api/admin/conversations/${conversation.id}/critiques`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": "test-admin-token",
      },
      body: "{}",
    },
  ));
  assert.equal(post.status, 201);
  const { critique } = await post.json() as { critique: { id: string; findings: unknown[] } };
  assert.ok(critique.id);
  assert.ok(critique.findings.length >= 1);

  const after = await app.fetch(new Request(`http://test/api/conversations/${conversation.id}`, {
    headers: { "x-account-id": "ca_demo_consumer" },
  }));
  const afterConv = await after.json() as { conversation: { messages: unknown[] } };
  assert.equal(afterConv.conversation.messages.length, msgCount);
});
