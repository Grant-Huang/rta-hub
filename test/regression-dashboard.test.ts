/**
 * FR-22.2：回归看板聚合（metrics / sim-out / L1 队列）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  buildRegressionDashboard,
  listSimOutSummaries,
  readKnowledgeMetrics,
} from "../src/knowledge/regression-dashboard.js";
import { appendKnowledgeMetric } from "../src/knowledge/learn.js";
import type { CompanyLearningItem } from "../src/knowledge/l1-types.js";

test("readKnowledgeMetrics 聚合 byType 与 recent", () => {
  const dir = path.join(tmpdir(), `rta-metrics-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    appendKnowledgeMetric(dir, { type: "reask", conversationId: "c1", count: 2 });
    appendKnowledgeMetric(dir, { type: "audit_blocking", conversationId: "c1", count: 1 });
    appendKnowledgeMetric(dir, { type: "draft_proposed", detail: "x" });
    const m = readKnowledgeMetrics(dir);
    assert.equal(m.exists, true);
    assert.equal(m.byType.reask, 1);
    assert.equal(m.byType.audit_blocking, 1);
    assert.equal(m.byType.draft_proposed, 1);
    assert.ok(m.recent.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listSimOutSummaries 识别 YYYY-MM-DD-NN fixture", () => {
  const cwd = path.join(tmpdir(), `rta-simroot-${Date.now()}`);
  const day = "2026-08-08-99";
  const run = path.join(cwd, "sim-out", day);
  mkdirSync(path.join(run, "data"), { recursive: true });
  writeFileSync(path.join(run, "designs.html"), "<html></html>");
  writeFileSync(
    path.join(run, "data", "session-runs.json"),
    JSON.stringify([{ id: "simulate_x", origin: "simulate", dataDir: "data", startedAt: "2026-08-08T00:00:00.000Z", conversationIds: [] }]),
  );
  try {
    const rows = listSimOutSummaries(cwd, "sim-out");
    assert.ok(rows.some((r) => r.dir.endsWith(day)));
    const hit = rows.find((r) => r.dir.endsWith(day))!;
    assert.equal(hit.hasDesignsHtml, true);
    assert.equal(hit.hasData, true);
    assert.equal(hit.sessionRunCount, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildRegressionDashboard 含 L1 队列与卡片状态", () => {
  const dir = path.join(tmpdir(), `rta-dash-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  appendKnowledgeMetric(dir, { type: "audit_blocking", count: 3 });
  const l1: CompanyLearningItem[] = [
    {
      id: "l1q_1",
      companyId: "co_a",
      status: "draft",
      source: "price_matrix_hole",
      settleTarget: "specDraftNote",
      title: "hole",
      summary: "x",
      createdAt: "2026-08-08T00:00:00.000Z",
    },
  ];
  try {
    const dash = buildRegressionDashboard({
      dataDir: dir,
      cwd: dir,
      l1Items: l1,
      knowledgeCards: [],
      sessionRuns: [],
      simOutDir: "sim-out",
    });
    assert.equal(dash.metrics.byType.audit_blocking, 1);
    assert.equal(dash.l1Queue.total, 1);
    assert.equal(dash.l1Queue.byStatus.draft, 1);
    assert.ok(dash.publishVsDraft.note.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
