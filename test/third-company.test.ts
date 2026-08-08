/**
 * 第三家试点公司 —— **本轮的验收标准**（DEV_PLAN M5-12、SCENARIOS 场景 K）。
 *
 * 前两家证明的是「命名体系不同也能接入」（Lakeside 用 `NW-` 前缀，靠脸型覆盖表
 * 救回匹配率）。这一家要证明更难的一条：**设计本身不同也能接入**——
 * 分体 pantry 而不是连体、吊柜最高 39" 而不是 42"。
 *
 * 判据：**加这一家没有改排布算法的代码**。要是得改，说明能力标签
 * （`spec/capabilities.ts`）这层没做对——排布器该问的是「有没有 18" 宽、
 * 84" 高的储物高柜」，不是「有没有 PANTRY1884」。
 *
 * 这组测试证明不了"一行都没改"（那要看 diff），但它能证明**结果是对的**：
 * 同一个户型在三家公司上都排得出、都只用各自真实存在的型号、
 * 而且因为规格不同，结果确实不一样。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildThirdCompanyBundle, THIRD_COMPANY_ID, THIRD_SPEC_VERSION_ID,
} from "../src/app/seed-third.js";
import { buildSecondCompanyBundle } from "../src/app/seed-second.js";
import { pilotModules } from "../src/app/seed.js";
import { generateLayout } from "../src/layout/generate.js";
import { solveStack, stackCandidates } from "../src/layout/stacking.js";
import { applianceFrom } from "../src/floorplan/appliances.js";
import type { ParsedGeometry } from "../src/floorplan/types.js";
import type { ModuleSpec } from "../src/domain/types.js";

const third = buildThirdCompanyBundle();
const second = buildSecondCompanyBundle();

const appliances = [
  applianceFrom({ kind: "refrigerator", width: 33 }),
  applianceFrom({ kind: "range", width: 30 }),
];

/** 108" 层高：吊柜可用 48"，正好是三家会给出不同答案的那一档。 */
function kitchen(ceilingHeight: number): ParsedGeometry {
  return {
    wallRuns: [{
      id: "w", label: "北墙", length: 168,
      startsAtCorner: false, endsAtCorner: false,
      features: [
        { id: "win", kind: "window", offset: 72, width: 36 },
        { id: "p", kind: "plumbing", offset: 78, width: 24 },
      ],
    }],
    ceilingHeight, confidence: 1,
  };
}

// ── 接入本身 ─────────────────────────────────────────────────────────────

test("第三家走的是与第二家完全一样的导入路径，没有新的建立方式", () => {
  assert.equal(third.bundle.id, THIRD_SPEC_VERSION_ID);
  assert.equal(third.bundle.companyId, THIRD_COMPANY_ID);
  assert.ok(third.bundle.modules.length > 0);
  assert.ok(third.bundle.priceMatrix.length > 0);
  // 脸型全部由覆盖表给到，不留待确认项——否则出图时会有柜子画不出脸
  assert.equal(third.unresolvedCount, 0,
    "有型号的脸型没解出来，排布能跑但正视图会缺一块");
});

test("规格设计确实与前两家不同——否则这一轮什么也没验证", () => {
  const wallHeights = (modules: readonly ModuleSpec[]) =>
    [...new Set(modules.filter((m) => m.type === "wall").flatMap((m) => m.heightOptions))]
      .sort((a, b) => a - b);

  const birch = wallHeights(third.bundle.modules);
  const maple = wallHeights(pilotModules);
  assert.equal(Math.max(...birch), 39, "第三家的吊柜上限该是 39\"");
  assert.equal(Math.max(...maple), 42, "第一家的吊柜上限该是 42\"");

  // 连体 pantry vs 分体：第一家有一个通高 SKU，第三家没有
  const tallStorage = (modules: readonly ModuleSpec[]) =>
    modules.filter((m) => m.type === "tall" && m.heightOptions.some((h) => h >= 84));
  assert.ok(tallStorage(pilotModules).length > 0, "第一家该有通高高柜");
  assert.equal(tallStorage(third.bundle.modules).length, 0,
    "第三家是分体做法，不该有通高的单个 SKU");
});

