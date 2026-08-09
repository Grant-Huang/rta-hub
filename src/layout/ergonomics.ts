/**
 * 人体工程与安全约束 —— 排布的**硬约束**。
 *
 * 这些不是偏好，违反了方案就不能出：灶台旁没有落台区意味着端下来的热锅无处可放，
 * 洗碗机离水槽太远意味着每次都要滴一路水。它们与「省钱好装」是不同维度的要求，
 * 不能靠目标函数里的权重来平衡——权重再低也可能被便宜方案压过去。
 *
 * ⚠️ **数值来源**：北美 NKBA *Kitchen Planning Guidelines with Access Standards*
 * （公开 PDF：https://kb.nkba.org/uploads/2022/05/Kitchen-Planning-Guidelines.pdf ）。
 * 台账与核实记录见 `docs/LAUNCH_BLOCKERS.md` A6。数值集中在此处，改数值不用改逻辑。
 *
 * 对照摘要（公开版 Recommended；非付费原书页码）：
 *   - 水槽落台 24"/18" · 灶具落台 15"/12" · 冰箱把手侧 15"
 *   - 洗碗机距水槽 ≤36" · 洗碗机侧站立 ≥21" · 连续备餐 ≥36"
 *   - 通行过道 ≥36"（blocking）；工作过道建议 ≥42"（advisory，见 plan-model AISLE）
 *   - 工作三角单边 4–9 ft、总和 ≤26 ft
 *
 * ## 语言
 *
 * `message` 默认英文；只有调用方传入 `language: "zh"` 时才出中文
 * （与会话偏好同一套 `UiLanguage`）。
 */
import type { Placement } from "./generate.js";
import type { WallRun } from "../floorplan/types.js";
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";
import {
  AISLE, COUNTERTOP, depthOf, gapBetween, hasContinuousCounter, toPlane,
  type KitchenPlan, type PlacedRun, type Rect,
} from "./plan-model.js";

/**
 * NKBA 净空要求（英寸）。
 * 核实：2026-08-08 对照公开 Kitchen Planning Guidelines PDF（见 LAUNCH_BLOCKERS A6）。
 */
export const CLEARANCE = {
  /** Cleanup/Prep Sink Landing：一侧 ≥24"，另一侧 ≥18"（NKBA Recommended）。 */
  sinkLandingPrimary: 24,
  sinkLandingSecondary: 18,
  /** Cooking Surface Landing：一侧 ≥15"，另一侧 ≥12"。**安全项**（放热锅）。 */
  cooktopLandingPrimary: 15,
  cooktopLandingSecondary: 12,
  /** Refrigerator Landing：把手侧 ≥15"（或对开任一侧 15"）。 */
  refrigeratorLanding: 15,
  /** Microwave Landing ≥15"（advisory）。 */
  microwaveLanding: 15,
  /** Dishwasher Placement：主洗碗最近边距水槽最近边 ≤36"。 */
  dishwasherToSinkMax: 36,
  /** 洗碗机一侧站立空间 ≥21"。 */
  dishwasherStanding: 21,
  /** Preparation/Work Area：连续备餐台面至少一段 ≥36"。 */
  continuousPrepSurface: 36,
  /** Work Triangle：单边 4–9 ft、总和 ≤26 ft（advisory）。 */
  workTriangleLegMin: 4 * 12,
  workTriangleLegMax: 9 * 12,
  workTriangleTotalMax: 26 * 12,
} as const;

export type ErgonomicCode =
  | "SINK_LANDING"
  | "COOKTOP_LANDING"
  | "REFRIGERATOR_LANDING"
  | "DISHWASHER_TOO_FAR"
  | "DISHWASHER_STANDING"
  | "NO_CONTINUOUS_PREP"
  | "WORK_TRIANGLE"
  | "UNREACHABLE_BLIND_CORNER"
  /** 岛台/半岛与对面柜列之间的过道太窄。 */
  | "AISLE_TOO_NARROW"
  | "AISLE_TOO_WIDE";

export interface ErgonomicViolation {
  code: ErgonomicCode;
  /** 硬约束违反会阻止方案出图；软性提示只是警告。 */
  severity: "blocking" | "advisory";
  message: string;
  wallRunId?: string;
}

interface Span {
  start: number;
  end: number;
}

/**
 * 找出水槽柜。
 *
 * 优先看排布器打的 `label`——型号命名各家不同（`SB36` / `NW-SK36` / 自有编码），
 * 靠字符串猜是不可靠的，这与 @ 路由不靠 LLM 猜公司名是同一条原则。
 */
