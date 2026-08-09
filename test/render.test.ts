/**
 * 脸型文法测试 —— 核心断言是 RENDERING.md 4.1 那条：
 * **门缝是绝对尺寸，不随柜宽缩放**。这正是否决「归一化 symbol + scale」的理由。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STYLE, FaceLayoutError, layoutFace, revealFor, toSvg,
} from "../src/render/face-grammar.js";
import {
  BASE_FACE_HEIGHT, buildFace, matchFaceTemplate, matchWithOverrides,
} from "../src/render/templates.js";

const FRAMELESS = { ...DEFAULT_STYLE, construction: "frameless" as const };

test("门缝是绝对尺寸，12\" 柜与 36\" 柜的缝一样宽", () => {
  const spec = buildFace("F2_DOUBLE_DOOR");
  const narrow = layoutFace(spec, 12, 30, FRAMELESS);
  const wide = layoutFace(spec, 36, 30, FRAMELESS);

  const gapOf = (r: typeof narrow) => {
    const [l, right] = r.leaves;
    return Number((right!.x - (l!.x + l!.w)).toFixed(6));
  };
  assert.equal(gapOf(narrow), 0.25);
  assert.equal(gapOf(wide), 0.25);
  // 这就是缩放方案会失败的地方：缩放后宽柜的缝会变成 3 倍
  assert.equal(gapOf(narrow), gapOf(wide));
});

test("overlay 方式改变留边宽度", () => {
  assert.equal(revealFor({ ...DEFAULT_STYLE, overlay: "full" }), 0.25);
  assert.equal(revealFor({ ...DEFAULT_STYLE, overlay: "partial" }), 1.0);
  assert.equal(revealFor({ ...DEFAULT_STYLE, overlay: "inset" }), 3 / 32);
});

test("面框柜的可用区域内缩 1-1/2\"", () => {
  const r = layoutFace(buildFace("F1_SINGLE_DOOR"), 30, 30, DEFAULT_STYLE);
  assert.equal(r.inner.x, 1.5);
  assert.equal(r.inner.w, 27);
  assert.equal(r.leaves[0]!.w, 27);

  const fl = layoutFace(buildFace("F1_SINGLE_DOOR"), 30, 30, FRAMELESS);
  assert.equal(fl.inner.w, 30);
});

test("B12 一抽一门：6\" 抽 + 剩余为门，合计等于可用脸高", () => {
  const r = layoutFace(buildFace("F3_DRAWER_OVER_DOOR"), 12, BASE_FACE_HEIGHT, FRAMELESS);
  const [drawer, door] = r.leaves;
  assert.equal(drawer!.kind, "drawer");
  assert.equal(drawer!.h, 6);
  assert.equal(door!.kind, "door");
  // 6 + 0.25 缝 + 门高 = 30
  assert.equal(Number((drawer!.h + 0.25 + door!.h).toFixed(6)), BASE_FACE_HEIGHT);
});

test("B30 双抽双门：顶部两个抽屉是横向并排的", () => {
  const r = layoutFace(buildFace("F5_TWO_DRAWERS_OVER_DOUBLE"), 30, BASE_FACE_HEIGHT, FRAMELESS);
  const drawers = r.leaves.filter((l) => l.kind === "drawer");
  const doors = r.leaves.filter((l) => l.kind === "door");
  assert.equal(drawers.length, 2);
  assert.equal(doors.length, 2);
  // 并排 = 同一个 y，不同 x
  assert.equal(drawers[0]!.y, drawers[1]!.y);
  assert.notEqual(drawers[0]!.x, drawers[1]!.x);
  // 两个抽屉宽度相等，且加上缝等于总宽
  assert.equal(drawers[0]!.w, drawers[1]!.w);
  assert.equal(Number((drawers[0]!.w * 2 + 0.25).toFixed(6)), 30);
});

test("N 抽屉栈：一个模板覆盖 2DB/3DB/4DB，各段之和精确等于可用高", () => {
  for (const n of [2, 3, 4, 5]) {
    const r = layoutFace(buildFace("F6_DRAWER_STACK", { drawerCount: n }), 24, BASE_FACE_HEIGHT, FRAMELESS);
    assert.equal(r.leaves.length, n);
    const totalH = r.leaves.reduce((s, l) => s + l.h, 0);
    const gaps = (n - 1) * 0.25;
    assert.equal(
      Number((totalH + gaps).toFixed(6)), BASE_FACE_HEIGHT,
      `${n} 抽时各段之和 + 缝隙应等于 ${BASE_FACE_HEIGHT}`,
    );
  }
});

test("4DB 不照抄规范文档里合计 29\" 的近似值（附录 A9）", () => {
  const r = layoutFace(buildFace("F6_DRAWER_STACK", { drawerCount: 4 }), 18, BASE_FACE_HEIGHT, FRAMELESS);
  const totalH = r.leaves.reduce((s, l) => s + l.h, 0);
  assert.equal(Number((totalH + 3 * 0.25).toFixed(6)), 30);
  assert.notEqual(totalH, 29);
});

test("SB36 水槽柜：假抽面 + 双门", () => {
  const r = layoutFace(buildFace("F7_FALSE_FRONT_DOUBLE"), 36, BASE_FACE_HEIGHT, FRAMELESS);
  assert.equal(r.leaves.filter((l) => l.kind === "falseFront").length, 1);
  assert.equal(r.leaves.filter((l) => l.kind === "door").length, 2);
});

test("盲角柜：盲板宽度固定，不随柜宽变化", () => {
  const a = layoutFace(buildFace("F10_BLIND_CORNER", { blindWidth: 6 }), 36, BASE_FACE_HEIGHT, FRAMELESS);
  const b = layoutFace(buildFace("F10_BLIND_CORNER", { blindWidth: 6 }), 42, BASE_FACE_HEIGHT, FRAMELESS);
  assert.equal(a.leaves.find((l) => l.kind === "blind")!.w, 6);
  assert.equal(b.leaves.find((l) => l.kind === "blind")!.w, 6);
});

test("空间不足以容纳缝隙时报错，而不是画出重叠的门", () => {
  assert.throws(
    () => layoutFace(buildFace("F6_DRAWER_STACK", { drawerCount: 20 }), 24, 3, FRAMELESS),
    (e: unknown) => e instanceof FaceLayoutError,
  );
});

test("固定尺寸超出可用空间时报错", () => {
  assert.throws(
    () => layoutFace(
      { dir: "rows", children: [{ size: 40, node: { kind: "door" } }, { size: "*", node: { kind: "door" } }] },
      24, 30, FRAMELESS,
    ),
    (e: unknown) => e instanceof FaceLayoutError && e.code === "FIXED_EXCEEDS_AVAILABLE",
  );
});

test("所有叶子都落在可用区域内", () => {
  const r = layoutFace(buildFace("F5_TWO_DRAWERS_OVER_DOUBLE"), 36, BASE_FACE_HEIGHT, DEFAULT_STYLE);
  for (const l of r.leaves) {
    assert.ok(l.x >= r.inner.x - 1e-9, `叶子越过左边界`);
    assert.ok(l.y >= r.inner.y - 1e-9, `叶子越过上边界`);
    assert.ok(l.x + l.w <= r.inner.x + r.inner.w + 1e-9, `叶子越过右边界`);
    assert.ok(l.y + l.h <= r.inner.y + r.inner.h + 1e-9, `叶子越过下边界`);
  }
});

test("SVG 输出线宽固定，不随尺寸缩放", () => {
  const small = toSvg(layoutFace(buildFace("F2_DOUBLE_DOOR"), 12, 30, FRAMELESS));
  const large = toSvg(layoutFace(buildFace("F2_DOUBLE_DOOR"), 36, 30, FRAMELESS));
  assert.match(small, /stroke-width="1"/);
  assert.match(large, /stroke-width="1"/);
  assert.ok(!small.includes("transform=\"scale"), "不应使用 scale 变换");
  assert.ok(!large.includes("transform=\"scale"), "不应使用 scale 变换");
});

// ── SKU 规则匹配 ──────────────────────────────────────────────────────────

test("地柜脸型依赖宽度而不只是前缀", () => {
  assert.equal(matchFaceTemplate("B12")!.templateId, "F3_DRAWER_OVER_DOOR");
  assert.equal(matchFaceTemplate("B21")!.templateId, "F3_DRAWER_OVER_DOOR");
  assert.equal(matchFaceTemplate("B24")!.templateId, "F4_DRAWER_OVER_DOUBLE");
  assert.equal(matchFaceTemplate("B27")!.templateId, "F4_DRAWER_OVER_DOUBLE");
  assert.equal(matchFaceTemplate("B30")!.templateId, "F5_TWO_DRAWERS_OVER_DOUBLE");
  assert.equal(matchFaceTemplate("B36")!.templateId, "F5_TWO_DRAWERS_OVER_DOUBLE");
});

test("吊柜同样依赖宽度", () => {
  assert.equal(matchFaceTemplate("W1230")!.templateId, "F1_SINGLE_DOOR");
  assert.equal(matchFaceTemplate("W2136")!.templateId, "F1_SINGLE_DOOR");
  assert.equal(matchFaceTemplate("W3030")!.templateId, "F2_DOUBLE_DOOR");
  assert.equal(matchFaceTemplate("W3642")!.templateId, "F2_DOUBLE_DOOR");
});

test("抽屉柜前缀里的数字就是抽屉数", () => {
  assert.equal(matchFaceTemplate("2DB30")!.params.drawerCount, 2);
  assert.equal(matchFaceTemplate("3DB24")!.params.drawerCount, 3);
  assert.equal(matchFaceTemplate("4DB18")!.params.drawerCount, 4);
});

test("规范文档里的各类 SKU 都能匹配到脸型", () => {
  const cases: [string, string][] = [
    ["SB36", "F7_FALSE_FRONT_DOUBLE"],
    ["FSB36", "F8_APRON_SINK"],
    ["APR36", "F8_APRON_SINK"],
    ["LSB33", "F9_DIAGONAL_CORNER"],
    ["LSB36", "F9_DIAGONAL_CORNER"],
    ["DC33", "F9_DIAGONAL_CORNER"],
    ["DC36", "F9_DIAGONAL_CORNER"],
    ["CW2412", "F9_DIAGONAL_CORNER"],
    ["CW2430", "F9_DIAGONAL_CORNER"],
    ["CW2442", "F9_DIAGONAL_CORNER"],
    ["EWC2430", "F9_DIAGONAL_CORNER"],
    ["LC2412", "F1_SINGLE_DOOR"],
    ["LC2430", "F1_SINGLE_DOOR"],
    ["LC2442", "F1_SINGLE_DOOR"],
    ["BBC42", "F10_BLIND_CORNER"],
    ["BBC45", "F10_BLIND_CORNER"],
    ["WBC3030", "F10_BLIND_CORNER"],
    ["BPO09", "F1_SINGLE_DOOR"],
    ["TDC15", "F1_SINGLE_DOOR"],
    ["WWR3015", "F12_WINE_GRID"],
    ["MW3018", "F11_OPEN_SHELF"],
    ["OC3084", "F14_APPLIANCE"],
    ["BOC3084", "F14_APPLIANCE"],
    ["PC1884", "F13_TALL_TWO_DOOR"],
    ["U3090", "F13_TALL_TWO_DOOR"],
    ["VDB1221", "F6_DRAWER_STACK"],
    ["WF3", "F15_PLAIN_PANEL"],
    ["CM8", "F15_PLAIN_PANEL"],
    ["TK8", "F15_PLAIN_PANEL"],
    ["REP396", "F15_PLAIN_PANEL"],
  ];
  for (const [sku, expected] of cases) {
    const m = matchFaceTemplate(sku);
    assert.ok(m, `${sku} 未匹配到脸型`);
    assert.equal(m.templateId, expected, `${sku} 匹配错误`);
  }
});

test("匹配不到时返回 undefined —— 交给 FR-2 确认，不猜", () => {
  assert.equal(matchFaceTemplate("XYZ-9000"), undefined);
  assert.equal(matchFaceTemplate("ACME123"), undefined);
});

test("公司覆盖表优先于通用规则", () => {
  const overrides = { "ACME": { templateId: "F2_DOUBLE_DOOR" as const } };
  assert.equal(matchWithOverrides("ACME123", overrides)!.templateId, "F2_DOUBLE_DOOR");
  // 覆盖表也能改写通用规则的判定
  assert.equal(matchWithOverrides("B30", { "B30": { templateId: "F1_SINGLE_DOOR" } })!.templateId, "F1_SINGLE_DOOR");
  // 未命中覆盖表时回落到通用规则
  assert.equal(matchWithOverrides("B30", overrides)!.templateId, "F5_TWO_DRAWERS_OVER_DOUBLE");
});

test("匹配结果带可解释的规则说明", () => {
  assert.match(matchFaceTemplate("B12")!.rule, /≤ 21/);
  assert.match(matchFaceTemplate("3DB24")!.rule, /N=3/);
});
