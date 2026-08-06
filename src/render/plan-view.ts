/**
 * 全局俯视图 —— 整个厨房拼在一张图上，分地柜层与吊柜层。
 *
 * ## 与已有俯视图的区别
 *
 * `views.ts` 的 `renderTopView` 是**单段墙**的俯视图：一条直线上排一排柜子。
 * 那张图回答不了「L 型的两条边是怎么接的」「U 型中间还剩多宽」这类问题，
 * 而客户在第一眼要判断的恰恰是整体排布。
 *
 * 所以这里把各段墙按走向拼成一个平面。这是**客户第一个看到的图**
 * （`DesignStage.planReview`），也是多轮修改都在上面进行的那一张。
 *
 * ## 墙段的走向是推出来的，不是存的
 *
 * `WallRun` 只有长度和「两端是不是内墙角」，没有绝对方位——户型抽取给不出
 * 可靠的方位，硬要客户填也不现实。所以这里按**厨房的常见拓扑**推：
 * 墙段首尾相接成链，遇到内墙角转 90°。一字型是一条线，L 型转一次，U 型转两次。
 *
 * 推不出来的情况（墙段之间不相接）如实标注为「示意排列」，不假装知道。
 */
import type { ParsedGeometry, WallRun } from "../floorplan/types.js";
import type { Placement } from "../layout/generate.js";
import { formatInches } from "./views.js";

export interface RunPlacement {
  run: WallRun;
  /** 墙段起点在平面上的坐标（英寸）。 */
  origin: { x: number; y: number };
  /** 走向：0=向右，90=向下，180=向左，270=向上。 */
  heading: 0 | 90 | 180 | 270;
}

export interface PlanGeometry {
  runs: RunPlacement[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** 走向是推出来的还是没推出来。 */
  inferred: boolean;
  note?: string;
}

const DIR: Record<0 | 90 | 180 | 270, { dx: number; dy: number }> = {
  0: { dx: 1, dy: 0 }, 90: { dx: 0, dy: 1 },
  180: { dx: -1, dy: 0 }, 270: { dx: 0, dy: -1 },
};

/** 顺时针转 90°——厨房绕着人转，L/U 型都是同一个方向绕。 */
function turnRight(h: 0 | 90 | 180 | 270): 0 | 90 | 180 | 270 {
  return (((h + 90) % 360) as 0 | 90 | 180 | 270);
}

/**
 * 把各段墙拼成平面。
 *
 * 相接的判据是「上一段 `endsAtCorner` 且这一段 `startsAtCorner`」。
 * 不相接就并排画开，并在 `note` 里说明这是示意排列而不是实测方位。
 */
export function layoutPlan(geometry: ParsedGeometry): PlanGeometry {
  const runs: RunPlacement[] = [];
  let cursor = { x: 0, y: 0 };
  let heading: 0 | 90 | 180 | 270 = 0;
  let allConnected = true;

  geometry.wallRuns.forEach((run, i) => {
    const prev = geometry.wallRuns[i - 1];
    if (prev) {
      const connected = prev.endsAtCorner && run.startsAtCorner;
      if (connected) {
        heading = turnRight(heading);
      } else {
        // 拼不上：另起一行画，别假装知道它在哪
        allConnected = false;
        heading = 0;
        cursor = { x: 0, y: cursor.y + 60 };
      }
    }
    runs.push({ run, origin: { ...cursor }, heading });
    const d = DIR[heading];
    cursor = { x: cursor.x + d.dx * run.length, y: cursor.y + d.dy * run.length };
  });

  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of runs) {
    const d = DIR[r.heading];
    xs.push(r.origin.x, r.origin.x + d.dx * r.run.length);
    ys.push(r.origin.y, r.origin.y + d.dy * r.run.length);
  }
  // 柜体进深也要算进边界，否则贴边的柜子会被裁掉
  const DEPTH = 26;
  return {
    runs,
    bounds: {
      minX: Math.min(...xs, 0) - DEPTH, minY: Math.min(...ys, 0) - DEPTH,
      maxX: Math.max(...xs, 0) + DEPTH, maxY: Math.max(...ys, 0) + DEPTH,
    },
    inferred: true,
    ...(allConnected
      ? {}
      : { note: "有墙段无法与相邻墙段相接，图中为示意排列，实际方位请以现场为准。" }),
  };
}

export type PlanLayer = "base" | "wall";

export interface PlanViewStyle {
  pxPerInch: number;
  showDimensions: boolean;
  showLabels: boolean;
}

export const DEFAULT_PLAN_STYLE: PlanViewStyle = {
  pxPerInch: 2.2, showDimensions: true, showLabels: true,
};

const PAD = 52;

/**
 * 画一层的全局俯视图。
 *
 * 柜体沿墙段方向排开，进深往墙的**右手侧**伸（沿走向看的右边就是室内）。
 */
