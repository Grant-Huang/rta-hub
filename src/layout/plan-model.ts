/**
 * 厨房平面模型 —— **把各段墙拼成一张连通的平面，唯一的一份**。
 *
 * ## 为什么要有这个模块
 *
 * 客户的原话：「全局视图要把几个墙围起来、连起来，不能像四个单独的视图那样，
 * 把南墙、北墙、东墙分开写。只有把它们连起来的时候，才会发现开关门的问题、
 * 干涉的问题，以及一些边角柜等细节。」
 *
 * 这句话点的是一个真问题。改造前，"墙段怎么串起来"这件事在代码里有**两份复制**：
 *
 *   - `render/plan-view.ts` 的 `layoutPlan`：按 `startsAtCorner` 判断相接，串成链；
 *   - `layout/generate.ts` 的 `trianglePoints`：**无条件**每段右转 90°。
 *
 * 两份实现对同一个户型给出不同的平面——一份用来画图，另一份用来算工作三角。
 * 这与上一轮"两个渲染器各写一套配色"是同一类问题，只是后果更重：
 * **两段墙在墙角处的柜子会占同一块地方，而没有任何一处检查看得见**。
 * 单段墙内的重叠检查查不出来（它们不在同一段墙上），画图时也只是各画各的，
 * 于是图上两排柜子在墙角叠在一起，客户要到装修现场才发现。
 *
 * 所以这里把平面收成一份：世界坐标、墙角归属、围合区、岛台落位、构件足迹，
 * 全部从这里出。画图、工作三角、净空检查、交付前审核都读它。
 *
 * ## 坐标约定
 *
 * 世界坐标以英寸为单位，x 向右、y 向下（与 SVG 一致，省掉一次翻转）。
 * 每段墙有起点 `origin` 与走向 `heading`；**沿走向看，室内在右手侧**，
 * 柜子的进深就往那一侧伸。这条约定一旦定死，"门朝哪开"就不用再猜。
 *
 * 墙段的走向是**推出来的，不是存的**：`WallRun` 只有长度和「两端是不是内墙角」，
 * 户型抽取给不出可靠方位，硬要客户填也不现实。推不出来的（墙段之间不相接）
 * 如实标注为「示意排列」，不假装知道。
 */
import type { ParsedGeometry, WallFeature, WallRun } from "../floorplan/types.js";
import { isIsland } from "../floorplan/types.js";
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";

/** 走向：0=向右，90=向下，180=向左，270=向上。 */
export type Heading = 0 | 90 | 180 | 270;

const DIR: Record<Heading, { dx: number; dy: number }> = {
  0: { dx: 1, dy: 0 }, 90: { dx: 0, dy: 1 },
  180: { dx: -1, dy: 0 }, 270: { dx: 0, dy: -1 },
};

/** 顺时针转 90°——厨房绕着人转，L/U 型都是同一个方向绕。 */
function turnRight(h: Heading): Heading {
  return (((h + 90) % 360) as Heading);
}

/**
 * 台面的外伸量（英寸）。
 *
 * 台面不是柜体的投影——它四周都比箱体大出一圈。这一圈以前在代码里根本不存在，
 * 于是"柜子没超墙"就被当成"装得下"，而实际上门洞旁的台面会压在门套线上，
 * 门开到一半就顶住了。
 *
 * ⚠️ 与 NKBA 净空同样处理：这是**行业常见值**，上线前要按试点公司的实际台面
 * 工艺核对（见 PRE_LAUNCH_CHECKLIST）。数值集中在此处，改数值不用改逻辑。
 */
export const COUNTERTOP = {
  /** 前沿超出箱体的部分——标准 1-1/2"（含门板厚度后露出约 1"）。 */
  frontOverhang: 1.5,
  /** 外露端头超出箱体的部分。 */
  endOverhang: 1.5,
} as const;

/** 门洞相关的净空。 */
export const DOOR_CLEARANCE = {
  /** 门套线宽度——台面端头压上去，门套装不上。 */
  casing: 1,
  /**
   * 地柜层门洞每侧要让开的距离 = 台面端头外伸 + 门套线。
   *
   * 客户的说法是「至少要让出一点点距离」。这就是那"一点点"的来源：
   * 它不是一个凑出来的余量，而是台面确实伸出去了那么多。
   */
  get base(): number { return COUNTERTOP.endOverhang + this.casing; },
  /** 吊柜层没有台面，只让门套线。 */
  get wall(): number { return this.casing; },
} as const;

