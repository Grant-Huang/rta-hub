/**
 * SessionRun 辅助 —— 统一生产 / simulate / 测试会话的可寻址落盘（FR-21）。
 *
 * ephemeral 临时目录仅留给「无会话语义」的纯单元测试；凡创建 Conversation 的路径
 * 都应使用显式 dataDir + origin + runId。
 */
import { mkdirSync, readdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Repositories } from "../store/repositories.js";
import type { SessionOrigin, SessionRun, Timestamp } from "../domain/types.js";
import { openRepositories } from "../store/repositories.js";

export function newRunId(origin: SessionOrigin): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${origin}_${stamp}_${randomUUID().slice(0, 8)}`;
}

/** 集成/行为测试的默认落盘根：`.tmp/test-sessions/<runId>`。 */
export function testSessionDataDir(runId?: string, cwd = process.cwd()): { runId: string; dataDir: string } {
  const id = runId ?? newRunId("test");
  const dataDir = path.join(cwd, ".tmp", "test-sessions", id);
  mkdirSync(dataDir, { recursive: true });
  return { runId: id, dataDir };
}

/** simulate 默认：`sim-out/<runId>/data`。 */
export function simulateSessionDataDir(
  outRoot: string,
  runId?: string,
  cwd = process.cwd(),
): { runId: string; dataDir: string; runRoot: string } {
  const id = runId ?? newRunId("simulate");
  const runRoot = path.join(cwd, outRoot, id);
  const dataDir = path.join(runRoot, "data");
  mkdirSync(dataDir, { recursive: true });
  return { runId: id, dataDir, runRoot };
}

export async function upsertSessionRun(
  repos: Repositories,
  run: SessionRun,
): Promise<SessionRun> {
  return repos.sessionRuns.upsert(run);
}

export async function touchSessionRunConversation(
  repos: Repositories,
  runId: string | undefined,
  conversationId: string,
): Promise<void> {
  if (!runId) return;
  const existing = repos.sessionRuns.byId(runId);
  if (!existing) return;
  if (existing.conversationIds.includes(conversationId)) return;
  await repos.sessionRuns.update(runId, {
    ...existing,
    conversationIds: [...existing.conversationIds, conversationId],
  });
}

export async function endSessionRun(
  repos: Repositories,
  runId: string,
  patch: { endedAt?: Timestamp; exitCode?: number; scenarioSource?: string; note?: string } = {},
): Promise<SessionRun | undefined> {
  const existing = repos.sessionRuns.byId(runId);
  if (!existing) return undefined;
  return repos.sessionRuns.update(runId, {
    ...existing,
    endedAt: patch.endedAt ?? new Date().toISOString(),
    ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
    ...(patch.scenarioSource !== undefined ? { scenarioSource: patch.scenarioSource } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
  });
}

/**
 * 发现可评审的 SessionRun：当前仓 + sim-out/* / .tmp/test-sessions/* 下的 data。
 * 不打开外仓全文，只读各仓 `session-runs.json` 元数据。
 */
export function discoverSessionRuns(opts: {
  cwd?: string;
  current?: readonly SessionRun[];
  simOutDir?: string;
  testSessionsDir?: string;
}): SessionRun[] {
  const cwd = opts.cwd ?? process.cwd();
  const byId = new Map<string, SessionRun>();
  for (const r of opts.current ?? []) byId.set(r.id, r);

  const scanRoots = [
    path.join(cwd, opts.simOutDir ?? "sim-out"),
    path.join(cwd, opts.testSessionsDir ?? path.join(".tmp", "test-sessions")),
  ];

  for (const root of scanRoots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dataDir = existsSync(path.join(root, name, "data"))
        ? path.join(root, name, "data")
        : path.join(root, name);
      const file = path.join(dataDir, "session-runs.json");
      if (!existsSync(file)) continue;
      try {
        const foreign = openRepositories(dataDir);
        for (const r of foreign.sessionRuns.all()) {
          byId.set(r.id, { ...r, dataDir: r.dataDir || dataDir });
        }
      } catch {
        // 损坏的索引跳过；兜底读原始 JSON 数组
        try {
          const raw = JSON.parse(readFileSync(file, "utf-8")) as SessionRun[];
          if (Array.isArray(raw)) {
            for (const r of raw) {
              if (r?.id) byId.set(r.id, { ...r, dataDir: r.dataDir || dataDir });
            }
          }
        } catch {
          // ignore
        }
      }
    }
  }

  return [...byId.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** 测试结束后清理旧目录；KEEP_TEST_SESSIONS=1 时保留全部。默认保留最近 keepLast 次。 */
export function pruneTestSessions(opts: {
  cwd?: string;
  keepLast?: number;
} = {}): void {
  if (process.env.KEEP_TEST_SESSIONS === "1") return;
  const cwd = opts.cwd ?? process.cwd();
  const root = path.join(cwd, ".tmp", "test-sessions");
  if (!existsSync(root)) return;
  const keepLast = opts.keepLast ?? 5;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const dirs = names
    .map((n) => ({ n, p: path.join(root, n) }))
    .sort((a, b) => (a.n < b.n ? 1 : -1));
  for (const d of dirs.slice(keepLast)) {
    try {
      rmSync(d.p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
