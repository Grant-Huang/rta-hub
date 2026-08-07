/**
 * 绘图内核 —— RENDERING.md §8。
 *
 * 触发这一轮的是客户的一句话：「全局布局图纸跟后面各向的图纸，是用的不同的
 * 工具吗？后面的图纸用的是什么开源软件？」
 *
 * 答案是：全都是本项目自己拼的 SVG，同一种技术。但两个渲染器各写了一套颜色、
 * 各有一份复制的转义函数、一个画开门弧线一个不画——**客户看的是约定，不是技术**，
 * 于是它们看起来像两个软件画的。
 *
 * 所以这一组测试断言的不是"能画出来"，而是**两组图遵守同一套约定**：
 * 同一个东西是同一个颜色、同一种线型、同一种标注方式。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFourViews, renderTopView, renderFrontElevation } from "../src/render/views.js";
import { renderPlanView, renderPlanViews, kindsInPlan } from "../src/render/plan-view.js";
import { PALETTE, INK, elementKindOf, type ElementKind } from "../src/render/kernel/palette.js";
import { renderLegend } from "../src/render/kernel/legend.js";
import { formatInches, esc } from "../src/render/kernel/primitives.js";
import { annotationFor } from "../src/render/kernel/annotate.js";
import { generateLayout } from "../src/layout/generate.js";
import { applianceFrom } from "../src/floorplan/appliances.js";
import { pilotModules } from "../src/app/seed.js";
import type { ParsedGeometry, WallRun } from "../src/floorplan/types.js";

const wall: WallRun = {
  id: "wr_1", label: "北墙", length: 192,
  startsAtCorner: false, endsAtCorner: false,
  features: [
    { id: "f_w", kind: "window", offset: 108, width: 36 },
    { id: "f_p", kind: "plumbing", offset: 120, width: 24 },
  ],
};
const geometry: ParsedGeometry = { wallRuns: [wall], ceilingHeight: 96, confidence: 1 };
const appliances = [
  applianceFrom({ kind: "refrigerator", width: 33 }),
  applianceFrom({ kind: "dishwasher", width: 24 }),
];
const layout = generateLayout(geometry, pilotModules, { ceilingHeight: 96, appliances });

const four = renderFourViews(wall, layout.placements);
const plan = renderPlanView(geometry, layout.placements, "base");

/** SVG 里出现过的所有填充色。 */
function fills(svg: string): Set<string> {
  return new Set([...svg.matchAll(/fill="(#[0-9a-fA-F]{3,8})"/g)].map((m) => m[1]!.toLowerCase()));
}

// ── 两组图共用同一套约定 ──────────────────────────────────────────────────

test("填缝条在正视图与全局俯视图上是同一个颜色", () => {
  // 改造前：正视图 #e6e0d4，全局俯视图 #d8cfa8。同一个构件两个颜色，
  // 客户当然觉得是两个软件画的
  const c = PALETTE.filler.fill.toLowerCase();
  assert.ok(fills(four.front).has(c), `正视图里没有填缝条色 ${c}`);
  assert.ok(fills(plan).has(c), `全局俯视图里没有填缝条色 ${c}`);
});

test("家电位在两组图上都是同一种虚线", () => {
  const dash = `stroke-dasharray="${PALETTE.appliance.dash}"`;
  assert.ok(four.front.includes(dash), "正视图的家电位不是约定的虚线");
  assert.ok(plan.includes(dash), "全局俯视图的家电位不是约定的虚线");
});

test("全局俯视图用到的颜色全部出自调色板，没有就地硬编码的", () => {
  const allowed = new Set<string>(["#ffffff"]);
  for (const s of Object.values(PALETTE)) {
    if (s.fill !== "none") allowed.add(s.fill.toLowerCase());
  }
  for (const c of Object.values(INK)) allowed.add(c.toLowerCase());
  for (const c of fills(plan)) {
    assert.ok(allowed.has(c), `全局俯视图出现了调色板之外的颜色 ${c}`);
  }
});

test("开门方向弧线两组图都画——客户判断门会不会打架靠的就是它", () => {
  // 改造前只有单墙俯视图有，全局俯视图没有
  assert.ok(four.topBase.includes("<path d=\"M "), "单墙俯视图缺开门弧线");
  assert.ok(plan.includes("<path d=\"M "), "全局俯视图缺开门弧线");
});

test("全局俯视图有逐柜尺寸链，不只是一行墙总长", () => {
  const widths = layout.placements
    .filter((p) => p.layer === "base" && p.width >= 9)
    .map((p) => formatInches(p.width));
  const missing = widths.filter((w) => !plan.includes(esc(w)));
  assert.deepEqual(missing, [], `这些柜宽没有标在图上：${missing.join("、")}`);
});