function findSink(placements: readonly Placement[]): Placement | undefined {
  const byLabel = placements.find((p) => p.kind === "cabinet" && p.label === "sink");
  if (byLabel) return byLabel;
  // 按码兜底时要排掉**配套给家电的**那些：灶下柜可能就是一个水槽柜箱体
  // （假抽面、顶部开放），按码认会把灶当成水槽，然后拿灶的位置去判水槽工作区
  return placements.find(
    (p) => p.kind === "cabinet" && p.applianceKind === undefined
      && /^(SB|SK|FSB|APR)|[-_](SB|SK)/i.test(p.moduleCode ?? ""),
  );
}

/**
 * 某个位置左右两侧连续台面的长度。
 *
 * 台面 = 地柜层上**上方有连续台面**的那些构件连成的区段（`hasContinuousCounter`）。
 * 以前这里是「不是 appliance 的都算台面」，于是洗碗机把台面断成两截，
 * 水槽紧邻洗碗机那一侧的落台区恒为 0——而 NKBA 恰恰要求洗碗机紧邻水槽。
 * 排布器照着规范排，检查器照着自己的口径判，两边永远对不上。
 */
function landingAround(
  placements: readonly Placement[],
  runId: string,
  runLength: number,
  span: Span,
): { left: number; right: number } {
  const counterSpans = placements
    .filter((p) => p.wallRunId === runId && p.layer === "base" && hasContinuousCounter(p))
    .map((p) => ({ start: p.x, end: p.x + p.width }))
    .sort((a, b) => a.start - b.start);

  // 向左连续延伸
  let left = 0;
  let cursor = span.start;
  for (let i = counterSpans.length - 1; i >= 0; i--) {
    const c = counterSpans[i]!;
    if (Math.abs(c.end - cursor) < 0.26) {
      left += c.end - c.start;
      cursor = c.start;
    }
  }
  // 向右连续延伸
  let right = 0;
  cursor = span.end;
  for (const c of counterSpans) {
    if (Math.abs(c.start - cursor) < 0.26) {
      right += c.end - c.start;
      cursor = c.end;
    }
  }
  return { left: Math.min(left, runLength), right: Math.min(right, runLength) };
}

/** 检查一个位置两侧是否满足「一侧 ≥primary，另一侧 ≥secondary」。 */
function meetsTwoSided(
  landing: { left: number; right: number },
  primary: number,
  secondary: number,
): boolean {
  const [big, small] = landing.left >= landing.right
    ? [landing.left, landing.right]
    : [landing.right, landing.left];
  return big >= primary && small >= secondary;
}

export interface ErgonomicsInput {
  run: WallRun;
  placements: readonly Placement[];
  /** 是否已知洗碗机位置（没排洗碗机时跳过相关检查）。 */
  hasDishwasher?: boolean;
  /** 客户语言偏好。默认英文。 */
  language?: UiLanguage;
}

/**
 * 检查一段墙的人体工程约束。
 *
 * 只检查**能在单段墙内判定**的项；工作三角跨墙段，由 `checkWorkTriangle` 单独算。
 */
