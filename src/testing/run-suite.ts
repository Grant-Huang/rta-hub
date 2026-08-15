/**
 * 测试套件编排：选题 → 跑用例 → 可选 DesignCritic。
 */
import { randomUUID } from "node:crypto";
import type { CompletionClient } from "../agents/types.js";
import type { Repositories } from "../store/repositories.js";
import { runDesignCritique } from "../agents/design-critic.js";
import { allocatePointsForCases } from "./test-points.js";
import { blueprintFromPoints } from "./scenario-from-points.js";
import { runTestCase } from "./run-case.js";
import type { TestFetch } from "./http-client.js";
import type { StartTestUserRunInput, TestUserRun } from "./types.js";
import { touchSessionRunConversation, upsertSessionRun } from "../session/runs.js";

export interface RunSuiteDeps {
  call: TestFetch;
  repos: Repositories;
  dataDir: string;
  /** 与 createApp({ runId }) 对齐，保证会话 origin/runId 一致 */
  sessionRunId?: string;
  userLlm?: CompletionClient;
  criticLlm?: CompletionClient;
  adminToken?: string;
}

export async function startAndRunTestSuite(
  deps: RunSuiteDeps,
  input: StartTestUserRunInput = {},
): Promise<TestUserRun> {
  const count = Math.min(8, Math.max(1, input.count ?? 3));
  const runCritic = input.runCritic !== false;
  const accountId = input.accountId ?? "ca_test";
  const sessionRunId = deps.sessionRunId
    ?? `test_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}_${randomUUID().slice(0, 6)}`;
  const runId = `tur_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  const allocations = allocatePointsForCases(count, input.pointIds);
  const selectedPointIds = [...new Set(allocations.flat().map((p) => p.id))];

  let run: TestUserRun = {
    id: runId,
    origin: "test",
    status: "running",
    requestedCount: count,
    selectedPointIds,
    runCritic,
    sessionRunId,
    accountId,
    cases: allocations.map((pts, i) => ({
      id: `tc_${i + 1}`,
      pointIds: pts.map((p) => p.id),
      title: "",
      status: "pending",
      notes: [],
      errors: [],
      startedAt: now,
    })),
    createdAt: now,
    startedAt: now,
  };
  await deps.repos.testUserRuns.upsert(run);

  const existingRun = deps.repos.sessionRuns.byId(sessionRunId);
  await upsertSessionRun(deps.repos, {
    id: sessionRunId,
    origin: "test",
    dataDir: deps.dataDir,
    startedAt: existingRun?.startedAt ?? now,
    conversationIds: existingRun?.conversationIds ?? [],
    note: `test-user-run ${runId}`,
  });

  const critiques: string[] = [];

  try {
    for (let i = 0; i < allocations.length; i++) {
      const points = allocations[i]!;
      const bp = blueprintFromPoints(points, i);
      // trade 账号
      const acct = bp.accountType === "trade" ? "ca_demo_trade" : accountId;
      run.cases[i] = { ...run.cases[i]!, status: "running", title: bp.titleTag };
      await deps.repos.testUserRuns.upsert(run);

      const result = await runTestCase({
        call: deps.call,
        blueprint: bp,
        accountId: acct,
        userLlm: deps.userLlm,
        caseId: `tc_${i + 1}`,
      });
      run.cases[i] = result;

      if (result.conversationId) {
        await touchSessionRunConversation(deps.repos, sessionRunId, result.conversationId);
        // 确保 origin/runId/tags 落在会话上
        const conv = deps.repos.conversations.byId(result.conversationId);
        if (conv) {
          await deps.repos.conversations.update(conv.id, {
            ...conv,
            origin: "test",
            runId: sessionRunId,
            tags: [...new Set([...(conv.tags ?? []), "test-user", ...result.pointIds])],
          });
        }
      }

      if (runCritic && result.conversationId) {
        const review = await runDesignCritique({
          repos: deps.repos,
          conversationId: result.conversationId,
          trigger: "sessionEnd",
          llm: deps.criticLlm,
        });
        if (review) {
          run.cases[i] = { ...run.cases[i]!, critiqueId: review.id };
          critiques.push(`${result.title}: ${review.summary}`);
        }
      }

      await deps.repos.testUserRuns.upsert(run);
    }

    run = {
      ...run,
      status: "completed",
      endedAt: new Date().toISOString(),
      critiqueSummary: critiques.length
        ? critiques.join("\n")
        : (runCritic ? "No critiques produced" : "Critic skipped"),
    };
  } catch (e) {
    run = {
      ...run,
      status: "failed",
      endedAt: new Date().toISOString(),
      error: e instanceof Error ? e.message : String(e),
    };
  }

  await deps.repos.testUserRuns.upsert(run);
  return run;
}
