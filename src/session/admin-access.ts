/**
 * 运营跨 SessionRun 只读访问（FR-21）。
 * 当前进程 dataDir 优先；否则按 SessionRun.dataDir 打开外仓。
 */
import { existsSync } from "node:fs";
import type { AppContext } from "../app/context.js";
import type { Conversation, CritiqueReview, SessionRun } from "../domain/types.js";
import { openRepositories, type Repositories } from "../store/repositories.js";
import { discoverSessionRuns } from "./runs.js";

export function listAllSessionRuns(ctx: AppContext): SessionRun[] {
  return discoverSessionRuns({ current: ctx.repos.sessionRuns.all() });
}

export function reposForDataDir(ctx: AppContext, dataDir: string): Repositories {
  if (dataDir === ctx.dataDir) return ctx.repos;
  return openRepositories(dataDir);
}

/** 在当前仓 + 已发现 runs 中定位会话。 */
export function findConversationAcrossRuns(
  ctx: AppContext,
  conversationId: string,
): { conversation: Conversation; repos: Repositories; run?: SessionRun } | undefined {
  const local = ctx.repos.conversations.byId(conversationId);
  if (local) {
    const run = local.runId ? ctx.repos.sessionRuns.byId(local.runId) : undefined;
    return { conversation: local, repos: ctx.repos, ...(run ? { run } : {}) };
  }

  for (const run of listAllSessionRuns(ctx)) {
    if (!run.dataDir || !existsSync(run.dataDir)) continue;
    if (run.dataDir === ctx.dataDir) continue;
    try {
      const repos = openRepositories(run.dataDir);
      const conversation = repos.conversations.byId(conversationId);
      if (conversation) return { conversation, repos, run };
    } catch {
      // skip
    }
  }
  return undefined;
}

export function listConversationsAcrossRuns(
  ctx: AppContext,
  filter: { origin?: string; runId?: string } = {},
): Array<{ conversation: Conversation; runId?: string; origin?: string; dataDir: string }> {
  const out: Array<{ conversation: Conversation; runId?: string; origin?: string; dataDir: string }> = [];
  const seen = new Set<string>();

  const pushAll = (repos: Repositories, dataDir: string, run?: SessionRun) => {
    for (const c of repos.conversations.all()) {
      if (seen.has(c.id)) continue;
      const origin = c.origin ?? run?.origin ?? "production";
      const runId = c.runId ?? run?.id;
      if (filter.origin && origin !== filter.origin) continue;
      if (filter.runId && runId !== filter.runId) continue;
      seen.add(c.id);
      out.push({
        conversation: c,
        ...(runId ? { runId } : {}),
        origin,
        dataDir,
      });
    }
  };

  pushAll(ctx.repos, ctx.dataDir);
  for (const run of listAllSessionRuns(ctx)) {
    if (!run.dataDir || run.dataDir === ctx.dataDir || !existsSync(run.dataDir)) continue;
    try {
      pushAll(openRepositories(run.dataDir), run.dataDir, run);
    } catch {
      // skip
    }
  }

  return out.sort((a, b) =>
    (a.conversation.createdAt < b.conversation.createdAt ? 1 : -1));
}

export function critiquesForConversation(
  repos: Repositories,
  conversationId: string,
): CritiqueReview[] {
  return repos.critiqueReviews
    .filter((r) => r.conversationId === conversationId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