export function checkErgonomics(input: ErgonomicsInput): ErgonomicViolation[] {
  const { run, placements } = input;
  const lang = input.language ?? DEFAULT_LANGUAGE;
  const violations: ErgonomicViolation[] = [];
  const mine = placements.filter((p) => p.wallRunId === run.id);

  // ── 水槽两侧工作区 ──
  const sink = findSink(mine);
  if (sink) {
    // landingAround 从水槽两端向外走，本身已排除水槽柜——不要再减一次它的宽度
    const landing = landingAround(placements, run.id, run.length, { start: sink.x, end: sink.x + sink.width });
    if (!meetsTwoSided(landing, CLEARANCE.sinkLandingPrimary, CLEARANCE.sinkLandingSecondary)) {
      violations.push({
        code: "SINK_LANDING", severity: "blocking", wallRunId: run.id,
        message: msg(lang,
          `Sink landing is short (now ${round(landing.left)}" / ${round(landing.right)}";` +
            ` need ≥${CLEARANCE.sinkLandingPrimary}" on one side and ≥${CLEARANCE.sinkLandingSecondary}" on the other)`,
          `水槽两侧的台面工作区不足（现为 ${round(landing.left)}" / ${round(landing.right)}"，` +
            `需要一侧 ≥${CLEARANCE.sinkLandingPrimary}"、另一侧 ≥${CLEARANCE.sinkLandingSecondary}"）`),
      });
    }
  }

  // ── 灶具两侧落台区（安全要求）──
  // 认的是 `applianceKind`，不是 `kind === "appliance"`：嵌入式灶台落在**灶下柜**
  // 上（kind 是 cabinet），它两侧同样要留热锅落台区。只认 appliance 的话，
  // 换成嵌入式灶台这条安全检查就静默失效了。
  const cooktop = mine.find(
    (p) => p.applianceKind === "range" || p.applianceKind === "cooktop");
  if (cooktop) {
    const landing = landingAround(placements, run.id, run.length, { start: cooktop.x, end: cooktop.x + cooktop.width });
    if (!meetsTwoSided(landing, CLEARANCE.cooktopLandingPrimary, CLEARANCE.cooktopLandingSecondary)) {
      violations.push({
        code: "COOKTOP_LANDING", severity: "blocking", wallRunId: run.id,
        message: msg(lang,
          `Cooktop landing is short (now ${round(landing.left)}" / ${round(landing.right)}";` +
            ` need ≥${CLEARANCE.cooktopLandingPrimary}" / ≥${CLEARANCE.cooktopLandingSecondary}")` +
            ` — clearance for hot pans`,
          `灶具两侧的落台区不足（现为 ${round(landing.left)}" / ${round(landing.right)}"，` +
            `需要一侧 ≥${CLEARANCE.cooktopLandingPrimary}"、另一侧 ≥${CLEARANCE.cooktopLandingSecondary}"）` +
            `——这是放置热锅的安全空间`),
      });
    }
  }

  // ── 冰箱把手侧落台区 ──
  const fridge = mine.find((p) => p.kind === "appliance" && p.applianceKind === "refrigerator");
  if (fridge) {
    const landing = landingAround(placements, run.id, run.length, { start: fridge.x, end: fridge.x + fridge.width });
    if (Math.max(landing.left, landing.right) < CLEARANCE.refrigeratorLanding) {
      violations.push({
        code: "REFRIGERATOR_LANDING", severity: "blocking", wallRunId: run.id,
        message: msg(lang,
          `No ≥${CLEARANCE.refrigeratorLanding}" landing beside the fridge` +
            ` (now ${round(Math.max(landing.left, landing.right))}") — nowhere to set items down`,
          `冰箱旁没有 ≥${CLEARANCE.refrigeratorLanding}" 的落台区（现为 ` +
            `${round(Math.max(landing.left, landing.right))}"），拿出来的东西没地方放`),
      });
    }
  }

  // ── 洗碗机与水槽的关系 ──
  const dishwasher = mine.find((p) => p.kind === "appliance" && p.applianceKind === "dishwasher");
  if (dishwasher && sink) {
    const gap = dishwasher.x > sink.x
      ? dishwasher.x - (sink.x + sink.width)
      : sink.x - (dishwasher.x + dishwasher.width);
    if (gap > CLEARANCE.dishwasherToSinkMax) {
      violations.push({
        code: "DISHWASHER_TOO_FAR", severity: "blocking", wallRunId: run.id,
        message: msg(lang,
          `Dishwasher is ${round(gap)}" from the sink (max ${CLEARANCE.dishwasherToSinkMax}")` +
            ` — you'll drip across the floor loading dishes`,
          `洗碗机距水槽 ${round(gap)}"，超过 ${CLEARANCE.dishwasherToSinkMax}"——` +
            `每次装碗都要端着滴水的餐具走一段`),
      });
    }
  } else if (input.hasDishwasher && dishwasher && !sink) {
    violations.push({
      code: "DISHWASHER_TOO_FAR", severity: "advisory", wallRunId: run.id,
      message: msg(lang,
        "Dishwasher and sink are on different walls — confirm carry distance is acceptable",
        "洗碗机与水槽不在同一段墙上，请确认走水方便"),
    });
  }

  // ── 连续备餐台面 ──
  const longestRun = longestContinuousCounter(mine);
  if (longestRun > 0 && longestRun < CLEARANCE.continuousPrepSurface) {
    violations.push({
      code: "NO_CONTINUOUS_PREP", severity: "advisory", wallRunId: run.id,
      message: msg(lang,
        `Longest continuous counter is only ${round(longestRun)}";` +
          ` aim for at least one ${CLEARANCE.continuousPrepSurface}" prep run`,
        `最长的连续台面只有 ${round(longestRun)}"，建议至少留一段 ` +
          `${CLEARANCE.continuousPrepSurface}" 作为备餐区`),
    });
  }

  // ── 盲角可达性 ──
  for (const p of mine) {
    const code = p.moduleCode?.toUpperCase() ?? "";
    const isBlind = code.startsWith("BBC") || code.startsWith("WBC") || code.startsWith("WBBC")
      || p.faceTemplateId === "F10_BLIND_CORNER";
    if (isBlind) {
      violations.push({
        code: "UNREACHABLE_BLIND_CORNER", severity: "advisory", wallRunId: run.id,
        message: msg(lang,
          `${p.moduleCode} is a blind corner — deep storage is hard to reach;` +
            ` add a pull-out or switch to a diagonal corner (e.g. LSB)`,
          `${p.moduleCode} 是盲角柜，深处够不着——建议配拉篮，或换成转角柜（如 LSB）`),
      });
    }
  }

  return violations;
}

