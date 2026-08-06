/**
 * 一维排布（cut-list optimization）—— REQUIREMENTS 3.3 第 1 点、FR-4。
 *
 * **确定性算法，非 AI。** 给定一段可用长度 + 该公司规格库里的离散宽度候选集，
 * 求一组柜体。用 1/4 英寸为单位的整数 DP，避免浮点累积误差。
 *
 * ## 目标函数不只是「填得满、柜子少」
 *
 * 早期版本只做这两条，结果会主动产出这种排布：
 *
 *   36, 9, 30, 12, 33   ← 填满了，柜子也不多，但宽度跳来跳去、还塞了两个窄柜
 *   36, 33, 30, 30      ← 造价接近，观感好得多
 *
 * 所以 DP 状态里带上「上一个柜宽」，把**宽度节奏**与**窄柜惩罚**直接编进代价，
 * 而不是事后再挑。状态规模 O(L × |W|)——240" 墙 × 10 种宽度也只有约 1 万个状态。
 *
 * 人体工程的硬约束（灶台落台区等）不在这里——它们不是权重问题，
 * 见 `ergonomics.ts`。
 */
import { PRECISION_INCHES } from "../floorplan/types.js";
import { NARROW_THRESHOLD } from "./aesthetics.js";

/** 行业惯例：单条填缝条最宽 6"，一段墙最多 2 条（规范文档第六节 WF3/WF6、BF3/BF6）。 */
export const MAX_FILLER_WIDTH = 6;
export const MAX_FILLERS_PER_SEGMENT = 2;

const UNIT = PRECISION_INCHES;
const toUnits = (inches: number): number => Math.round(inches / UNIT);
const toInches = (units: number): number => units * UNIT;

export interface PackCandidate {
  /** 宽度（英寸），必须是该公司规格里真实存在的离散值。 */
  width: number;
  /** 偏好值，越小越优先（如常用型号优先）。 */
  preference?: number;
  /**
   * 该宽度是否有明确功能（拉篮/垃圾柜）。
   *
   * 注意语义是「少量可以接受」而不是「随便塞」——一整排 9" 拉篮柜既不好用也不好看。
   * 因此它只把窄柜惩罚**打折**（见 FUNCTIONAL_NARROW_DISCOUNT），不是免除。
   */
  functionalNarrow?: boolean;
}

export interface PackOptions {
  /** 宽度节奏权重：相邻柜宽差异的惩罚系数。 */
  rhythmWeight?: number;
  /** 窄柜惩罚权重。 */
  narrowWeight?: number;
  /** 柜体数量惩罚（造价与安装工时的代理）。 */
  countWeight?: number;
  /**
   * 希望柜缝落在这些位置（相对本段起点的英寸）。
   * 用于吊柜对齐地柜缝——正视图上上下分隔线对齐会整齐很多。
   */
  preferredSeams?: number[];
  /** 对齐奖励权重。 */
  seamWeight?: number;
}

const DEFAULTS: Required<Omit<PackOptions, "preferredSeams">> = {
  rhythmWeight: 1.0,
  narrowWeight: 8.0,
  countWeight: 1.5,
  seamWeight: 4.0,
};

const SEAM_TOLERANCE_UNITS = toUnits(1);

/**
 * 功能性窄柜的惩罚折扣。
 *
 * 取 0.25：一个 9" 调味品拉篮柜代价很低（约 2），排得下就用；
 * 但五个连排要付 5×2=10，会输给「一个 36" + 一个 9"」的组合。
 * 这正是想要的行为——功能性窄柜是点缀，不是填充手段。
 */
const FUNCTIONAL_NARROW_DISCOUNT = 0.25;

export interface PackResult {
  /** 选中的宽度序列，按摆放顺序。 */
  widths: number[];
  /** 未被柜体占用的剩余长度（英寸），由填缝条吸收。 */
  leftover: number;
  /** 是否可行：剩余长度能被允许的填缝条吸收。 */
  feasible: boolean;
  /** 代价明细，便于解释"为什么选了这一版"。各项之和 = total。 */
  cost: {
    rhythm: number; narrow: number; count: number; seam: number;
    /** 型号偏好（如高频区偏向有抽屉柜的宽度）。 */
    preference: number;
    total: number;
  };
  reason?: string;
}