/** 内墙角相关的常数。 */
export const CORNER = {
  /**
   * 转角填缝条：让位那一侧的第一个柜子与相邻墙柜体之间留的那一条。
   *
   * 不留的话，让位侧的门/抽屉一拉出来就撞上相邻墙柜体的门与拉手——
   * 两个柜子各自"没超墙"，合起来开不了。行业常见做法是 3"。
   */
  filler: 3,
  /**
   * 转角方块的边长 —— **各层同一个值，按最深的那件东西取**。
   *
   * 按层各取各的进深（地柜 24、吊柜 12）看着更省，但吊柜层的 12 是错的：
   *   - 转角吊柜本身在平面上就是 24"×24"（斜切或盲角），不是 12"×12"；
   *   - 家电配套的上柜（冰箱上柜）是 24" 深，冰箱靠墙角时它就伸进转角方块。
   * 取 12 的话，让位侧的吊柜会排到相邻墙上柜的正后方——两边各自"没超墙"，
   * 合起来撞在一起，而这正是交付前审核会阻断、且没有恢复路径的那种情况。
   */
  square: 24,
} as const;

/** 各层的默认进深（英寸）。规格里给了就用规格的。 */
export const LAYER_DEPTH = { base: 24, wall: 12, tall: 24 } as const;

export type PlanLayerName = keyof typeof LAYER_DEPTH;

/** 岛台默认进深：单排柜 + 背板收口。 */
export const DEFAULT_ISLAND_DEPTH = 25;

/** NKBA 过道净空（英寸）。 */
export const AISLE = {
  /** 通行过道最小值——低于这个人过不去，方案不能出。 */
  walkway: 36,
  /** 工作过道建议值（单人操作）。低于它可以出图，但要告诉客户。 */
  work: 42,
} as const;

export interface PlacedRun {
  run: WallRun;
  island: boolean;
  /** 起点的世界坐标（英寸）。 */
  origin: { x: number; y: number };
  heading: Heading;
  /**
   * 各层在**起点一侧**要让开的距离。
   *
   * 来源有两处：内墙角让位（`corners`）与门洞（门洞在段内，由
   * `splitIntoSegments` 处理，不在这里）。这里只放墙角。
   */
  setbackStart: Record<PlanLayerName, number>;
  /** 终点一侧要让开的距离。短的那一段可能两头都要让（U 型的中间段就是）。 */
  setbackEnd: Record<PlanLayerName, number>;
}

export interface PlanCorner {
  /** 拥有转角方块的那一段：它的柜子一直排到墙角，转角柜也放在这一段。 */
  ownerRunId: string;
  /** 转角柜落在拥有段的哪一头。 */
  ownerEnd: "start" | "end";
  /** 让位的那一段：这一头的 `setback` 被相邻段的柜子占着。 */
  yieldingRunId: string;
  yieldingEnd: "start" | "end";
  /** 墙角的世界坐标。 */
  at: { x: number; y: number };
  /** 让位距离，按层分。 */
  setback: Record<PlanLayerName, number>;
}

/** 世界坐标下的一个轴对齐矩形。 */
export interface Rect {
  minX: number; minY: number; maxX: number; maxY: number;
}

export interface KitchenPlan {
  runs: PlacedRun[];
  corners: PlanCorner[];
  /** 图纸范围（已含柜体进深与开门弧线的余量）。 */
  bounds: Rect;
  /**
   * 围合区：各段墙的台面外沿之间那块能走动的地方。岛台落在这里。
   *
   * 只有两段以上相接才有围合区——一字型厨房没有"围合"可言。
   */
  interior?: Rect;
  /** 所有墙段是否首尾相接成一条链。 */
  connected: boolean;
  note?: string;
}

const zero = (): Record<PlanLayerName, number> => ({ base: 0, wall: 0, tall: 0 });

/**
 * 把几何拼成一张连通的平面。
 *
 * 相接的判据是「上一段 `endsAtCorner` 且这一段 `startsAtCorner`」。相接就右转
 * 90° 接着走，不相接就另起一行画开，并在 `note` 里说明这是示意排列。
 *
 * **墙角归属**：两段墙里**长的那一段拥有墙角**——它的柜子一直排到墙角（转角柜
 * 也放在它上面），短的那一段让开「转角方块 + 转角填缝条」= 27"，各层同一个值。
 *
 * 为什么按长度而不是按顺序：U 型厨房的中间那段通常最短，而水槽多半就在它上面。
 * 按"链上靠前的拥有"来分的话，中间段会**又让一次位、又摆一个转角柜**，
 * 一面 108" 的墙只剩 45" 能用，水槽两侧的操作台面直接归零。按长度分，
 * 中间段两头各让 27"，剩 54"——同样紧，但紧得有道理，而且两个转角柜落在
 * 两面长墙上，那里本来就是储物区。
 */
