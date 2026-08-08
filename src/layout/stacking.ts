/**
 * 叠装吊柜求解 —— CATALOG_MODEL.md §3。
 *
 * > 现在的房子都比较高，如果上柜高度达到 51 寸，那么肯定需要拼。
 *
 * ## 这是一个求解，不是一个开关
 *
 * 给定目标高度 H 与该商家真实存在的高度档位集合，要找一组高度使得
 * `Σ hᵢ + (n−1) × 接缝损耗` 尽量贴近 H。
 *
 * 约束与偏好（§3.2）：
 *
 *   - **硬**：每一段都是该商家真实存在的档位（与 FR-8 同源——不许现编尺寸）；
 *   - **硬**：上段必须 `stacking.asUpper`，下段必须 `stacking.asLower`；
 *   - **偏好**：段数越少越好（缝少、装得快、便宜）；
 *   - **偏好**：下段更高（视觉重心在下，常用高度也在下段）；
 *   - **偏好**：同一面墙上的横缝**高度一致**。
 *
 * ## 最后一条为什么不能在"给每个柜子单独求解"的循环里做
 *
 * 接缝高度一致是**跨柜体**的约束。逐柜求解的话，48" 的这个柜可能解成 30+18，
 * 旁边那个解成 36+12——两条横缝差 6"，正视图上是一条锯齿线。所以流程必须是
 * **先在墙段层面定下接缝高度，再让每个柜子照着这个高度去解**。
 *
 * ## 解不出来的时候要如实说
 *
 * `H = 48"` 而档位只有 `{30, 36, 42}`：42+6 没有 6" 的档位，无解。那就退回
 * 「42" 单柜 + 6" 顶线加高」并在解释里说清楚，**不能静默地把 48" 变成 42"**
 * （§3.3，与 §1.2 同一条原则）。
 */
import type { ModuleSpec } from "../domain/types.js";
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";
import { capabilitiesFor } from "../spec/capabilities.js";

/**
 * 叠装接缝损耗（英寸）。
 *
 * ⚠️ **各家做法不同**（有的柜体直接叠、有的加一条 1/4" 的过渡条），
 * CATALOG_MODEL.md §待定问题里列着这一条。现在取 0——直接叠是最常见的做法，
 * 而且取 0 时求解结果最容易核对。商家能声明自己的值时改这里一处。
 */
export const STACK_SEAM_LOSS = 0;

/** 一段吊柜可用高度里排出来的方案。 */
export interface StackSolution {
  /** 从下到上的各段高度。长度 1 表示单柜，不需要叠装。 */
  heights: number[];
  /** 各段之间的接缝**离吊柜底边**的高度。单柜时为空。 */
  seams: number[];
  /** 这套方案实际占的高度。 */
  filled: number;
  /** 与目标高度的差。>0 表示顶上还留着这么多，要用顶线收口。 */
  shortfall: number;
  /** 解不出精确匹配时的说明。**有值就必须告诉客户**（§3.3）。 */
  note?: string;
}

export interface StackOptions {
  /**
   * 这面墙已经定下来的接缝高度。
   *
   * 传了就**只接受在这个高度上有缝的方案**——同一面墙的横缝要在一条线上。
   * 传空表示这一段自己定，定完的结果由调用方拿去约束同墙的其余柜子。
   */
  seams?: readonly number[];
  /** 允许顶上留多少空当（用顶线收口）。超过这个值就认为这个解不可接受。 */
  maxShortfall?: number;
  /** 最多几段。段数越多缝越多，通常 2 段就够。 */
  maxSegments?: number;
  /** 客户语言偏好；`note` 跟它走，默认英文。 */
  language?: UiLanguage;
}

const DEFAULTS = { maxShortfall: 6, maxSegments: 3 } as const;

/** 四分之一英寸为单位，避免浮点比较。 */
const U = 4;
const toUnits = (inches: number) => Math.round(inches * U);

export interface StackCandidate {
  height: number;
  asLower: boolean;
  asUpper: boolean;
}

/**
 * 从规格库里取出可用于叠装的高度档位。
 *
 * 按**能力**取（`stacking`），不按型号码——第二家公司的吊柜叫 `NW-W3030`，
 * 按 `W` 前缀判在第三家上就失效了。`monolithic` 的（通高 pantry）不参与：
 * 它本来就是一个箱体，拆开就不是这家的产品了。
 */