interface Cell {
  filled: number;
  cost: number;
  count: number;
  from: number;
  /** 到达本状态时放下的柜宽（英寸）；0 表示没放。 */
  width: number;
  /** 前驱状态的 lastWidth 索引。 */
  fromIdx: number;
}

/**
 * 在长度 `segmentLength` 内选一组柜体宽度。
 *
 * 目标（按优先级）：
 *   1. **填得最满**（剩余越小越好，硬性）；
 *   2. 在同等填充度下，**代价最小**——代价 = 宽度跳动 + 窄柜 + 数量 − 缝对齐奖励。
 */
export function packSegment(
  segmentLength: number,
  candidates: readonly PackCandidate[],
  opts: PackOptions = {},
): PackResult {
  const o = { ...DEFAULTS, ...opts };
  const zeroCost = { rhythm: 0, narrow: 0, count: 0, seam: 0, preference: 0, total: 0 };
  const L = toUnits(segmentLength);
  if (L <= 0) return { widths: [], leftover: 0, feasible: true, cost: zeroCost };

  const usable = candidates.filter((c) => c.width > 0 && toUnits(c.width) <= L);
  if (usable.length === 0) {
    return {
      widths: [], leftover: segmentLength, feasible: false, cost: zeroCost,
      reason: `没有宽度 ≤ ${segmentLength}" 的可用型号`,
    };
  }

  const seamUnits = (opts.preferredSeams ?? []).map(toUnits);
  const nearSeam = (pos: number): boolean =>
    seamUnits.some((s) => Math.abs(s - pos) <= SEAM_TOLERANCE_UNITS);

  // best[l][k]：长度 l、最后一个柜子是 usable[k]（k = usable.length 表示还没放柜子）
  const NONE = usable.length;
  const best: (Cell | undefined)[][] = Array.from(
    { length: L + 1 },
    () => new Array<Cell | undefined>(NONE + 1).fill(undefined),
  );
  best[0]![NONE] = { filled: 0, cost: 0, count: 0, from: -1, width: 0, fromIdx: NONE };

  for (let l = 1; l <= L; l++) {
    for (let k = 0; k <= NONE; k++) {
      // 分支 A：本单位不放东西（留给填缝），继承 l-1 的同状态
      const carry = best[l - 1]![k];
      if (carry) {
        const cur = best[l]![k];
        if (!cur || better({ ...carry, filled: carry.filled }, cur)) {
          best[l]![k] = { ...carry, from: l - 1, width: 0, fromIdx: k };
        }
      }
    }

    // 分支 B：在此处结束一个柜子
    for (let k = 0; k < NONE; k++) {
      const cand = usable[k]!;
      const w = toUnits(cand.width);
      if (w > l) continue;

      for (let prev = 0; prev <= NONE; prev++) {
        const from = best[l - w]![prev];
        if (!from) continue;

        let delta = o.countWeight + (cand.preference ?? 0);
        // 宽度节奏：与上一个柜宽的差
        if (prev !== NONE) {
          delta += (Math.abs(cand.width - usable[prev]!.width) / 3) * o.rhythmWeight;
        }
        // 窄柜惩罚。有功能理由的打折而非免除——见 FUNCTIONAL_NARROW_DISCOUNT
        if (cand.width < NARROW_THRESHOLD) {
          delta += cand.functionalNarrow
            ? o.narrowWeight * FUNCTIONAL_NARROW_DISCOUNT
            : o.narrowWeight;
        }
        // 缝对齐奖励
        if (seamUnits.length > 0 && nearSeam(l)) delta -= o.seamWeight;

        const next: Cell = {
          filled: from.filled + w,
          cost: from.cost + delta,
          count: from.count + 1,
          from: l - w,
          width: cand.width,
          fromIdx: prev,
        };
        const cur = best[l]![k];
        if (!cur || better(next, cur)) best[l]![k] = next;
      }
    }
  }

  // 在终点取所有 lastWidth 状态里的最优
  let final: Cell | undefined;
  let finalIdx = NONE;
  for (let k = 0; k <= NONE; k++) {
    const cell = best[L]![k];
    if (cell && (!final || better(cell, final))) { final = cell; finalIdx = k; }
  }
  if (!final) {
    return { widths: [], leftover: segmentLength, feasible: false, cost: zeroCost, reason: "无解" };
  }

  // 回溯
  const widths: number[] = [];
  let l = L;
  let k = finalIdx;
  while (l > 0) {
    const cell = best[l]![k];
    if (!cell || cell.from < 0) break;
    if (cell.width > 0) widths.push(cell.width);
    const nextL = cell.from;
    const nextK = cell.fromIdx;
    l = nextL;
    k = nextK;
  }
  widths.reverse();

  const leftover = toInches(L - final.filled);
  return {
    widths,
    leftover,
    feasible: leftover <= MAX_FILLER_WIDTH * MAX_FILLERS_PER_SEGMENT,
    cost: explainCost(widths, usable, o, seamUnits),
    ...(leftover > MAX_FILLER_WIDTH * MAX_FILLERS_PER_SEGMENT
      ? { reason: `剩余 ${leftover}" 超过 ${MAX_FILLERS_PER_SEGMENT} 条 ${MAX_FILLER_WIDTH}" 填缝条能吸收的范围` }
      : {}),
  };
}

