/**
 * FR-21：系统会话可寻址持久化（非 ephemeral）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pruneTestSessions, testSessionDataDir } from "../src/session/runs.js";

process.env.SITE_PASSWORD_DISABLED = "true";
process.env.ADMIN_TOKEN = "test-admin-token";

after(() => {
  pruneTestSessions({ keepLast: 5 });
});

test("createApp 写入 dataDir 后可回读 conversation，并登记 SessionRun", async () => {
  const { runId, dataDir } = testSessionDataDir();
  const mod = await import("../src/server.js");
  const app = await mod.createApp({
    dataDir,
    origin: "test",
    runId,
    llm: undefined,
  });

  const create = await app.fetch(new Request("http://test/api/conversations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-account-id": "ca_demo_consumer",
    },
    body: JSON.stringify({ tags: ["session-persistence"] }),
  }));
  assert.equal(create.status, 201);
  const { conversation } = await create.json() as {
    conversation: { id: string; origin?: string; runId?: string; tags?: string[] };
  };
  assert.equal(conversation.origin, "test");
  assert.equal(conversation.runId, runId);
  assert.ok(conversation.tags?.includes("session-persistence"));

  const file = path.join(dataDir, "conversations.json");
  assert.ok(existsSync(file), "conversations.json should exist");
  const raw = JSON.parse(readFileSync(file, "utf-8")) as Array<{ id: string }>;
  assert.ok(raw.some((c) => c.id === conversation.id));

  const runsFile = path.join(dataDir, "session-runs.json");
  assert.ok(existsSync(runsFile));
  const runs = JSON.parse(readFileSync(runsFile, "utf-8")) as Array<{
    id: string; conversationIds: string[];
  }>;
  const run = runs.find((r) => r.id === runId);
  assert.ok(run);
  assert.ok(run!.conversationIds.includes(conversation.id));
});
