/**
 * 一维排布（cut-list optimization）—— REQUIREMENTS 3.3 第 1 点、FR-4。
 *
 * **确定性算法，非 AI。** 给定一段可用长度 + 该公司规格库里的离散宽度候选集，
 * 求一组柜体使剩余空间最小。剩余空间由填缝条（filler）吸收。
 *
 * 用 1/4 英寸为单位的整数 DP，避免浮点累积误差（与 money.ts 同思路）。
 */
import { PRECISION_INCHES } from "../floorplan/types.js";

/** 行业惯例：单条填缝条最宽 6"，一段墙最多 2 条（规范文档第六节 WF3/WF6、BF3/BF6）。 */
export const MAX_FILLER_WIDTH = 6;
export const MAX_FILLERS_PER_SEGMENT = 2;

const UNIT = PRECISION_INCHES;
const toUnits = (inches: number): number => Math.round(inches / UNIT);
const toInches = (units: number): number => units * UNIT;

export interface PackCandidate {
  /** 宽度（英寸），必须是该公司规格里真实存在的离散值。 */
  width: number;
  /** 用于在等价方案里做偏好排序；数值越小越优先（如常用型号优先）。 */
  preference?: number;
}

export interface PackResult {
  /** 选中的宽度序列，按摆放顺序。 */
  widths: number[];
  /** 未被柜体占用的剩余长度（英寸），由填缝条吸收。 */
  leftover: number;
  /** 是否可行：剩余长度能被允许的填缝条吸收。 */
  feasible: boolean;
  reason?: string;
}

/**
 * 在长度 `segmentLength` 内选一组柜体宽度，使剩余最小。
 *
 * 目标函数（按优先级）：
 *   1. 剩余长度最小；
 *   2. 柜体数量最少（少接缝、少五金、装得快）；
 *   3. 偏好值总和最小（让调用方能表达"常用型号优先"）。
 *
 * 复杂度 O(L × |W|)，L 是 1/4 英寸单位数。240" 的墙也只有 960 个状态。
 */
export function packSegment(segmentLength: number, candidates: readonly PackCandidate[]): PackResult {
  const L = toUnits(segmentLength);
  if (L <= 0) {
    return { widths: [], leftover: 0, feasible: true };
  }
  const usable = candidates.filter((c) => c.width > 0 && toUnits(c.width) <= L);
  if (usable.length === 0) {
    return {
      widths: [], leftover: segmentLength, feasible: false,
      reason: `没有宽度 ≤ ${segmentLength}" 的可用型号`,
    };
  }

  interface Cell { filled: number; count: number; pref: number; from: number; width: number }
  // best[l] = 在长度 l 内能达到的最优解
  const best: (Cell | undefined)[] = new Array<Cell | undefined>(L + 1);
  best[0] = { filled: 0, count: 0, pref: 0, from: -1, width: 0 };

  for (let l = 1; l <= L; l++) {
    // 不放任何东西也是一个解（继承 l-1 的最优）
    let cur: Cell | undefined = best[l - 1] ? { ...best[l - 1]!, from: l - 1, width: 0 } : undefined;

    for (const cand of usable) {
      const w = toUnits(cand.width);
      if (w > l) continue;
      const prev = best[l - w];
      if (!prev) continue;
      const next: Cell = {
        filled: prev.filled + w,
        count: prev.count + 1,
        pref: prev.pref + (cand.preference ?? 0),
        from: l - w,
        width: cand.width,
      };
      if (!cur || better(next, cur)) cur = next;
    }
    best[l] = cur;
  }

  const final = best[L];
  if (!final) {
    return { widths: [], leftover: segmentLength, feasible: false, reason: "无解" };
  }

  // 回溯
  const widths: number[] = [];
  let l = L;
  while (l > 0) {
    const cell = best[l];
    if (!cell || cell.from < 0) break;
    if (cell.width > 0) widths.push(cell.width);
    l = cell.from;
  }
  widths.reverse();

  const leftover = toInches(L - final.filled);
  const fillersNeeded = leftover > 0 ? 1 : 0;
  return {
    widths,
    leftover,
    feasible: leftover <= MAX_FILLER_WIDTH * MAX_FILLERS_PER_SEGMENT,
    ...(leftover > MAX_FILLER_WIDTH * MAX_FILLERS_PER_SEGMENT
      ? { reason: `剩余 ${leftover}" 超过 ${MAX_FILLERS_PER_SEGMENT} 条 ${MAX_FILLER_WIDTH}" 填缝条能吸收的范围` }
      : {}),
    ...(fillersNeeded ? {} : {}),
  };
}

function better(a: { filled: number; count: number; pref: number }, b: { filled: number; count: number; pref: number }): boolean {
  if (a.filled !== b.filled) return a.filled > b.filled;   // 填得更满
  if (a.count !== b.count) return a.count < b.count;        // 柜子更少
  return a.pref < b.pref;                                   // 偏好更优
}

/**
 * 把剩余长度分配成填缝条。
 *
 * 行业做法是把填缝放在**靠墙一侧**（门板打墙），所以返回的是"两端各多少"，
 * 而不是平均塞在柜子中间。
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
  // 两端均分，余数给起点（靠墙侧优先吃掉大的）
  const half = Math.round(leftover / UNIT / 2) * UNIT;
  const start = half;
  const end = Math.round((leftover - half) / UNIT) * UNIT;
  return { start, end, feasible: start <= MAX_FILLER_WIDTH && end <= MAX_FILLER_WIDTH };
}
