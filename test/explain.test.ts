/**
 * 图纸解释 —— 「这是什么图」+「为什么这么排」。
 *
 * 核心断言：**解释必须来自实际算出来的结果**。说「水槽对准了窗中心」只有在真的
 * 对准时才允许，否则就是在编——而客户会据此做决定。
 *
 * 默认语言是英文；中文路径用 `language: "zh"` 显式覆盖来测。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WallRun } from "../src/floorplan/types.js";
import type { AestheticScore } from "../src/layout/aesthetics.js";
import type { ErgonomicViolation } from "../src/layout/ergonomics.js";
import type { Placement } from "../src/layout/generate.js";
import { generateLayout } from "../src/layout/generate.js";
import { pilotModules } from "../src/app/seed.js";
import {
  explainDesign, explainViews, renderRationaleHtml, renderRationaleText,
  renderViewGuideHtml, renderViewGuideText,
} from "../src/render/explain.js";

const runOf = (over: Partial<WallRun> = {}): WallRun => ({
  id: "wr_1", label: "北墙", length: 144, startsAtCorner: true, endsAtCorner: true,
  features: [], ...over,
});

const cab = (over: Partial<Placement> & { x: number; width: number }): Placement => ({
  kind: "cabinet", layer: "base", wallRunId: "wr_1", height: 34.5, depth: 24,
  moduleCode: "B30", ...over,
});

const perfectScore: AestheticScore = {
  total: 100,
  breakdown: { widthRhythm: 1, narrowPenalty: 1, seamAlignment: 1, symmetry: 1, fillerPlacement: 1 },
  notes: [],
};

const zh = { language: "zh" as const };

// ── 「这是什么图」 ────────────────────────────────────────────────────────

test("四视图各有说明，且只在适用时出现", () => {
  const full = explainViews({
    construction: "framed", overlay: "full",
    hasWallCabinets: true, hasFillers: true, hasAppliances: true,
  });
  assert.deepEqual(full.map((v) => v.view), ["front", "topBase", "topWall", "side"]);

  // 没有吊柜就不该解释吊柜层——讲一张不存在的图只会让人困惑
  const noWall = explainViews({
    construction: "framed", overlay: "full",
    hasWallCabinets: false, hasFillers: false, hasAppliances: false,
  });
  assert.ok(!noWall.some((v) => v.view === "topWall"));
});

test("默认英文：面框/无框、门板覆盖方式按公司实际做法说", () => {
  const framed = explainViews({
    construction: "framed", overlay: "full",
    hasWallCabinets: false, hasFillers: false, hasAppliances: false,
  })[0]!;
  assert.ok(framed.howToRead.some((h) => /face-frame/i.test(h)));
  assert.ok(!framed.howToRead.some((h) => /frameless/i.test(h)));
  assert.equal(framed.title, "Front elevation");

  const frameless = explainViews({
    construction: "frameless", overlay: "inset",
    hasWallCabinets: false, hasFillers: false, hasAppliances: false,
  })[0]!;
  assert.ok(frameless.howToRead.some((h) => /frameless/i.test(h)));
  assert.ok(frameless.howToRead.some((h) => /inset/i.test(h)));
});

test("明确 language=zh 时出中文面框/无框说明", () => {
  const framed = explainViews({
    construction: "framed", overlay: "full",
    hasWallCabinets: false, hasFillers: false, hasAppliances: false,
    ...zh,
  })[0]!;
  assert.ok(framed.howToRead.some((h) => h.includes("面框柜")));
  assert.ok(!framed.howToRead.some((h) => h.includes("无框柜")));

  const frameless = explainViews({
    construction: "frameless", overlay: "inset",
    hasWallCabinets: false, hasFillers: false, hasAppliances: false,
    ...zh,
  })[0]!;
  assert.ok(frameless.howToRead.some((h) => h.includes("无框柜")));
  assert.ok(frameless.howToRead.some((h) => h.includes("嵌入式")));
});

test("填缝条/家电位只在图上真的有的时候解释", () => {
  const bare = explainViews({
    construction: "framed", overlay: "full",
    hasWallCabinets: false, hasFillers: false, hasAppliances: false,
  })[0]!;
  assert.ok(!bare.howToRead.some((h) => /filler|填缝/i.test(h)));
  assert.ok(!bare.howToRead.some((h) => /appliance|家电/i.test(h)));

  const withBoth = explainViews({
    construction: "framed", overlay: "full",
    hasWallCabinets: false, hasFillers: true, hasAppliances: true,
  })[0]!;
  assert.ok(withBoth.howToRead.some((h) => /filler/i.test(h)));
  assert.ok(withBoth.howToRead.some((h) => /appliance/i.test(h)));
});

// ── 「为什么这么排」必须基于实际几何 ──────────────────────────────────────

test("水槽对准窗才说对准了；偏了就照实说偏多少（默认英文）", () => {
  const run = runOf({ features: [{ id: "w", kind: "window", offset: 60, width: 36 }] });
  // 窗中心 78；水槽中心 78 → 对准
  const aligned = explainDesign({
    run,
    placements: [cab({ x: 60, width: 36, moduleCode: "SB36", label: "sink" })],
    ergonomics: [], acceptable: true, aesthetics: perfectScore,
  });
  const alignedText = renderRationaleText(aligned);
  assert.match(alignedText, /sink.*(centered|aligned).*window/i);

  // 水槽中心 30，偏了 48"
  const off = explainDesign({
    run,
    placements: [cab({ x: 12, width: 36, moduleCode: "SB36", label: "sink" })],
    ergonomics: [], acceptable: true, aesthetics: perfectScore,
  });
  const offText = renderRationaleText(off);
  assert.ok(!/sink.*(centered|aligned).*window/i.test(offText) || /off by|偏了/i.test(offText));
  assert.match(offText, /48"/);
});

test("明确 language=zh：水槽对准窗才说对准了", () => {
  const run = runOf({ features: [{ id: "w", kind: "window", offset: 60, width: 36 }] });
  const alignedText = renderRationaleText(explainDesign({
    run,
    placements: [cab({ x: 60, width: 36, moduleCode: "SB36", label: "sink" })],
    ergonomics: [], acceptable: true, aesthetics: perfectScore, ...zh,
  }));
  assert.match(alignedText, /水槽居中对准了窗户/);

  const offText = renderRationaleText(explainDesign({
    run,
    placements: [cab({ x: 12, width: 36, moduleCode: "SB36", label: "sink" })],
    ergonomics: [], acceptable: true, aesthetics: perfectScore, ...zh,
  }));
  assert.ok(!offText.includes("水槽居中对准了窗户"), "没对准就不能说对准了");
  assert.match(offText, /偏了 48"/);
});

test("没有窗就不谈对窗——不编一个不存在的参照物", () => {
  const text = renderRationaleText(explainDesign({
    run: runOf(),
    placements: [cab({ x: 12, width: 36, moduleCode: "SB36", label: "sink" })],
    ergonomics: [], acceptable: true,
  }));
  assert.ok(!/aligned.*window|对准了窗户/i.test(text));
  assert.match(text, /no window|没有窗/i);
});

test("有填缝条且都在墙角 → 说明差额收在角落；落在中间 → 如实指出", () => {
  const atEdge = renderRationaleText(explainDesign({
    run: runOf({ length: 66 }),
    placements: [
      { kind: "filler", layer: "base", wallRunId: "wr_1", x: 0, width: 3, height: 34.5, depth: 24 },
      cab({ x: 3, width: 63 }),
    ],
    ergonomics: [], acceptable: true,
  }));
  assert.match(atEdge, /corner|墙角/i);

  const middle = renderRationaleText(explainDesign({
    run: runOf({ length: 66 }),
    placements: [
      cab({ x: 0, width: 30 }),
      { kind: "filler", layer: "base", wallRunId: "wr_1", x: 30, width: 6, height: 34.5, depth: 24 },
      cab({ x: 36, width: 30 }),
    ],
    ergonomics: [], acceptable: true,
  }));
  assert.match(middle, /between cabinets|柜体之间/i);
});

test("正好填满时说填满了，不硬凑一句填缝条的话", () => {
  const text = renderRationaleText(explainDesign({
    run: runOf({ length: 60 }),
    placements: [cab({ x: 0, width: 30 }), cab({ x: 30, width: 30 })],
    ergonomics: [], acceptable: true,
  }));
  assert.match(text, /fills exactly|正好填满/i);
  assert.ok(!/filler\(s\) totaling|填缝条共/i.test(text));
});

test("美观评分低的项也要说出来，不只报喜", () => {
  const score: AestheticScore = {
    total: 40,
    breakdown: { widthRhythm: 0.2, narrowPenalty: 0.5, seamAlignment: 0.3, symmetry: 1, fillerPlacement: 1 },
    notes: ["柜体宽度跳动较大（36/9/30），相邻宽度平均差 21.0\""],
  };
  const text = renderRationaleText(explainDesign({
    run: runOf(),
    placements: [cab({ x: 0, width: 36 }), cab({ x: 36, width: 9 }), cab({ x: 45, width: 30 })],
    ergonomics: [], acceptable: true, aesthetics: score,
  }));
  // notes from aesthetics are passed through as-is (may be Chinese from layout)
  assert.match(text, /宽度跳动较大|width/i);
  assert.ok(!/even.*rhythm|门缝节奏均匀/i.test(text));
  assert.ok(!/without stuffing|没有为了填满而塞窄柜/i.test(text));
});

// ── 人体工程检查逐条呈现 ──────────────────────────────────────────────────

test("通过的检查也列出来——客户才知道这些被查过（默认英文）", () => {
  const text = renderRationaleText(explainDesign({
    run: runOf(), placements: [cab({ x: 0, width: 30 })],
    ergonomics: [], acceptable: true,
  }));
  assert.match(text, /sink.*landing|counter workspace/i);
  assert.match(text, /cooktop.*landing/i);
  assert.match(text, /dishwasher/i);
  assert.match(text, /hard (checks|rules)|mandatory/i);
});

test("未通过的项不再列为通过，且 blocking 进「需要处理」", () => {
  const violations: ErgonomicViolation[] = [
    { code: "COOKTOP_LANDING", severity: "blocking", message: "灶具右侧落台区只有 9\"，不足 12\"", wallRunId: "wr_1" },
  ];
  const r = explainDesign({
    run: runOf(), placements: [cab({ x: 0, width: 30 })],
    ergonomics: violations, acceptable: false,
  });
  const text = renderRationaleText(r);

  assert.equal(r.acceptable, false);
  assert.match(r.headline, /failed ergonomic|未通过人体工程/i);
  assert.match(text, /Needs attention|需要处理/i);
  assert.match(text, /只有 9"/);
  // 失败的那条不能同时出现在「通过」列表里
  const passLine = text.split("\n").find((l) => /cooktop.*landing|灶具两侧落台区/i.test(l) && !/只有 9"/.test(l));
  assert.equal(passLine, undefined, "未通过的检查不该被列为通过");
});

// ── 呼应客户的选择 ────────────────────────────────────────────────────────

test("客户选了抽屉且排出了抽屉 → 呼应他的选择", () => {
  const text = renderRationaleText(explainDesign({
    run: runOf(),
    placements: [cab({ x: 0, width: 30, moduleCode: "3DB30" }), cab({ x: 30, width: 30, moduleCode: "3DB30" })],
    ergonomics: [], acceptable: true, storagePreference: "drawers",
  }));
  assert.match(text, /drawer|抽屉/i);
});

test("客户要抽屉却一个都没排出来 → 必须解释，不能沉默", () => {
  const text = renderRationaleText(explainDesign({
    run: runOf(),
    placements: [cab({ x: 0, width: 30, moduleCode: "B30" })],
    ergonomics: [], acceptable: true, storagePreference: "drawers",
  }));
  assert.match(text, /couldn['’]t place|没能排出/i);
  assert.match(text, /width|宽度/i);
});

test("没选偏好时用中性说法解释高频区抽屉", () => {
  const text = renderRationaleText(explainDesign({
    run: runOf(),
    placements: [cab({ x: 0, width: 30, moduleCode: "3DB30" })],
    ergonomics: [], acceptable: true,
  }));
  assert.match(text, /cooktop|sink|灶台|水槽/i);
  assert.ok(!/you (chose|picked)|按你选的/i.test(text));
});

// ── 呈现 ──────────────────────────────────────────────────────────────────

test("纯文本里不留 markdown 星号", () => {
  const text = renderRationaleText(explainDesign({
    run: runOf(), placements: [cab({ x: 0, width: 30 })],
    ergonomics: [], acceptable: false,
  }));
  assert.ok(!text.includes("**"), "纯文本里的 ** 只会碍眼");

  const guide = renderViewGuideText(explainViews({
    construction: "framed", overlay: "full",
    hasWallCabinets: true, hasFillers: true, hasAppliances: true,
  }));
  assert.ok(!guide.includes("**"));
});

test("HTML 先转义再加粗 —— 顺序反了就是 XSS", () => {
  const html = renderRationaleHtml(explainDesign({
    run: runOf({ label: '<img src=x onerror=alert(1)>' }),
    placements: [cab({ x: 0, width: 30 })],
    ergonomics: [], acceptable: true,
  }));
  assert.ok(!html.includes("<img"), "墙段标签里的标签必须被转义");
  assert.match(html, /&lt;img/);
  // 我们自己写的 ** 仍然要变成 <strong>
  const blocked = renderRationaleHtml(explainDesign({
    run: runOf(), placements: [cab({ x: 0, width: 30 })],
    ergonomics: [], acceptable: false,
  }));
  assert.match(blocked, /<strong>failed ergonomic checks<\/strong>/i);
});

test("HTML 里 blocking 项带独立样式类，能被醒目呈现", () => {
  const html = renderRationaleHtml(explainDesign({
    run: runOf(), placements: [cab({ x: 0, width: 30 })],
    ergonomics: [{ code: "SINK_LANDING", severity: "blocking", message: "水槽落台区不足" }],
    acceptable: false,
  }));
  assert.match(html, /x-blocked/);
  assert.match(html, /class="x-warn"/);
  assert.ok(renderViewGuideHtml(explainViews({
    construction: "framed", overlay: "full",
    hasWallCabinets: true, hasFillers: false, hasAppliances: false,
  })).includes("x-guide"));
});

// ── 与真实排布结果对接 ────────────────────────────────────────────────────

test("接在真实 generateLayout 结果上不炸，且内容对得上", () => {
  const run = runOf({
    features: [
      { id: "w", kind: "window", offset: 60, width: 36 },
      { id: "p", kind: "plumbing", offset: 66, width: 24 },
    ],
  });
  const layout = generateLayout({ wallRuns: [run], ceilingHeight: 96, confidence: 0.9 },
    pilotModules, { ceilingHeight: 96 });
  const score = layout.aesthetics.find((a) => a.wallRunId === run.id)?.score;

  const r = explainDesign({
    run, placements: layout.placements,
    ...(score ? { aesthetics: score } : {}),
    ergonomics: layout.ergonomics, warnings: layout.warnings,
    acceptable: layout.acceptable,
  });
  const text = renderRationaleText(r);

  // 解释里报的柜体数必须与实际排布一致
  const actual = layout.placements.filter(
    (p) => p.wallRunId === run.id && p.layer === "base" && p.kind === "cabinet").length;
  assert.match(r.headline, new RegExp(`${actual} base cabinet`));
  assert.equal(r.acceptable, layout.acceptable);
  assert.ok(text.length > 200);
});