export function buildKitchenPlan(
  geometry: ParsedGeometry,
  language: UiLanguage = DEFAULT_LANGUAGE,
): KitchenPlan {
  const walls = geometry.wallRuns.filter((r) => !isIsland(r));
  const islands = geometry.wallRuns.filter((r) => isIsland(r));

  const runs: PlacedRun[] = [];
  const corners: PlanCorner[] = [];
  let cursor = { x: 0, y: 0 };
  let heading: Heading = 0;
  let connected = true;

  walls.forEach((run, i) => {
    const prev = walls[i - 1];
    let joinsPrev = false;
    if (prev) {
      if (prev.endsAtCorner && run.startsAtCorner) {
        heading = turnRight(heading);
        joinsPrev = true;
      } else {
        // 拼不上：另起一行画，别假装知道它在哪
        connected = false;
        heading = 0;
        cursor = { x: 0, y: cursor.y + 60 };
      }
    }

    const placed: PlacedRun = {
      run, island: false, origin: { ...cursor }, heading,
      setbackStart: zero(), setbackEnd: zero(),
    };

    if (joinsPrev && prev) {
      // 让位 = 相邻段该层的进深 + 转角填缝条。地柜 24+3，吊柜 12+3。
      const setback = zero();
      for (const layer of ["base", "wall", "tall"] as const) {
        setback[layer] = CORNER.square + CORNER.filler;
      }
      const prevPlaced = runs[runs.length - 1]!;
      const prevWins = prev.length >= run.length;
      if (prevWins) {
        placed.setbackStart = setback;
      } else {
        prevPlaced.setbackEnd = setback;
      }
      corners.push({
        ownerRunId: prevWins ? prev.id : run.id,
        ownerEnd: prevWins ? "end" : "start",
        yieldingRunId: prevWins ? run.id : prev.id,
        yieldingEnd: prevWins ? "start" : "end",
        at: { ...cursor }, setback,
      });
    }

    runs.push(placed);
    const d = DIR[heading];
    cursor = { x: cursor.x + d.dx * run.length, y: cursor.y + d.dy * run.length };
  });

  const interior = connected && runs.length >= 2 ? interiorOf(runs) : undefined;
  const placedWalls = [...runs];
  islands.forEach((island, i) => {
    runs.push(placeIsland(island, placedWalls, interior, i, islands.length));
  });

  return {
    runs, corners, connected,
    ...(interior ? { interior: interior.rect } : {}),
    bounds: boundsOf(runs),
    ...(connected
      ? {}
      : {
          note: msg(language,
            "Some wall runs could not be joined to their neighbors; " +
              "the drawing is a schematic layout — confirm orientation on site.",
            "有墙段无法与相邻墙段相接，图中为示意排列，实际方位请以现场为准。"),
        }),
  };
}

/** 沿走向看的右手侧法向——室内方向。 */
export function interiorNormal(heading: Heading): { dx: number; dy: number } {
  const d = DIR[heading];
  return { dx: -d.dy, dy: d.dx };
}

export function headingVector(heading: Heading): { dx: number; dy: number } {
  return DIR[heading];
}

/**
 * 段内坐标 → 世界坐标。
 *
 * `along` 是沿走向从起点算的距离，`offset` 是往室内方向的偏移（柜体进深方向）。
 */
export function toPlane(
  rp: PlacedRun, along: number, offset = 0,
): { x: number; y: number } {
  const d = DIR[rp.heading];
  const n = interiorNormal(rp.heading);
  return {
    x: rp.origin.x + d.dx * along + n.dx * offset,
    y: rp.origin.y + d.dy * along + n.dy * offset,
  };
}

/**
 * 这一段这一层能放柜子的区间（段内坐标）。
 *
 * 墙角让位在这里生效——排布器拿到的就已经是让过位的区间，
 * 不需要它自己再想一遍墙角的事。
 */
export function usableSpan(
  rp: PlacedRun, layer: PlanLayerName,
): { start: number; end: number } {
  const start = rp.setbackStart[layer];
  const end = rp.run.length - rp.setbackEnd[layer];
  return { start, end: Math.max(start, end) };
}

/** 某段某层的进深。岛台用它自己的进深。 */
export function depthOf(rp: PlacedRun, layer: PlanLayerName): number {
  if (rp.island) return rp.run.depth ?? DEFAULT_ISLAND_DEPTH;
  return LAYER_DEPTH[layer];
}

/**
 * 一个构件在世界坐标里占的矩形。
 *
 * 干涉检查靠它——单段墙内的重叠检查查不出墙角，因为那两个柜子**不在同一段墙上**。
 */