export function renderPlanView(
  geometry: ParsedGeometry,
  placements: readonly Placement[],
  layer: PlanLayer,
  style: PlanViewStyle = DEFAULT_PLAN_STYLE,
): string {
  const plan = layoutPlan(geometry);
  const s = style.pxPerInch;
  const w = (plan.bounds.maxX - plan.bounds.minX) * s + PAD * 2;
  const h = (plan.bounds.maxY - plan.bounds.minY) * s + PAD * 2;
  const px = (x: number) => PAD + (x - plan.bounds.minX) * s;
  const py = (y: number) => PAD + (y - plan.bounds.minY) * s;

  const parts: string[] = [];

  for (const rp of plan.runs) {
    const d = DIR[rp.heading];
    // 右手侧法向：走向向右时室内在下方
    const n = { dx: -d.dy, dy: d.dx };

    // 墙线
    parts.push(
      `<line x1="${px(rp.origin.x)}" y1="${py(rp.origin.y)}" ` +
      `x2="${px(rp.origin.x + d.dx * rp.run.length)}" y2="${py(rp.origin.y + d.dy * rp.run.length)}" ` +
      `stroke="#333" stroke-width="3" />`);

    // 墙上的特征（窗/上下水），画在墙线上
    for (const f of rp.run.features) {
      const a = { x: rp.origin.x + d.dx * f.offset, y: rp.origin.y + d.dy * f.offset };
      const b = { x: a.x + d.dx * Math.max(f.width, 2), y: a.y + d.dy * Math.max(f.width, 2) };
      const color = f.kind === "window" ? "#4d9ad7" : f.kind === "plumbing" ? "#5fb08a" : "#c08a4d";
      parts.push(
        `<line x1="${px(a.x)}" y1="${py(a.y)}" x2="${px(b.x)}" y2="${py(b.y)}" ` +
        `stroke="${color}" stroke-width="6" stroke-linecap="butt" />`);
    }

    // 该段墙这一层的摆放
    const mine = placements
      .filter((p) => p.wallRunId === rp.run.id && p.layer === layer)
      .sort((a, b) => a.x - b.x);

    for (const p of mine) {
      const depth = p.depth || (layer === "wall" ? 12 : 24);
      const c0 = { x: rp.origin.x + d.dx * p.x, y: rp.origin.y + d.dy * p.x };
      const c1 = { x: c0.x + d.dx * p.width, y: c0.y + d.dy * p.width };
      const c2 = { x: c1.x + n.dx * depth, y: c1.y + n.dy * depth };
      const c3 = { x: c0.x + n.dx * depth, y: c0.y + n.dy * depth };
      const poly = [c0, c1, c2, c3].map((c) => `${px(c.x)},${py(c.y)}`).join(" ");

      const fill = p.kind === "appliance" ? "#e8e8e8"
        : p.kind === "filler" ? "#d8cfa8"
        : p.label === "sink" ? "#dff0e8" : "#fff";
      parts.push(`<polygon points="${poly}" fill="${fill}" stroke="#555" stroke-width="1" />`);

      // 型号码——太窄就不写，写了也看不清
      if (style.showLabels && p.width >= 12 && p.moduleCode) {
        const mid = {
          x: (c0.x + c2.x) / 2, y: (c0.y + c2.y) / 2,
        };
        parts.push(
          `<text x="${px(mid.x)}" y="${py(mid.y)}" font-size="9" fill="#444" ` +
          `text-anchor="middle" dominant-baseline="middle">${esc(p.moduleCode)}</text>`);
      }
    }

    // 墙段标注：名字 + 长度
    if (style.showDimensions) {
      const mid = {
        x: rp.origin.x + d.dx * rp.run.length / 2 - n.dx * 14,
        y: rp.origin.y + d.dy * rp.run.length / 2 - n.dy * 14,
      };
      parts.push(
        `<text x="${px(mid.x)}" y="${py(mid.y)}" font-size="11" fill="#222" ` +
        `text-anchor="middle" dominant-baseline="middle">` +
        `${esc(rp.run.label)} ${esc(formatInches(rp.run.length))}</text>`);
    }
  }

  const title = layer === "base" ? "全局俯视图 · 地柜层" : "全局俯视图 · 吊柜层";
  parts.push(
    `<text x="${PAD}" y="24" font-size="13" fill="#222" font-weight="600">${title}</text>`);
  if (plan.note) {
    parts.push(
      `<text x="${PAD}" y="${h - 14}" font-size="10" fill="#a06a2a">${esc(plan.note)}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(w)} ${round(h)}" ` +
    `width="${round(w)}" height="${round(h)}" role="img" aria-label="${title}">` +
    `<rect width="100%" height="100%" fill="#fff" />${parts.join("")}</svg>`;
}

export interface PlanViews {
  base: string;
  wall: string;
  note?: string;
}

/** 全局俯视图两张：地柜层 + 吊柜层。 */
export function renderPlanViews(
  geometry: ParsedGeometry,
  placements: readonly Placement[],
  style: PlanViewStyle = DEFAULT_PLAN_STYLE,
): PlanViews {
  const plan = layoutPlan(geometry);
  return {
    base: renderPlanView(geometry, placements, "base", style),
    wall: renderPlanView(geometry, placements, "wall", style),
    ...(plan.note ? { note: plan.note } : {}),
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 文本节点只需要转义 `& < >`（与 views.ts 同一条规则）。 */
function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}