function better(a: Cell, b: Cell): boolean {
  if (a.filled !== b.filled) return a.filled > b.filled;
  return a.cost < b.cost;
}

function explainCost(
  widths: readonly number[],
  usable: readonly PackCandidate[],
  o: Required<Omit<PackOptions, "preferredSeams">>,
  seamUnits: readonly number[],
): PackResult["cost"] {
  let rhythm = 0;
  for (let i = 1; i < widths.length; i++) {
    rhythm += (Math.abs(widths[i]! - widths[i - 1]!) / 3) * o.rhythmWeight;
  }
  let narrow = 0;
  for (const w of widths) {
    if (w >= NARROW_THRESHOLD) continue;
    const cand = usable.find((c) => c.width === w);
    narrow += cand?.functionalNarrow
      ? o.narrowWeight * FUNCTIONAL_NARROW_DISCOUNT
      : o.narrowWeight;
  }

  let seam = 0;
  if (seamUnits.length > 0) {
    let pos = 0;
    for (const w of widths) {
      pos += toUnits(w);
      if (seamUnits.some((s) => Math.abs(s - pos) <= SEAM_TOLERANCE_UNITS)) seam -= o.seamWeight;
    }
  }
  // 偏好也要出现在明细里——它参与了 DP 决策，不列出来就没法解释结果
  const preference = widths.reduce(
    (sum, w) => sum + (usable.find((c) => c.width === w)?.preference ?? 0), 0,
  );
  const count = widths.length * o.countWeight;
  return {
    rhythm, narrow, count, seam, preference,
    total: rhythm + narrow + count + seam + preference,
  };
}

/**
 * 把剩余长度分配成填缝条。
 *
 * 填缝条必须放在**靠墙一侧**：夹在两个柜子中间的一条 3" 窄板会立刻打断门缝节奏，
 * 是正视图上最扎眼的瑕疵之一（见 aesthetics.ts 的 fillerPlacement 项）。
 */
export function allocateFillers(leftover: number, opts: { atStart: boolean; atEnd: boolean }): {
  start: number; end: number; feasible: boolean;
} {
  if (leftover <= 0) return { start: 0, end: 0, feasible: true };
  const slots = (opts.atStart ? 1 : 0) + (opts.atEnd ? 1 : 0);
  if (slots === 0) return { start: 0, end: 0, feasible: false };

  if (slots === 1) {
    const value = leftover;
    return opts.atStart
      ? { start: value, end: 0, feasible: value <= MAX_FILLER_WIDTH }
      : { start: 0, end: value, feasible: value <= MAX_FILLER_WIDTH };
  }
  const half = Math.round(leftover / UNIT / 2) * UNIT;
  const start = half;
  const end = Math.round((leftover - half) / UNIT) * UNIT;
  return { start, end, feasible: start <= MAX_FILLER_WIDTH && end <= MAX_FILLER_WIDTH };
}