export function stackCandidates(
  modules: readonly ModuleSpec[],
  widths?: number | readonly number[],
): StackCandidate[] {
  // **高度档位是随宽度变的**。试点公司只有 36" 宽的柜子有 12/15/18" 的矮档
  // （`W3618`），30" 宽的最矮就是 30"。
  //
  // 传一组宽度时，先算出**每个宽度各自有哪些高度**，再取交集——这面墙上
  // 每一列都得能排出这套高度。各宽度各解各的话，36" 那几列拼到 60"、
  // 24/30" 那几列只到 42"，同一面墙上柜顶高低不齐，比接缝不对齐还难看。
  // 整面墙统一是软约束里优先级最高的一条（CATALOG_MODEL §3.2）。
  //
  // ⚠️ 交集是**按高度**取的，不是"找一个同时有这些宽度的型号"——
  // 多数商家一个型号只有一个宽度（`W3030` 就是 30"），按型号取交集永远是空的。
  const need = widths === undefined ? []
    : typeof widths === "number" ? [widths] : [...new Set(widths)];

  const perWidth = new Map<number, Map<number, StackCandidate>>();
  const all = new Map<number, StackCandidate>();

  for (const m of modules) {
    if (m.type !== "wall") continue;
    const caps = capabilitiesFor(m).capabilities;
    if (caps.monolithic) continue;
    const stacking = caps.stacking;
    if (!stacking) continue;

    for (const h of m.heightOptions) {
      const merge = (into: Map<number, StackCandidate>) => {
        const cur = into.get(h);
        into.set(h, {
          height: h,
          asLower: (cur?.asLower ?? false) || stacking.asLower,
          asUpper: (cur?.asUpper ?? false) || stacking.asUpper,
        });
      };
      merge(all);
      for (const w of m.widthOptions) {
        if (need.length > 0 && !need.includes(w)) continue;
        merge(perWidth.get(w) ?? perWidth.set(w, new Map()).get(w)!);
      }
    }
  }

  if (need.length === 0) return [...all.values()].sort((a, b) => b.height - a.height);

  // 交集：只有**每个用到的宽度都提供**的高度才算数
  const out: StackCandidate[] = [];
  for (const [h, candidate] of all) {
    const everyWidthHasIt = need.every((w) => perWidth.get(w)?.has(h));
    if (everyWidthHasIt) out.push(candidate);
  }
  return out.sort((a, b) => b.height - a.height);
}

/**
 * 给一段可用高度求一套叠装方案。
 *
 * 返回的一定是**能落地的**：每一段都是真实档位，上下段的能力都对得上。
 * 求不出贴合的就退回单柜 + 顶线，并在 `note` 里说清楚。
 */
