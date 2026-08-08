/**
 * 美观评分 —— 排布的**软约束**。
 *
 * 与人体工程的硬约束不同，这些不会否决方案，但会在同等造价下决定选哪一版。
 * 「填得尽量满、柜子尽量少」这两条本身会主动制造难看的排布：
 *
 *   36, 9, 30, 12, 33   ← 填满了，柜子也不多，但宽度跳来跳去
 *   36, 33, 30, 30      ← 造价接近，观感好得多
 *
 * 所以宽度节奏必须进目标函数，不能只当锦上添花。
 *
 * ## 语言
 *
 * `notes` 默认英文；只有调用方传入 `language: "zh"` 时才出中文。
 */
import type { Placement } from "./generate.js";
import type { WallRun } from "../floorplan/types.js";
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";

/**
 * 各项权重。数值本身没有绝对意义，重要的是**相对大小**：
 * 节奏 > 窄柜惩罚 > 对齐 > 对称，因为前两者影响的是每一眼都看得见的东西。
 */
export const AESTHETIC_WEIGHTS = {
  widthRhythm: 3.0,
  narrowPenalty: 2.0,
  seamAlignment: 1.5,
  symmetry: 1.0,
  fillerPlacement: 2.5,
} as const;

/** 低于此宽度的柜子除非有功能理由（拉篮/垃圾柜），否则视为「凑数的窄柜」。 */
export const NARROW_THRESHOLD = 15;

/** 这些型号即使窄也有明确功能，不算凑数。 */
const FUNCTIONAL_NARROW = /^(BPO|TDC|BWB|WF|BF|TF)/i;

export interface AestheticScore {
  /** 总分，越高越好。范围大致 0–100。 */
  total: number;
  breakdown: {
    widthRhythm: number;
    narrowPenalty: number;
    seamAlignment: number;
    symmetry: number;
    fillerPlacement: number;
  };
  notes: string[];
}

export interface ScoreInput {
  run: WallRun;
  placements: readonly Placement[];
  /** 客户语言偏好。默认英文。 */
  language?: UiLanguage;
}

export function scoreAesthetics(input: ScoreInput): AestheticScore {
  const { run } = input;
  const lang = input.language ?? DEFAULT_LANGUAGE;
  const mine = input.placements.filter((p) => p.wallRunId === run.id);
  const base = mine.filter((p) => p.layer === "base").sort((a, b) => a.x - b.x);
  const wall = mine.filter((p) => p.layer === "wall").sort((a, b) => a.x - b.x);
  const notes: string[] = [];

  const widthRhythm = scoreWidthRhythm(lang, base, notes);
  const narrowPenalty = scoreNarrowCabinets(lang, base, notes);
  const seamAlignment = scoreSeamAlignment(lang, base, wall, notes);
  const symmetry = scoreSymmetry(lang, run, base, notes);
  const fillerPlacement = scoreFillerPlacement(lang, run, mine, notes);

  const w = AESTHETIC_WEIGHTS;
  const weighted =
    widthRhythm * w.widthRhythm +
    narrowPenalty * w.narrowPenalty +
    seamAlignment * w.seamAlignment +
    symmetry * w.symmetry +
    fillerPlacement * w.fillerPlacement;
  const maxWeight = Object.values(w).reduce((a, b) => a + b, 0);

  return {
    total: Math.round((weighted / maxWeight) * 100),
    breakdown: { widthRhythm, narrowPenalty, seamAlignment, symmetry, fillerPlacement },
    notes,
  };
}

/**
 * 宽度节奏：相邻柜体宽度差越小越好。
 *
 * 用「相邻差的平均值 / 最大可能差」归一化后取反。全部同宽 → 1.0。
 */
function scoreWidthRhythm(lang: UiLanguage, base: readonly Placement[], notes: string[]): number {
  const cabinets = base.filter((p) => p.kind === "cabinet");
  if (cabinets.length < 2) return 1;

  const widths = cabinets.map((p) => p.width);
  const spread = Math.max(...widths) - Math.min(...widths);
  if (spread === 0) return 1;

  let totalDelta = 0;
  for (let i = 1; i < widths.length; i++) {
    totalDelta += Math.abs(widths[i]! - widths[i - 1]!);
  }
  const avgDelta = totalDelta / (widths.length - 1);
  const score = Math.max(0, 1 - avgDelta / spread);

  if (score < 0.5) {
    notes.push(msg(lang,
      `Cabinet widths jump a lot (${widths.join("/")}); average adjacent delta ${avgDelta.toFixed(1)}"`,
      `柜体宽度跳动较大（${widths.join("/")}），相邻宽度平均差 ${avgDelta.toFixed(1)}"`));
  }
  return score;
}

/**
 * 窄柜惩罚。
 *
 * 「填得尽量满」会主动塞 9"/12" 窄柜收尾——这恰恰是最难看的做法，
 * 而且窄柜单位造价高、储物效率低。有功能理由的窄柜（拉篮/垃圾柜/填缝）不罚。
 */
function scoreNarrowCabinets(lang: UiLanguage, base: readonly Placement[], notes: string[]): number {
  const cabinets = base.filter((p) => p.kind === "cabinet");
  if (cabinets.length === 0) return 1;

  const gratuitous = cabinets.filter(
    (p) => p.width < NARROW_THRESHOLD && !FUNCTIONAL_NARROW.test(p.moduleCode ?? ""),
  );
  if (gratuitous.length > 0) {
    const list = gratuitous.map((p) => `${p.moduleCode} ${p.width}"`).join(lang === "zh" ? "、" : ", ");
    notes.push(msg(lang,
      `${gratuitous.length} narrow cabinet(s) (${list}) used only to fill space` +
        ` — prefer wider boxes + fillers`,
      `有 ${gratuitous.length} 个窄柜（${list}）` +
        `纯粹用于填满，建议改用更宽的柜体 + 填缝条`));
  }
  return Math.max(0, 1 - gratuitous.length / cabinets.length);
}

