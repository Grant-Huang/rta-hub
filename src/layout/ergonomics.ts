/**
 * 人体工程与安全约束 —— 排布的**硬约束**。
 *
 * 这些不是偏好，违反了方案就不能出：灶台旁没有落台区意味着端下来的热锅无处可放，
 * 洗碗机离水槽太远意味着每次都要滴一路水。它们与「省钱好装」是不同维度的要求，
 * 不能靠目标函数里的权重来平衡——权重再低也可能被便宜方案压过去。
 *
 * ⚠️ **数值来源**：以下净空取自北美 NKBA（National Kitchen & Bath Association）
 * 厨房规划指南的常见表述。与税率同样处理：**这是种子数据，上线前必须核对
 * 现行版本**（见 PRE_LAUNCH_CHECKLIST）。数值集中在此处，改数值不用改逻辑。
 */
import type { Placement } from "./generate.js";
import type { WallRun } from "../floorplan/types.js";

/** NKBA 净空要求（英寸）。 */
export const CLEARANCE = {
  /** 水槽两侧台面工作区：一侧 ≥24"，另一侧 ≥18"。 */
  sinkLandingPrimary: 24,
  sinkLandingSecondary: 18,
  /** 灶具两侧落台区：一侧 ≥15"，另一侧 ≥12"。**安全要求**（放热锅）。 */
  cooktopLandingPrimary: 15,
  cooktopLandingSecondary: 12,
  /** 冰箱把手侧落台区 ≥15"。 */
  refrigeratorLanding: 15,
  /** 微波炉落台区 ≥15"。 */
  microwaveLanding: 15,
  /** 洗碗机边缘距水槽最近边 ≤36"。 */
  dishwasherToSinkMax: 36,
  /** 洗碗机一侧站立空间 ≥21"。 */
  dishwasherStanding: 21,
  /** 连续备餐台面至少一段 ≥36"。 */
  continuousPrepSurface: 36,
  /** 工作三角单边范围与总和（英尺 → 英寸）。 */
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
  | "UNREACHABLE_BLIND_CORNER";

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

/** 某个位置左右两侧连续台面的长度。台面 = 地柜层上不是家电、不是门洞的连续区段。 */
function landingAround(
  placements: readonly Placement[],
  runId: string,
  runLength: number,
  span: Span,
): { left: number; right: number } {
  const counterSpans = placements
    .filter((p) => p.wallRunId === runId && p.layer === "base" && p.kind !== "appliance")
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
}

/**
 * 检查一段墙的人体工程约束。
 *
 * 只检查**能在单段墙内判定**的项；工作三角跨墙段，由 `checkWorkTriangle` 单独算。
 */
export function checkErgonomics(input: ErgonomicsInput): ErgonomicViolation[] {
  const { run, placements } = input;
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
        message: `水槽两侧的台面工作区不足（现为 ${round(landing.left)}" / ${round(landing.right)}"，` +
          `需要一侧 ≥${CLEARANCE.sinkLandingPrimary}"、另一侧 ≥${CLEARANCE.sinkLandingSecondary}"）`,
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
        message: `灶具两侧的落台区不足（现为 ${round(landing.left)}" / ${round(landing.right)}"，` +
          `需要一侧 ≥${CLEARANCE.cooktopLandingPrimary}"、另一侧 ≥${CLEARANCE.cooktopLandingSecondary}"）` +
          `——这是放置热锅的安全空间`,
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
        message: `冰箱旁没有 ≥${CLEARANCE.refrigeratorLanding}" 的落台区（现为 ` +
          `${round(Math.max(landing.left, landing.right))}"），拿出来的东西没地方放`,
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
        message: `洗碗机距水槽 ${round(gap)}"，超过 ${CLEARANCE.dishwasherToSinkMax}"——` +
          `每次装碗都要端着滴水的餐具走一段`,
      });
    }
  } else if (input.hasDishwasher && dishwasher && !sink) {
    violations.push({
      code: "DISHWASHER_TOO_FAR", severity: "advisory", wallRunId: run.id,
      message: "洗碗机与水槽不在同一段墙上，请确认走水方便",
    });
  }

  // ── 连续备餐台面 ──
  const longestRun = longestContinuousCounter(mine);
  if (longestRun > 0 && longestRun < CLEARANCE.continuousPrepSurface) {
    violations.push({
      code: "NO_CONTINUOUS_PREP", severity: "advisory", wallRunId: run.id,
      message: `最长的连续台面只有 ${round(longestRun)}"，建议至少留一段 ` +
        `${CLEARANCE.continuousPrepSurface}" 作为备餐区`,
    });
  }

  // ── 盲角可达性 ──
  for (const p of mine) {
    const code = p.moduleCode?.toUpperCase() ?? "";
    if (code.startsWith("BBC") || code.startsWith("WBC") || code.startsWith("WBBC")) {
      violations.push({
        code: "UNREACHABLE_BLIND_CORNER", severity: "advisory", wallRunId: run.id,
        message: `${p.moduleCode} 是盲角柜，深处够不着——建议配拉篮，或换成转角柜（如 LSB）`,
      });
    }
  }

  return violations;
}

function longestContinuousCounter(placements: readonly Placement[]): number {
  const spans = placements
    .filter((p) => p.layer === "base" && p.kind !== "appliance")
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
export function checkWorkTriangle(points: readonly TrianglePoint[]): ErgonomicViolation[] {
  const sink = points.find((p) => p.kind === "sink");
  const cooktop = points.find((p) => p.kind === "cooktop");
  const fridge = points.find((p) => p.kind === "refrigerator");
  if (!sink || !cooktop || !fridge) return []; // 三点不全就不判定

  const legs: [string, number][] = [
    ["水槽↔灶具", dist(sink, cooktop)],
    ["灶具↔冰箱", dist(cooktop, fridge)],
    ["冰箱↔水槽", dist(fridge, sink)],
  ];
  const total = legs.reduce((s, [, d]) => s + d, 0);
  const violations: ErgonomicViolation[] = [];

  for (const [name, d] of legs) {
    if (d < CLEARANCE.workTriangleLegMin) {
      violations.push({
        code: "WORK_TRIANGLE", severity: "advisory",
        message: `${name} 只有 ${round(d / 12)} 英尺，低于建议的 ${CLEARANCE.workTriangleLegMin / 12} 英尺，操作会显得局促`,
      });
    } else if (d > CLEARANCE.workTriangleLegMax) {
      violations.push({
        code: "WORK_TRIANGLE", severity: "advisory",
        message: `${name} 有 ${round(d / 12)} 英尺，超过建议的 ${CLEARANCE.workTriangleLegMax / 12} 英尺，来回走动过多`,
      });
    }
  }
  if (total > CLEARANCE.workTriangleTotalMax) {
    violations.push({
      code: "WORK_TRIANGLE", severity: "advisory",
      message: `工作三角总长 ${round(total / 12)} 英尺，超过建议的 ${CLEARANCE.workTriangleTotalMax / 12} 英尺`,
    });
  }
  return violations;
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