function longestContinuousCounter(placements: readonly Placement[]): number {
  const spans = placements
    .filter((p) => p.layer === "base" && hasContinuousCounter(p))
    .map((p) => ({ start: p.x, end: p.x + p.width }))
    .sort((a, b) => a.start - b.start);

  let best = 0;
  let current = 0;
  let cursor: number | undefined;
  for (const s of spans) {
    if (cursor !== undefined && Math.abs(s.start - cursor) < 0.26) {
      current += s.end - s.start;
    } else {
      current = s.end - s.start;
    }
    cursor = s.end;
    if (current > best) best = current;
  }
  return best;
}

// ── 工作三角（跨墙段）────────────────────────────────────────────────────

export interface TrianglePoint {
  kind: "sink" | "cooktop" | "refrigerator";
  /** 在整体平面里的坐标（英寸）。 */
  x: number;
  y: number;
}

/**
 * 工作三角检查。
 *
 * 需要各墙段在平面里的实际位置，故由调用方把「沿墙坐标」换算成平面坐标后传入。
 * 单边 4–9 ft、总和 ≤26 ft 是 NKBA 的常见表述。
 */
export function checkWorkTriangle(
  points: readonly TrianglePoint[],
  language: UiLanguage = DEFAULT_LANGUAGE,
): ErgonomicViolation[] {
  const sink = points.find((p) => p.kind === "sink");
  const cooktop = points.find((p) => p.kind === "cooktop");
  const fridge = points.find((p) => p.kind === "refrigerator");
  if (!sink || !cooktop || !fridge) return []; // 三点不全就不判定

  const legs: [string, string, number][] = [
    ["Sink↔cooktop", "水槽↔灶具", dist(sink, cooktop)],
    ["Cooktop↔fridge", "灶具↔冰箱", dist(cooktop, fridge)],
    ["Fridge↔sink", "冰箱↔水槽", dist(fridge, sink)],
  ];
  const total = legs.reduce((s, [, , d]) => s + d, 0);
  const violations: ErgonomicViolation[] = [];

  for (const [enName, zhName, d] of legs) {
    const name = msg(language, enName, zhName);
    if (d < CLEARANCE.workTriangleLegMin) {
      violations.push({
        code: "WORK_TRIANGLE", severity: "advisory",
        message: msg(language,
          `${name} is only ${round(d / 12)} ft (min ${CLEARANCE.workTriangleLegMin / 12} ft) — the work zone feels cramped`,
          `${name} 只有 ${round(d / 12)} 英尺，低于建议的 ${CLEARANCE.workTriangleLegMin / 12} 英尺，操作会显得局促`),
      });
    } else if (d > CLEARANCE.workTriangleLegMax) {
      violations.push({
        code: "WORK_TRIANGLE", severity: "advisory",
        message: msg(language,
          `${name} is ${round(d / 12)} ft (max ${CLEARANCE.workTriangleLegMax / 12} ft) — too much walking`,
          `${name} 有 ${round(d / 12)} 英尺，超过建议的 ${CLEARANCE.workTriangleLegMax / 12} 英尺，来回走动过多`),
      });
    }
  }
  if (total > CLEARANCE.workTriangleTotalMax) {
    violations.push({
      code: "WORK_TRIANGLE", severity: "advisory",
      message: msg(language,
        `Work triangle totals ${round(total / 12)} ft (max ${CLEARANCE.workTriangleTotalMax / 12} ft)`,
        `工作三角总长 ${round(total / 12)} 英尺，超过建议的 ${CLEARANCE.workTriangleTotalMax / 12} 英尺`),
    });
  }
  return violations;
}