export function solveStack(
  available: number,
  candidates: readonly StackCandidate[],
  opts: StackOptions = {},
): StackSolution | undefined {
  const o = { ...DEFAULTS, ...opts };
  const lang = opts.language ?? DEFAULT_LANGUAGE;
  if (available <= 0 || candidates.length === 0) return undefined;

  const target = toUnits(available);
  const seam = toUnits(STACK_SEAM_LOSS);
  const wantSeams = (opts.seams ?? []).map(toUnits);

  let best: { heights: number[]; filled: number; cost: number } | undefined;

  // 段数不多（≤3），直接枚举。DP 在这里没有意义，而枚举读起来是对的。
  const walk = (stack: StackCandidate[], filled: number) => {
    if (stack.length > 0) {
      const shortfall = target - filled;
      if (shortfall >= 0 && shortfall <= toUnits(o.maxShortfall)) {
        const heights = stack.map((c) => c.height);
        const seams = seamsOf(heights);
        // 墙段已经定了缝高就必须对上——一条锯齿线比一条缝难看得多
        const seamsOk = wantSeams.length === 0
          || (seams.length === wantSeams.length
            && seams.every((s, i) => Math.abs(toUnits(s) - wantSeams[i]!) < 1));
        if (seamsOk) {
          const cost = costOf(stack, shortfall);
          if (!best || cost < best.cost) best = { heights, filled, cost };
        }
      }
    }
    if (stack.length >= o.maxSegments) return;
    for (const c of candidates) {
      // 第一段是最下面那一段
      const okAsPart = stack.length === 0 ? c.asLower : c.asUpper;
      if (!okAsPart) continue;
      const next = filled + toUnits(c.height) + (stack.length === 0 ? 0 : seam);
      if (next > target) continue;
      stack.push(c);
      walk(stack, next);
      stack.pop();
    }
  };
  walk([], 0);

  if (best) {
    const filled = best.filled / U;
    const shortfall = round(available - filled);
    return {
      heights: best.heights,
      seams: seamsOf(best.heights),
      filled,
      shortfall,
      // 顶上留了空当同样要说。客户要知道那 6" 是顶线不是柜子——
      // 「做到顶」和「差一截用线条收口」在成品上是两个样子，而且价格不同。
      ...(shortfall > 0.01
        ? {
            note: msg(lang,
              `Wall-cabinet height budget ${round(available)}"; stacked as ${best.heights.join("+")}"` +
                ` with ${shortfall}" left for a taller crown molding — not floor-to-ceiling.`,
              `吊柜可用高度 ${round(available)}"，排成 ${best.heights.join("+")}"，` +
                `顶上余 ${shortfall}" 用加高顶线收口——不是做到顶。`),
          }
        : {}),
    };
  }

  // 解不出来：退回单柜 + 顶线收口，**并说清楚**（§3.3）
  const single = candidates
    .filter((c) => c.asLower && c.height <= available)
    .sort((a, b) => b.height - a.height)[0];
  if (!single) return undefined;
  const leftover = round(available - single.height);
  return {
    heights: [single.height],
    seams: [],
    filled: single.height,
    shortfall: leftover,
    note: msg(lang,
      `Height budget ${round(available)}"; tallest wall cabinet here is ${single.height}"` +
        ` and no combination fills the gap — the top ${leftover}" needs taller crown molding.` +
        ` Floor-to-ceiling needs a catalog that supports that stack.`,
      `可用高度 ${round(available)}"，这家最高的吊柜是 ${single.height}"，` +
        `而现有档位拼不出贴合的组合——顶上 ${leftover}" ` +
        `用加高顶线收口。想做到顶的话，需要选支持这个高度组合的商家。`),
  };
}

/**
 * 一面墙统一的接缝高度。
 *
 * **先定缝、再逐柜求解**（§3.2 最后一条）。做法：拿这面墙上出现次数最多的
 * 那套缝高——多数柜子已经这么解了，让少数派跟过来改动最小。
 */
export function seamsForRun(solutions: readonly StackSolution[]): number[] {
  const tally = new Map<string, { seams: number[]; n: number }>();
  for (const s of solutions) {
    if (s.seams.length === 0) continue;
    const key = s.seams.join("|");
    const cur = tally.get(key);
    if (cur) cur.n++;
    else tally.set(key, { seams: s.seams, n: 1 });
  }
  let winner: { seams: number[]; n: number } | undefined;
  for (const v of tally.values()) {
    if (!winner || v.n > winner.n) winner = v;
  }
  return winner?.seams ?? [];
}

/** 各段之间的接缝离吊柜底边的高度。 */
function seamsOf(heights: readonly number[]): number[] {
  const out: number[] = [];
  let y = 0;
  for (let i = 0; i < heights.length - 1; i++) {
    y = round(y + heights[i]! + STACK_SEAM_LOSS);
    out.push(y);
  }
  return out;
}

/**
 * 方案代价。数值本身不重要，**排序才重要**。
 *
 * 权重的取舍：**顶上留空比多一条缝更值得避免**。叠装存在的理由就是做到顶，
 * 如果"段数越少越好"压过"填满"，48" 的可用高度永远解成「42" 单柜 + 6" 空当」，
 * 叠装求解器等于没启用。所以留空的权重大于段数。
 *
 * 但也不能一味填满：1/4" 的缝不值得为它多加一段。当前配比下，
 * 大约 1" 以上的留空才划得来多一条缝。
 */
function costOf(stack: readonly StackCandidate[], shortfallUnits: number): number {
  const segments = stack.length;
  const topHeavy = stack.length >= 2 && stack[0]!.height < stack[1]!.height ? 1 : 0;
  return shortfallUnits * 150 + segments * 500 + topHeavy * 200;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