export function footprint(
  rp: PlacedRun, along: number, width: number, depth: number,
): Rect {
  const a = toPlane(rp, along, 0);
  const b = toPlane(rp, along + width, depth);
  return {
    minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
  };
}

/** 两个矩形是否真的叠在一起。`tolerance` 之内的接触不算叠。 */
export function overlaps(a: Rect, b: Rect, tolerance = 0.25): boolean {
  return (
    a.minX < b.maxX - tolerance && b.minX < a.maxX - tolerance &&
    a.minY < b.maxY - tolerance && b.minY < a.maxY - tolerance
  );
}

/** 两个矩形之间的最小间距（相交时为 0）。 */
export function gapBetween(a: Rect, b: Rect): number {
  const dx = Math.max(b.minX - a.maxX, a.minX - b.maxX, 0);
  const dy = Math.max(b.minY - a.maxY, a.minY - b.maxY, 0);
  if (dx > 0 && dy > 0) return Math.hypot(dx, dy);
  return dx + dy;
}

/** 围合区，外加"哪几条边是被墙顶住的"。 */
interface Interior {
  rect: Rect;
  /**
   * 这条边是被某段墙的台面外沿顶住的，还是只是包围盒的边界。
   *
   * L 型厨房只有两条边有墙，另外两条是敞开的——分不清这一点，岛台就会被
   * 摆到"包围盒中央"，也就是紧贴着那两面墙。
   */
  bounded: { minX: boolean; maxX: boolean; minY: boolean; maxY: boolean };
}

/**
 * 围合区 —— 各段墙台面外沿围出来的那块空地。
 *
 * 算法：先取所有墙线的包围盒，再按每段墙**朝室内那一侧**的占用把盒子往里收。
 * 收完剩下的就是能走动、能放岛台的地方。
 */
