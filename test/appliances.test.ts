/**
 * 家电规格 —— FR-3.2、APPLIANCES.md 第 2 节。
 *
 * 这一组盯的是同一件事的两面：
 *   - 「我不确定」必须是**合法答案**（否则等于逼客户先去量尺寸）；
 *   - 走了默认值就必须**留痕**，而且痕迹要一路传到图纸解释与硬约束提示里。
 *
 * 后半条是重点：**推定值导致的否决，与真实尺寸导致的否决，对客户是完全不同的
 * 两句话。** 「你的厨房排不下」和「按我们猜的尺寸排不下」不能混为一谈。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPLIANCE_DEFAULTS, applianceFrom, ApplianceError, assumedOnes,
  normalizeAppliances, provenanceNote, reservedWidth, violationCaveat,
} from "../src/floorplan/appliances.js";
import {
  applianceQuestion, applianceWidthQuestion, appliancePlacementQuestion,
  buildApplianceQuestions,
} from "../src/preferences/questions.js";

// ── 采集 ──────────────────────────────────────────────────────────────────

test("给了宽度就按客户的来，标记为 customer", () => {
  const a = applianceFrom({ kind: "refrigerator", width: 36 });
  assert.equal(a.width, 36);
  assert.equal(a.provenance, "customer");
});

test("没给宽度走常见尺寸，但标记为 assumed——不拒绝，因为「不确定」是合法答案", () => {
  const a = applianceFrom({ kind: "refrigerator" });
  assert.equal(a.width, APPLIANCE_DEFAULTS.refrigerator.width);
  assert.equal(a.provenance, "assumed");
});

test("离谱的宽度被拒绝——那多半是单位搞错了（比如填了厘米）", () => {
  assert.throws(() => applianceFrom({ kind: "refrigerator", width: 900 }), ApplianceError);
  assert.throws(() => applianceFrom({ kind: "refrigerator", width: 2 }), ApplianceError);
});

test("留空宽度含通风间隙——36\" 冰箱塞进 36\" 的空当是装不进去的", () => {
  const fridge = applianceFrom({ kind: "refrigerator", width: 36 });
  assert.equal(fridge.clearanceEachSide, 1);
  assert.equal(reservedWidth(fridge), 38, "两侧各 1 英寸通风");

  // 灶具是嵌在台面里的，不需要两侧间隙
  const range = applianceFrom({ kind: "range", width: 30 });
  assert.equal(reservedWidth(range), 30);
});

test("同一种家电只留一台", () => {
  const list = normalizeAppliances([
    applianceFrom({ kind: "refrigerator", width: 30 }),
    applianceFrom({ kind: "refrigerator", width: 36 }),
    applianceFrom({ kind: "range" }),
  ]);
  assert.equal(list.length, 2);
  assert.equal(list.find((a) => a.kind === "refrigerator")?.width, 36, "后填的覆盖先填的");
});

test("客户想放的位置被记下来，不是丢掉", () => {
  const a = applianceFrom({ kind: "refrigerator", width: 33, preferredZone: "nearEntry" });
  assert.equal(a.preferredZone, "nearEntry");
});

// ── provenance 一路传下去 ─────────────────────────────────────────────────

test("全是客户给的尺寸时，不说任何「按推定值」的话", () => {
  const list = [
    applianceFrom({ kind: "refrigerator", width: 33 }),
    applianceFrom({ kind: "range", width: 30 }),
  ];
  assert.deepEqual(assumedOnes(list), []);
  assert.equal(provenanceNote(list), undefined, "没有推定值就别说有——与 explain.ts 同一条原则");
  assert.equal(violationCaveat(list), undefined);
});

test("有推定值时，说明里点名是哪几样、按多少预留", () => {
  const list = [
    applianceFrom({ kind: "refrigerator" }),           // 推定
    applianceFrom({ kind: "range", width: 36 }),        // 客户给的
  ];
  const note = provenanceNote(list);
  assert.ok(note, "有推定值就必须说");
  assert.ok(note.includes("冰箱"), note);
  assert.ok(note.includes("33"), "要说清按多少预留的");
  assert.equal(note.includes("灶具"), false, "客户给了准确尺寸的不该混进来");
});

test("硬约束否决时的注脚说明「可能并不成立」，而不是断言排不下", () => {
  const list = [applianceFrom({ kind: "refrigerator" })];
  const caveat = violationCaveat(list);
  assert.ok(caveat);
  assert.ok(caveat.includes("推定"), caveat);
  assert.ok(
    caveat.includes("可能并不成立") || caveat.includes("重排"),
    "要给客户一条出路：把准确尺寸告诉我们",
  );
});

// ── 选择题 ────────────────────────────────────────────────────────────────

test("「有哪些家电」是多选且不可跳过——一个家电都不放的厨房不存在", () => {
  const q = applianceQuestion();
  assert.equal(q.multiSelect, true);
  assert.equal(q.skippable, false);
  assert.ok(q.options.some((o) => o.id === "refrigerator"));
  assert.ok(q.options.some((o) => o.id === "rangeHood"));
  assert.ok(q.why.includes("净空") || q.why.includes("排布"), "要说清它影响什么");
});

test("宽度题里必须有「我去量一下再说」", () => {
  const q = applianceWidthQuestion("refrigerator");
  assert.ok(q);
  const unsure = q.options.find((o) => o.id === "refrigerator:unsure");
  assert.ok(unsure, "逼客户先量尺寸，是把系统的困难转嫁给他");
  assert.ok(unsure.detail?.includes("推定"), "选了它要让客户知道图上会标出来");
  // 常见档位也在
  assert.ok(q.options.some((o) => o.id === "refrigerator:33"));
});

test("位置题里有「你帮我定」——客户不该被迫替系统做决定", () => {
  const q = appliancePlacementQuestion("refrigerator");
  assert.ok(q.options.some((o) => o.id === "refrigerator:any"));
  assert.equal(q.skippable, true);
});

test("还没答过「有哪些家电」时，先问那一题", () => {
  const qs = buildApplianceQuestions({ known: [], kindsAnswered: false, maxPerTurn: 3 });
  assert.equal(qs.length, 1);
  assert.equal(qs[0]!.key, "appliances");
});

test("只对推定尺寸的家电追问宽度，客户给过准确数字的不再打扰", () => {
  const qs = buildApplianceQuestions({
    known: [
      applianceFrom({ kind: "refrigerator" }),        // 推定 → 该问
      applianceFrom({ kind: "range", width: 36 }),     // 给过 → 不问
    ],
    kindsAnswered: true, maxPerTurn: 5,
  });
  assert.equal(qs.length, 1);
  assert.ok(qs[0]!.prompt.includes("冰箱"), qs[0]!.prompt);
});

test("全部尺寸都确认过之后就不再问了", () => {
  const qs = buildApplianceQuestions({
    known: [applianceFrom({ kind: "refrigerator", width: 33 })],
    kindsAnswered: true, maxPerTurn: 5,
  });
  assert.deepEqual(qs, []);
});
