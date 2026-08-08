/**
 * 合理性审查规范 —— 规则表、文档、执行三者对得上。
 *
 * 这一组测试防的是两种事故，它们都不会让任何东西报错，所以只能靠断言抓：
 *
 *   1. **规范里写了、代码里没实现**——「我们检查了」其实没检查；
 *   2. **代码里加了检查、规范没更新**——客户被拦下来，翻遍文档找不到依据。
 *
 * 注意这里证明的是「跑到了」，不是「判得对」。判得对要靠会被它拦下来的用例，
 * 那些散在各自的测试文件里（`plan-model.test.ts` 的墙角干涉、
 * `layout-quality.test.ts` 的净空…）。这份只保证**没有哪条规则是摆设**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SANITY_RULES, auditEnforcedRules, ruleFor, type SanityRuleId,
} from "../src/delivery/sanity-rules.js";
import { auditDeliverable, renderAuditText } from "../src/delivery/audit.js";
import { generateLayout } from "../src/layout/generate.js";
import { pilotModules } from "../src/app/seed.js";
import { applianceFrom } from "../src/floorplan/appliances.js";
import type { ParsedGeometry, WallRun } from "../src/floorplan/types.js";

const wall = (id: string, label: string, length: number, o: Partial<WallRun> = {}): WallRun =>
  ({ id, label, length, startsAtCorner: false, endsAtCorner: false, features: [], ...o });

const geometry: ParsedGeometry = {
  wallRuns: [
    wall("w1", "西墙", 132, { endsAtCorner: true,
      features: [{ id: "e", kind: "electrical", offset: 0, width: 36 }] }),
    wall("w2", "北墙", 132, { startsAtCorner: true, endsAtCorner: true,
      features: [
        { id: "w", kind: "window", offset: 48, width: 36 },
        { id: "p", kind: "plumbing", offset: 54, width: 24 },
      ] }),
    wall("w3", "东墙", 132, { startsAtCorner: true }),
  ],
  ceilingHeight: 96, confidence: 1,
};
const layout = generateLayout(geometry, pilotModules, {
  ceilingHeight: 96,
  appliances: [applianceFrom({ kind: "refrigerator", width: 33 }),
    applianceFrom({ kind: "range", width: 30 })],
});

// ── 表本身自洽 ────────────────────────────────────────────────────────────

test("编号不重复，每条都写清了判据与为什么", () => {
  const ids = SANITY_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "有重复编号");
  for (const r of SANITY_RULES) {
    assert.ok(r.criterion.length > 10, `${r.id} 的判据太含糊，照着写不出断言`);
    assert.ok(r.why.length > 10, `${r.id} 没说为什么——下一个人会以为它可以放宽`);
    assert.ok(r.implementedIn.includes("/"), `${r.id} 没写实现在哪`);
  }
});

test("ruleFor 取不到就炸，不静默返回 undefined", () => {
  assert.equal(ruleFor("SR-G3").severity, "blocking");
  assert.throws(
    () => ruleFor("SR-NOPE" as SanityRuleId),
    /Sanity rule SR-NOPE is not in SANITY_RULES/,
  );
});

// ── 文档是规则表的视图 ────────────────────────────────────────────────────

test("docs/SANITY_RULES.md 与规则表一致——不允许各写各的", () => {
  const doc = readFileSync("docs/SANITY_RULES.md", "utf8");
  for (const r of SANITY_RULES) {
    assert.ok(doc.includes(`#### ${r.id}`), `规范文档里没有 ${r.id}`);
    assert.ok(doc.includes(r.title), `规范文档里没有 ${r.id} 的标题`);
    assert.ok(doc.includes(r.implementedIn), `${r.id} 没写明实现位置`);
  }
  // 反向：文档里不该出现表里没有的编号
  for (const m of doc.matchAll(/#### (SR-[A-Z]\d+)/g)) {
    const id = m[1] as SanityRuleId;
    assert.ok(SANITY_RULES.some((r) => r.id === id),
      `规范文档里有 ${id}，但规则表里没有——代码不会执行它`);
  }
});

// ── 声明由审核执行的，审核真的跑到了 ──────────────────────────────────────

test("凡是写了「由交付前审核执行」的规则，审核跑一次就都跑到", () => {
  const report = auditDeliverable({
    deliverable: "quoteList", stage: "quoted",
    layout, wallRuns: geometry.wallRuns,
    modules: pilotModules,
    bom: { lines: [], missing: [], totals: {} } as never,
    quoteList: { reconciliationDelta: 0 } as never,
    snapshot: { ok: true },
    appliances: [applianceFrom({ kind: "refrigerator" })],
    customerFacingText: "冰箱位按常见款推定 33\"",
    unappliedPreferences: ["「整体大气一点」这句落不到具体参数上"],
  });

  const expected = auditEnforcedRules().map((r) => r.id).sort();
  const actual = [...report.checkedRules].sort();
  assert.deepEqual(actual, expected,
    `规范说这些由审核执行：${expected.join("、")}；实际跑到的是：${actual.join("、")}`);
});

test("每条结论都带规范编号——客户要能查到依据", () => {
  const report = auditDeliverable({
    deliverable: "quoteList", stage: "planReview", // 阶段不对，必出 SR-D3
    layout, wallRuns: geometry.wallRuns,
  });
  assert.equal(report.ok, false);
  for (const f of report.findings) {
    assert.ok(SANITY_RULES.some((r) => r.id === f.rule),
      `结论带了一个不存在的编号 ${f.rule}`);
  }
  const text = renderAuditText(report);
  assert.match(text, /\[SR-D3\]/, "客户读到的文字里没有规范编号，查不到依据");
});

test("全部通过时报出的是「按规范跑了几条」，不是一句空话", () => {
  const report = auditDeliverable({
    deliverable: "planView", stage: "planReview",
    layout, wallRuns: geometry.wallRuns,
  });
  assert.equal(report.ok, true, report.blockers.map((b) => b.message).join(" / "));
  assert.match(
    renderAuditText(report),
    /Ran \d+ rules from the Sanity Review Spec|按《合理性审查规范》跑了 \d+ 条/,
  );
});

// ── 新加的两条真的会拦人 ──────────────────────────────────────────────────

test("SR-G4：柜子的台面伸进门洞就阻断", () => {
  const withDoor: ParsedGeometry = {
    wallRuns: [wall("w", "南墙", 216, {
      features: [
        { id: "d", kind: "door", offset: 96, width: 32 },
        { id: "p", kind: "plumbing", offset: 30, width: 24 },
      ],
    })],
    ceilingHeight: 96, confidence: 1,
  };
  const good = generateLayout(withDoor, pilotModules, {
    ceilingHeight: 96, appliances: [applianceFrom({ kind: "refrigerator" })],
  });
  const clean = auditDeliverable({
    deliverable: "planView", stage: "planReview",
    layout: good, wallRuns: withDoor.wallRuns,
  });
  assert.equal(clean.blockers.some((f) => f.rule === "SR-G4"), false,
    "排布器已经让过位，不该被自己的出口检查拦住");

  // 把柜子推到门洞边上——台面就会压到门套
  const pushed = {
    ...good,
    placements: good.placements.map((p) =>
      p.layer === "base" && p.x + p.width <= 96 ? { ...p, x: p.x + 4 } : p),
  };
  const dirty = auditDeliverable({
    deliverable: "planView", stage: "planReview",
    layout: pushed, wallRuns: withDoor.wallRuns,
  });
  assert.ok(dirty.blockers.some((f) => f.rule === "SR-G4"),
    `台面压到门套没被拦住：${dirty.blockers.map((b) => b.rule).join("、")}`);
});

test("SR-V4：平面拼不起来而说明里没提，出提示", () => {
  const loose: WallRun[] = [wall("a", "南墙", 120), wall("b", "北墙", 120)];
  const silent = auditDeliverable({
    deliverable: "planView", stage: "planReview",
    layout, wallRuns: loose, customerFacingText: "这是你的厨房排布",
  });
  assert.ok(silent.notices.some((f) => f.rule === "SR-V4"));

  const disclosed = auditDeliverable({
    deliverable: "planView", stage: "planReview",
    layout, wallRuns: loose,
    customerFacingText: "有墙段拼不到一起，图中为示意排列，实际方位请以现场为准。",
  });
  assert.equal(disclosed.notices.some((f) => f.rule === "SR-V4"), false,
    "已经如实说明了还报，等于逼着人说两遍");
});