/**
 * 上下门缝对齐：吊柜的分隔线尽量落在地柜分隔线上。
 *
 * 完全对齐观感最整齐；差 1" 以内视觉上看不出来，按容差处理。
 */
const SEAM_TOLERANCE = 1;

function scoreSeamAlignment(
  lang: UiLanguage,
  base: readonly Placement[],
  wall: readonly Placement[],
  notes: string[],
): number {
  if (wall.length === 0 || base.length === 0) return 1;

  const baseSeams = seamsOf(base);
  const wallSeams = seamsOf(wall);
  if (wallSeams.length === 0) return 1;

  const aligned = wallSeams.filter((ws) =>
    baseSeams.some((bs) => Math.abs(bs - ws) <= SEAM_TOLERANCE)).length;
  const score = aligned / wallSeams.length;

  if (score < 0.5) {
    notes.push(msg(lang,
      `Most wall/base seams don't align (${aligned}/${wallSeams.length}) — elevation looks staggered`,
      `吊柜与地柜的分隔线大多没对齐（${aligned}/${wallSeams.length}），正视图上会显得错落`));
  }
  return score;
}

function seamsOf(placements: readonly Placement[]): number[] {
  return placements.slice(0, -1).map((p) => p.x + p.width);
}

/**
 * 对称性：水槽/窗户是否居中，两侧柜体分布是否均衡。
 *
 * 只在存在明确的对称参照物（水槽或窗）时评分；没有参照物时不扣分——
 * 一字型厨房强行要求对称是没意义的。
 */
function scoreSymmetry(
  lang: UiLanguage,
  run: WallRun,
  base: readonly Placement[],
  notes: string[],
): number {
  const window = run.features.find((f) => f.kind === "window");
  // 排掉配套给家电的：灶下柜可能就是一个水槽柜箱体，拿它当对称参照物是错的
  const sink = base.find((p) => p.label === "sink")
    ?? base.find((p) => p.applianceKind === undefined && p.moduleCode?.toUpperCase().includes("SB"));
  const anchor = window
    ? window.offset + window.width / 2
    : sink
      ? sink.x + sink.width / 2
      : undefined;
  if (anchor === undefined) return 1;

  // 水槽中心是否对准窗中心
  if (window && sink) {
    const sinkCenter = sink.x + sink.width / 2;
    const windowCenter = window.offset + window.width / 2;
    const offBy = Math.abs(sinkCenter - windowCenter);
    if (offBy > 3) {
      notes.push(msg(lang,
        `Sink center is ${offBy.toFixed(1)}" off the window center — consider aligning`,
        `水槽中心偏离窗中心 ${offBy.toFixed(1)}"，建议对齐`));
      return Math.max(0, 1 - offBy / (run.length / 4));
    }
    return 1;
  }

  // 只有参照物时，看两侧柜体总宽是否接近
  const left = base.filter((p) => p.x + p.width <= anchor).reduce((s, p) => s + p.width, 0);
  const right = base.filter((p) => p.x >= anchor).reduce((s, p) => s + p.width, 0);
  if (left + right === 0) return 1;
  return 1 - Math.abs(left - right) / (left + right);
}

/**
 * 填缝条位置：应该靠墙（不显眼），不该出现在柜体中间。
 *
 * 中间的填缝条是最扎眼的瑕疵之一——一条 3" 的窄板夹在两个柜子之间，
 * 门缝节奏立刻被打断。
 */
function scoreFillerPlacement(
  lang: UiLanguage,
  run: WallRun,
  placements: readonly Placement[],
  notes: string[],
): number {
  const fillers = placements.filter((p) => p.kind === "filler" && p.layer === "base");
  if (fillers.length === 0) return 1;

  const atEdge = fillers.filter(
    (p) => p.x < 0.26 || Math.abs(p.x + p.width - run.length) < 0.26,
  ).length;
  const score = atEdge / fillers.length;
  if (score < 1) {
    notes.push(msg(lang,
      `${fillers.length - atEdge} filler(s) not at a corner — breaks the reveal rhythm on elevation`,
      `有 ${fillers.length - atEdge} 条填缝条不在墙角，正视图上会打断门缝节奏`));
  }
  return score;
}

/**
 * 综合排序键 —— 供 `generateLayout` 在多个候选里选优。
 *
 * 分层顺序（与「省钱好装」并列而不是从属）：
 *   1. 硬约束：不可违反（由 ergonomics 单独把关，不在这里）
 *   2. 浪费：剩余长度小
 *   3. 美观：aesthetic 分高
 *   4. 造价代理：柜体数量少
 *
 * 把美观放在数量之前，是因为「柜子少」省的是安装工时（几十加币量级），
 * 而难看的排布是客户每天都要看的。
 */
export interface CandidateRanking {
  leftover: number;
  aesthetic: number;
  cabinetCount: number;
}

export function compareCandidates(a: CandidateRanking, b: CandidateRanking): number {
  // 剩余差在 1/4" 以内视为相同（都能被同一条填缝条吸收）
  if (Math.abs(a.leftover - b.leftover) > 0.26) return a.leftover - b.leftover;
  if (a.aesthetic !== b.aesthetic) return b.aesthetic - a.aesthetic;
  return a.cabinetCount - b.cabinetCount;
}