function interiorOf(runs: readonly PlacedRun[]): Interior | undefined {
  const walls = runs.filter((r) => !r.island);
  if (walls.length === 0) return undefined;

  const xs: number[] = [];
  const ys: number[] = [];
  for (const rp of walls) {
    const end = toPlane(rp, rp.run.length);
    xs.push(rp.origin.x, end.x);
    ys.push(rp.origin.y, end.y);
  }
  const rect: Rect = {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
  const bounded = { minX: false, maxX: false, minY: false, maxY: false };

  // 每段墙按它的法向把对应的那条边往里收。收进量 = 地柜进深 + 台面前沿外伸。
  const inset = LAYER_DEPTH.base + COUNTERTOP.frontOverhang;
  for (const rp of walls) {
    const n = interiorNormal(rp.heading);
    if (n.dx > 0) { rect.minX = Math.max(rect.minX, rp.origin.x + inset); bounded.minX = true; }
    if (n.dx < 0) { rect.maxX = Math.min(rect.maxX, rp.origin.x - inset); bounded.maxX = true; }
    if (n.dy > 0) { rect.minY = Math.max(rect.minY, rp.origin.y + inset); bounded.minY = true; }
    if (n.dy < 0) { rect.maxY = Math.min(rect.maxY, rp.origin.y - inset); bounded.maxY = true; }
  }
  if (rect.maxX - rect.minX <= 0 || rect.maxY - rect.minY <= 0) return undefined;
  return { rect, bounded };
}

/**
 * 岛台落位。
 *
 * 从围合区出发，把**有墙的那几条边**再往里收一条建议工作过道（42"），
 * 岛台摆在收完之后那块地方的中央。敞开的边不收——L 型厨房只有两面墙，
 * 另外两面是餐厅，往那边收等于凭空假设了一堵不存在的墙。
 *
 * 这里**只负责摆**，摆得下摆不下由净空检查说了算（`ergonomics.ts` 的
 * `AISLE_TOO_NARROW`）——把"放不下"写成"不放"的话，客户会以为系统同意了
 * 他的岛台，直到现场才发现过道只有 29 寸。
 */
function placeIsland(
  island: WallRun,
  walls: readonly PlacedRun[],
  interior: Interior | undefined,
  index = 0,
  total = 1,
): PlacedRun {
  const depth = island.depth ?? DEFAULT_ISLAND_DEPTH;

  if (interior) {
    const { rect, bounded } = interior;
    const free: Rect = {
      minX: rect.minX + (bounded.minX ? AISLE.work : 0),
      maxX: rect.maxX - (bounded.maxX ? AISLE.work : 0),
      minY: rect.minY + (bounded.minY ? AISLE.work : 0),
      maxY: rect.maxY - (bounded.maxY ? AISLE.work : 0),
    };
    const w = free.maxX - free.minX;
    const h = free.maxY - free.minY;
    const horizontal = w >= h;
    // 多个岛台沿短边分格摆开。全都摆在正中央的话，它们会**重叠在同一个点上**，
    // 然后报一串 0" 过道——那是摆法的锅，不是客户的厨房放不下
    const cx = (free.minX + free.maxX) / 2;
    const cy = (free.minY + free.maxY) / 2;
    const laneSpan = horizontal ? h : w;
    const lane = total > 1
      ? (laneSpan / total) * (index + 0.5) - laneSpan / 2
      : 0;
    return {
      run: island, island: true,
      // heading 0 时进深往 +y 伸，所以起点在长度与进深的"左上角"
      origin: horizontal
        ? { x: cx - island.length / 2, y: cy + lane - depth / 2 }
        : { x: cx + lane + depth / 2, y: cy - island.length / 2 },
      heading: horizontal ? 0 : 90,
      setbackStart: zero(), setbackEnd: zero(),
    };
  }

  const host = walls[0];
  if (!host) {
    return {
      run: island, island: true, origin: { x: 0, y: 0 }, heading: 0,
      setbackStart: zero(), setbackEnd: zero(),
    };
  }
  // 摆在这段墙对面：让开地柜进深 + 台面外伸 + 建议工作过道
  const clear = LAYER_DEPTH.base + COUNTERTOP.frontOverhang + AISLE.work;
  const anchor = toPlane(host, (host.run.length - island.length) / 2, clear);
  return {
    run: island, island: true, origin: anchor, heading: host.heading,
    setbackStart: zero(), setbackEnd: zero(),
  };
}

/**
 * 图纸范围。
 *
 * 柜体进深与**开门弧线**都要算进来：只按进深留的话，向室内伸出去的弧线会被
 * 画布裁掉半圈，而弧线正是客户判断"门开了会不会打到别的东西"的依据。
 * 24" 深的地柜 + 0.85 倍门宽的弧线 ≈ 45"，取 48" 留一点余量。
 */
function boundsOf(runs: readonly PlacedRun[]): Rect {
  const MARGIN = 48;
  const xs: number[] = [0];
  const ys: number[] = [0];
  for (const rp of runs) {
    const depth = rp.island ? (rp.run.depth ?? DEFAULT_ISLAND_DEPTH) : LAYER_DEPTH.base;
    for (const along of [0, rp.run.length]) {
      for (const off of [0, depth]) {
        const p = toPlane(rp, along, off);
        xs.push(p.x); ys.push(p.y);
      }
    }
  }
  return {
    minX: Math.min(...xs) - MARGIN, minY: Math.min(...ys) - MARGIN,
    maxX: Math.max(...xs) + MARGIN, maxY: Math.max(...ys) + MARGIN,
  };
}

/**
 * 门洞在某一层要让开多少 —— 台面外伸计入净空的那一条。
 *
 * 门洞本身的宽度是门的宽度；柜子不能贴着门洞边站，因为台面会伸出去压到门套上。
 */
export function doorClearanceFor(layer: PlanLayerName): number {
  return layer === "wall" ? DOOR_CLEARANCE.wall : DOOR_CLEARANCE.base;
}

/**
 * 这个构件**上面有没有连续的台面** —— 判断只有这一处。
 *
 * 洗碗机装在台面底下，台面从它上面连过去；嵌入式灶台是台面上的一个洞，
 * 台面到它就断了；冰箱、独立式灶具、烤箱高柜是通高的，同样断开。
 *
 * 分不清这一点会同时错两个地方：图上画出一条从冰箱顶上横穿过去的台面，
 * 以及 NKBA 落台区把「洗碗机上方那段台面」算成 0——后者会让一个完全合理的
 * 「水槽 + 紧邻洗碗机」排布被自己的检查器判为不合格，而 NKBA 要求的正是
 * 洗碗机紧邻水槽。两处各判一次的话，迟早一处对一处错。
 */
export function hasContinuousCounter(p: {
  kind: string; layer: string; height: number; applianceKind?: string;
}): boolean {
  if (p.kind === "appliance") return p.applianceKind === "dishwasher";
  return p.layer === "base" && p.height <= 36;
}

/** 门洞（含台面让位）在墙上占的区间。 */
export function doorSpan(
  f: WallFeature, layer: PlanLayerName,
): { x: number; width: number } {
  const pad = doorClearanceFor(layer);
  const x = Math.max(0, f.offset - pad);
  return { x, width: Math.max(f.width, 1) + (f.offset - x) + pad };
}