// ── 过道净空（跨墙段）──────────────────────────────────────────────────
//
// 这一组检查**只有把各段墙连起来看才做得了**：过道是两列柜子之间的距离，
// 而那两列柜子分别属于不同的墙段。一段一段单独看，每一段都合格。
// 客户说的「只有把它们连起来的时候，才会发现开关门的问题、干涉的问题」，
// 指的就是这一类。

/**
 * 岛台与四周柜列之间的过道。
 *
 * 量的是**台面外沿之间**的距离，不是柜体箱体之间的——台面比箱体前伸 1-1/2"，
 * 两边各伸一次就是 3"，正好卡在 42" 与 39" 的分界上。按箱体量会算出一条
 * 实际上并不存在的合格过道。
 */
export function checkAisles(
  plan: KitchenPlan,
  language: UiLanguage = DEFAULT_LANGUAGE,
): ErgonomicViolation[] {
  const violations: ErgonomicViolation[] = [];
  const islands = plan.runs.filter((r) => r.island);
  if (islands.length === 0) return violations;

  for (const island of islands) {
    const a = counterFootprint(island);
    for (const other of plan.runs) {
      if (other === island) continue;
      const b = counterFootprint(other);
      const gap = gapBetween(a, b);
      // 完全错开的两列之间没有"过道"可言——间距要在**正对着**的时候才有意义
      if (!facesEachOther(a, b)) continue;

      if (gap < AISLE.walkway) {
        violations.push({
          code: "AISLE_TOO_NARROW", severity: "blocking", wallRunId: island.run.id,
          message: msg(language,
            `Aisle between ${island.run.label} and ${other.run.label} is only ${round(gap)}"` +
              ` (need ≥${AISLE.walkway}"). Narrow the island or drop a run.`,
            `${island.run.label}与${other.run.label}之间的过道只有 ${round(gap)}"，` +
              `人过不去（至少要 ${AISLE.walkway}"）。把岛台改窄或去掉一排柜子才放得下。`),
        });
      } else if (gap < AISLE.work) {
        violations.push({
          code: "AISLE_TOO_NARROW", severity: "advisory", wallRunId: island.run.id,
          message: msg(language,
            `Aisle between ${island.run.label} and ${other.run.label} is ${round(gap)}"` +
              ` (recommended ≥${AISLE.work}") — opposite doors will bump when you bend to open them.`,
            `${island.run.label}与${other.run.label}之间的过道 ${round(gap)}"，` +
              `低于建议的 ${AISLE.work}"——弯腰开下面的柜门时会顶到对面。`),
        });
      } else if (gap > AISLE.maxComfort) {
        violations.push({
          code: "AISLE_TOO_WIDE", severity: "advisory", wallRunId: island.run.id,
          message: msg(language,
            `Aisle between ${island.run.label} and ${other.run.label} is ${round(gap)}"` +
              ` (comfort max ~${AISLE.maxComfort}") — island feels too far from the run; enlarge the island or pull it closer.`,
            `${island.run.label}与${other.run.label}之间的过道 ${round(gap)}"，` +
              `超过舒适上限约 ${AISLE.maxComfort}"——岛台离主柜列太远，建议加大岛台或拉近。`),
        });
      }
    }
  }
  return violations;
}

/** 台面外沿围出来的矩形——过道量的是它，不是柜体箱体。 */
function counterFootprint(rp: PlacedRun): Rect {
  const depth = depthOf(rp, "base") + COUNTERTOP.frontOverhang;
  const a = toPlane(rp, 0, -(rp.island ? COUNTERTOP.frontOverhang : 0));
  const b = toPlane(rp, rp.run.length, depth);
  return {
    minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
  };
}

/**
 * 两块台面之间是不是真有一条过道。
 *
 * 要求**恰好一个轴向有重叠投影**：另一个轴向必须错开，那个缝就是过道。
 * 两轴都重叠说明它们本身叠在一起（那是干涉，由 `audit.ts` 的 `INTERFERENCE`
 * 报，报成"0 寸过道"只会误导）；两轴都不重叠则是斜对角，中间不成其为过道。
 *
 * 判据与 `plan-view.ts` 画过道尺寸的 `aisleSegment` 一致——**图上画得出尺寸线的
 * 地方才判过道**，否则会出现"检查说过道不够、图上却找不到那条过道"。
 */
function facesEachOther(a: Rect, b: Rect): boolean {
  const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const overlapY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return (overlapX > 0) !== (overlapY > 0);
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 方案是否因硬约束被否决。 */
export function hasBlockingViolation(violations: readonly ErgonomicViolation[]): boolean {
  return violations.some((v) => v.severity === "blocking");
}
