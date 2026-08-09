/**
 * 回归看板聚合（FR-22.2）—— 超越 knowledge-metrics.jsonl 的可读摘要。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { PlatformKnowledgeCard } from "./types.js";
import type { CompanyLearningItem } from "./l1-types.js";
import { summarizeL1Queue } from "./l1-learn.js";
import type { SessionRun } from "../domain/types.js";
import { discoverSessionRuns } from "../session/runs.js";

export interface KnowledgeMetricEvent {
  type: string;
  conversationId?: string;
  count?: number;
  detail?: string;
  at?: string;
}

export interface SimOutSummary {
  dir: string;
  mtime?: string;
  hasData: boolean;
  hasDesignsHtml: boolean;
  sessionRunCount?: number;
}

export interface RegressionDashboard {
  generatedAt: string;
  metrics: {
    path: string;
    exists: boolean;
    totalLines: number;
    byType: Record<string, number>;
    recent: KnowledgeMetricEvent[];
  };
  knowledgeCards: {
    total: number;
    byStatus: Record<string, number>;
    published: number;
    draft: number;
  };
  /** 若有 publishedAt 与 draft_proposed 时间，粗对比（尽力而为）。 */
  publishVsDraft: {
    publishedCount: number;
    draftProposedMetricCount: number;
    note: string;
  };
  l1Queue: ReturnType<typeof summarizeL1Queue>;
  sessionRuns: {
    total: number;
    byOrigin: Record<string, number>;
    recent: Pick<SessionRun, "id" | "origin" | "startedAt" | "endedAt" | "dataDir">[];
  };
  simOut: SimOutSummary[];
}

export function readKnowledgeMetrics(
  dataDir: string,
  opts?: { recentLimit?: number },
): {
  path: string;
  exists: boolean;
  totalLines: number;
  byType: Record<string, number>;
  recent: KnowledgeMetricEvent[];
  events: KnowledgeMetricEvent[];
} {
  const file = path.join(dataDir, "knowledge-metrics.jsonl");
  const byType: Record<string, number> = {};
  const events: KnowledgeMetricEvent[] = [];
  if (!existsSync(file)) {
    return {
      path: file,
      exists: false,
      totalLines: 0,
      byType,
      recent: [],
      events,
    };
  }
  const text = readFileSync(file, "utf-8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t) as KnowledgeMetricEvent;
      events.push(ev);
      if (ev.type) byType[ev.type] = (byType[ev.type] ?? 0) + 1;
    } catch {
      // skip bad lines
    }
  }
  const limit = opts?.recentLimit ?? 30;
  return {
    path: file,
    exists: true,
    totalLines: events.length,
    byType,
    recent: events.slice(-limit).reverse(),
    events,
  };
}

/** 列出 `sim-out/YYYY-MM-DD-NN`（及旧式目录）摘要，新的在前。 */
export function listSimOutSummaries(
  cwd: string,
  simOutDir = "sim-out",
  limit = 12,
): SimOutSummary[] {
  const root = path.join(cwd, simOutDir);
  if (!existsSync(root)) return [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const rows: SimOutSummary[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const dataDir = existsSync(path.join(dir, "data"))
      ? path.join(dir, "data")
      : dir;
    let sessionRunCount: number | undefined;
    const runsFile = path.join(dataDir, "session-runs.json");
    if (existsSync(runsFile)) {
      try {
        const raw = JSON.parse(readFileSync(runsFile, "utf-8")) as unknown;
        if (Array.isArray(raw)) sessionRunCount = raw.length;
      } catch {
        // ignore
      }
    }
    rows.push({
      dir: path.join(simOutDir, name),
      mtime: st.mtime.toISOString(),
      hasData: existsSync(path.join(dir, "data")) || existsSync(runsFile),
      hasDesignsHtml: existsSync(path.join(dir, "designs.html")),
      sessionRunCount,
    });
  }
  rows.sort((a, b) => (a.mtime! < b.mtime! ? 1 : -1));
  return rows.slice(0, limit);
}

export function buildRegressionDashboard(input: {
  dataDir: string;
  cwd?: string;
  l1Items: readonly CompanyLearningItem[];
  knowledgeCards: readonly PlatformKnowledgeCard[];
  sessionRuns?: readonly SessionRun[];
  simOutDir?: string;
}): RegressionDashboard {
  const cwd = input.cwd ?? process.cwd();
  const metrics = readKnowledgeMetrics(input.dataDir);
  const byStatus: Record<string, number> = {};
  for (const c of input.knowledgeCards) {
    byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
  }
  const published = input.knowledgeCards.filter((c) => c.status === "published");
  const draftProposed = metrics.byType["draft_proposed"] ?? 0;

  const runs =
    input.sessionRuns ??
    discoverSessionRuns({
      cwd,
      current: [],
      simOutDir: input.simOutDir,
    });
  const byOrigin: Record<string, number> = {};
  for (const r of runs) {
    byOrigin[r.origin] = (byOrigin[r.origin] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    metrics: {
      path: metrics.path,
      exists: metrics.exists,
      totalLines: metrics.totalLines,
      byType: metrics.byType,
      recent: metrics.recent,
    },
    knowledgeCards: {
      total: input.knowledgeCards.length,
      byStatus,
      published: published.length,
      draft: byStatus["draft"] ?? 0,
    },
    publishVsDraft: {
      publishedCount: published.length,
      draftProposedMetricCount: draftProposed,
      note:
        published.length === 0 && draftProposed > 0
          ? "Drafts proposed from signals; none published yet (expected until human confirm)."
          : "Compare published cards vs draft_proposed metrics; publish is always manual.",
    },
    l1Queue: summarizeL1Queue(input.l1Items),
    sessionRuns: {
      total: runs.length,
      byOrigin,
      recent: runs.slice(0, 15).map((r) => ({
        id: r.id,
        origin: r.origin,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        dataDir: r.dataDir,
      })),
    },
    simOut: listSimOutSummaries(cwd, input.simOutDir ?? "sim-out"),
  };
}