// ── 排布器不认识任何一家的型号码 ────────────────────────────────────────

test("同一个户型在三家都排得出，且只用各自真实存在的型号", () => {
  const cases: [string, readonly ModuleSpec[]][] = [
    ["Maple Ridge", pilotModules],
    ["Lakeside", second.bundle.modules],
    ["Birchline", third.bundle.modules],
  ];
  for (const [name, modules] of cases) {
    const layout = generateLayout(kitchen(108), modules, {
      ceilingHeight: 108, appliances,
    });
    const cabinets = layout.placements.filter((p) => p.kind === "cabinet");
    assert.ok(cabinets.length > 0, `${name} 一个柜子都没排出来`);

    const byId = new Map(modules.map((m) => [m.id, m]));
    for (const p of cabinets) {
      const spec = byId.get(p.moduleId ?? "");
      assert.ok(spec, `${name} 排出了规格库里不存在的型号 ${p.moduleCode}`);
      assert.ok(spec.widthOptions.includes(p.width),
        `${name} 的 ${p.moduleCode} 用了不存在的宽度 ${p.width}"`);
      assert.ok(spec.heightOptions.includes(p.height),
        `${name} 的 ${p.moduleCode} 用了不存在的高度 ${p.height}"`);
    }
  }
});

// ── 39" 上限真的改变了结果 ───────────────────────────────────────────────

test("108\" 层高下，39\" 上限的那家解出的叠装与 42\" 的那家不同", () => {
  const available = 108 - 54 - 6; // 48"
  const maple = solveStack(available, stackCandidates(pilotModules, 30));
  const birch = solveStack(available, stackCandidates(third.bundle.modules, 30));

  assert.ok(maple && birch);
  // 第一家 30" 宽只有 30/36/42 三档，48 拼不出来 → 42 单柜 + 6" 顶线
  assert.deepEqual(maple.heights, [42]);
  assert.ok(maple.shortfall > 0, "第一家该留出顶线空当");
  // 第三家 30" 宽有 15/21/30/39 → 能拼满
  assert.equal(birch.shortfall, 0, `第三家该拼得满，实际余 ${birch.shortfall}"`);
  assert.ok(birch.heights.length >= 2, "第三家该是叠装，不是单柜");
  assert.equal(birch.heights.reduce((a, b) => a + b, 0), available);
});

test("两家的报价件数不同——那是正确的结果，不是 bug", () => {
  const a = generateLayout(kitchen(108), pilotModules, { ceilingHeight: 108, appliances });
  const b = generateLayout(kitchen(108), third.bundle.modules, { ceilingHeight: 108, appliances });
  const count = (l: typeof a) => l.placements.filter((p) => p.layer === "wall" && p.kind === "cabinet").length;
  assert.notEqual(count(a), count(b),
    "两家规格差这么多，吊柜件数却一样——多半是叠装没生效");
});

test("解不出贴合组合时如实说明，不静默把 48\" 变成 42\"", () => {
  const layout = generateLayout(kitchen(108), pilotModules, { ceilingHeight: 108, appliances });
  assert.ok(layout.warnings.some((w) => /顶线|crown molding/i.test(w.message)),
    `没有说明顶上留了空当：${layout.warnings.map((w) => w.message).join(" / ")}`);
});

// ── 叠装的接缝在同一面墙上要在一条线 ────────────────────────────────────

test("同一面墙的横缝高度一致——否则正视图上是一条锯齿线", () => {
  const layout = generateLayout(kitchen(120), third.bundle.modules, {
    ceilingHeight: 120, appliances,
  });
  const seams = new Set(
    layout.placements
      .filter((p) => p.layer === "wall" && p.stackBase)
      .map((p) => p.stackBase));
  assert.ok(seams.size > 0, "120\" 层高该出现叠装");
  assert.equal(seams.size, 1, `同一面墙出现了 ${seams.size} 种缝高：${[...seams].join("、")}`);
});