test("绝不输出 transform=\"scale()\"——缩放会把门缝和线宽一起放大", () => {
  for (const [name, svg] of Object.entries({ ...four, plan })) {
    assert.equal(/scale\s*\(/.test(svg), false, `${name} 里出现了缩放`);
  }
});

// ── 标注：图上要能看出哪个是什么 ──────────────────────────────────────────

test("水槽在正视图、单墙俯视图、全局俯视图上都标了字", () => {
  // 改造前三张图上水槽都是一个没有文字的方块，客户第一个要找的就是它
  const top = renderTopView(wall, layout.placements, "base");
  const front = renderFrontElevation(wall, layout.placements);
  for (const [name, svg] of Object.entries({ front, top, plan })) {
    assert.ok(svg.includes("水槽"), `${name} 上没有标出水槽`);
  }
});

test("家电位标出的是家电名与尺寸，不是空白方块", () => {
  assert.ok(plan.includes("冰箱"), "全局俯视图没标冰箱");
  assert.ok(renderFrontElevation(wall, layout.placements).includes("冰箱"), "正视图没标冰箱");
});

test("推定的尺寸在图上就标明是推定的", () => {
  const guessed = generateLayout(geometry, pilotModules, {
    ceilingHeight: 96,
    // 不给宽度 → provenance: "assumed"
    appliances: [applianceFrom({ kind: "refrigerator" })],
  });
  const svg = renderPlanView(geometry, guessed.placements, "base");
  assert.ok(svg.includes("推定"),
    "按常见款猜的尺寸必须在图上说明——等到装不进去才发现就晚了");
});

test("填缝条不标字——3/4 寸宽写上去也看不清，它在图例里说明", () => {
  const filler = layout.placements.find((p) => p.kind === "filler");
  assert.ok(filler, "这条断言的前提：这一版确实排出了填缝条");
  assert.equal(annotationFor(filler), undefined);
});

// ── 图例 ──────────────────────────────────────────────────────────────────

test("图例列的正是图上画出来的东西，不多不少", () => {
  const kinds = kindsInPlan(geometry, layout.placements, "base");
  const legend = renderLegend(kinds, 0, 0, 3);
  for (const k of kinds) {
    assert.ok(legend.svg.includes(esc(PALETTE[k].legend)),
      `图上有 ${k} 但图例里没有`);
  }
  // 反向：图例里不该出现这一版根本没画的东西
  const absent: ElementKind[] = (["panel", "featureGas"] as ElementKind[])
    .filter((k) => !kinds.includes(k));
  for (const k of absent) {
    assert.equal(legend.svg.includes(esc(PALETTE[k].legend)), false,
      `图上没有 ${k}，图例里不该列它`);
  }
});

test("图例为空时不占地方", () => {
  assert.deepEqual(renderLegend([], 0, 0), { svg: "", width: 0, height: 0 });
});

test("图例给自己腾了地方，没有压在第一排柜子上", () => {
  const withLegend = renderPlanView(geometry, layout.placements, "base");
  const without = renderPlanView(geometry, layout.placements, "base",
    { pxPerInch: 2.2, showDimensions: true, showLabels: true, showLegend: false });
  const hOf = (svg: string) => Number(/height="([\d.]+)"/.exec(svg)![1]);
  assert.ok(hOf(withLegend) > hOf(without),
    "画了图例却没给它腾高度，它会盖住图");
});

// ── "这是什么东西" 只有一处判断 ────────────────────────────────────────────

test("水槽柜、配套柜、普通柜体各归各的类", () => {
  const sink = layout.placements.find((p) => p.label === "sink")!;
  assert.equal(elementKindOf(sink), "sinkBase");

  const over = layout.placements.find((p) => p.label === "冰箱上柜");
  assert.ok(over, "这条断言的前提：这一版排出了冰箱上柜");
  assert.equal(elementKindOf(over), "applianceCabinet");

  const plainCabinet = layout.placements.find(
    (p) => p.kind === "cabinet" && p.label === undefined && p.applianceKind === undefined)!;
  assert.equal(elementKindOf(plainCabinet), "cabinet");
});

test("两张全局俯视图（地柜层/吊柜层）用的是同一套约定", () => {
  const views = renderPlanViews(geometry, layout.placements);
  for (const svg of [views.base, views.wall]) {
    assert.ok(svg.includes('role="img"'));
    assert.ok(svg.includes("<title>"));
    assert.ok(svg.includes('fill="#ffffff"'), "背景色写法要一致");
  }
});

test("水槽盆画在水槽柜的柜面上——「水槽落在 SB 柜上面」要在图上看得见", () => {
  // 只把水槽柜涂成另一个颜色说明不了盆在哪：那只说明"这个柜子跟别的不一样"
  assert.ok(/<circle /.test(plan), "全局俯视图上没有水槽盆（龙头）");
  const sink = layout.placements.find((p) => p.label === "sink")!;
  assert.ok(sink.width >= 30, "这条断言的前提：这一版是双盆宽度");
  // 双盆要画中间那道分隔——客户能据此核对订的是不是双盆
  const bowlLines = [...plan.matchAll(/<line [^>]*stroke-width="0.9"/g)];
  assert.ok(bowlLines.length >= 1, "双盆没有画中间的分隔");
});
