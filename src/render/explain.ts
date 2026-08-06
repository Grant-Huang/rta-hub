/**
 * 图纸解释 —— 客户拿到四视图时，配一段说清「这是什么图」和「为什么这么排」。
 *
 * ## 为什么需要这个
 *
 * 四视图对客户是**陌生的表达形式**。他看到一张正视图，不知道那些竖线是门缝还是
 * 柜体分界，不知道俯视图为什么要分地柜层和吊柜层，更不知道「为什么水槽在这儿、
 * 为什么这里放了个 9 寸的窄柜」。没有解释的图纸，客户只能凭直觉说「感觉怪怪的」，
 * 说不出哪里怪——修改意见就无从提起。
 *
 * ## 一条硬规则：解释必须来自**实际算出来的结果**
 *
 * 这里不写套话。「水槽对准了窗中心」只有在真的对准时才说，偏了多少也照实说——
 * 数据来自 `aesthetics` 的评分明细与 `ergonomics` 的检查结果，不是模板文案。
 *
 * 这与 FR-8 是同一条原则：**能算的就不要说**。一句"我们把水槽放在了采光最好的
 * 位置"如果不是从几何算出来的，它就是编的，而客户会据此做决定。
 */
import type { WallRun } from "../floorplan/types.js";
import type { AestheticScore } from "../layout/aesthetics.js";
import type { ErgonomicViolation } from "../layout/ergonomics.js";
import { CLEARANCE } from "../layout/ergonomics.js";
import type { ErgonomicCode } from "../layout/ergonomics.js";
import { HEIGHTS, type LayoutWarning, type Placement } from "../layout/generate.js";
import { formatInches } from "./views.js";

// ── 每张图在看什么 ────────────────────────────────────────────────────────

export type ViewKey = "front" | "topBase" | "topWall" | "side";

export interface ViewExplanation {
  view: ViewKey;
  title: string;
  /** 这张图在看什么。 */
  whatItShows: string;
  /** 图上的元素怎么读。 */
  howToRead: string[];
}

export interface ViewExplainOptions {
  construction: "framed" | "frameless";
  overlay: "full" | "partial" | "inset";
  /** 该段墙是否有吊柜——没有就不必解释吊柜层。 */
  hasWallCabinets: boolean;
  /** 是否出现了填缝条。 */
  hasFillers: boolean;
  /** 是否有家电预留位。 */
  hasAppliances: boolean;
}

const CONSTRUCTION_NOTE = {
  framed: "这家公司做的是**面框柜**：柜体正面有一圈实木框，门板盖在框上。" +
    "所以正视图上每个柜子的门比柜体略小一圈。",
  frameless: "这家公司做的是**无框柜**（欧式）：没有面框，门板直接盖住柜体侧板，" +
    "所以门缝更窄、内部可用宽度更大。",
} as const;

const OVERLAY_NOTE = {
  full: "全覆盖门板——门几乎盖满柜体正面，相邻两扇门之间只留一条窄缝。",
  partial: "半覆盖门板——门只盖住一部分，柜体边框会露出来，门缝看起来更宽。",
  inset: "嵌入式门板——门嵌在框里、与框齐平，是造价最高也最考究的做法。",
} as const;

export function explainViews(opts: ViewExplainOptions): ViewExplanation[] {
  const out: ViewExplanation[] = [];

  const frontRead = [
    "竖线是**柜体之间的分界**，每个柜子上更细的线是门缝。",
    CONSTRUCTION_NOTE[opts.construction],
    OVERLAY_NOTE[opts.overlay],
    `地柜台面高 ${formatInches(HEIGHTS.counterTop)}，最下面一条是踢脚线` +
      `（高 ${formatInches(HEIGHTS.toeKick)}，往里缩进，站着操作时脚有地方放）。`,
  ];
  if (opts.hasWallCabinets) {
    frontRead.push(`吊柜底边距地 ${formatInches(HEIGHTS.wallBaseline)}，` +
      `与台面之间留出 ${formatInches(HEIGHTS.backsplash)} 的操作与挡水板空间。`);
  }
  if (opts.hasFillers) {
    frontRead.push("窄条状、没有门缝的那几块是**填缝条**——墙不可能刚好等于柜体宽度之和，" +
      "差出来的部分用填缝条补，通常靠墙角放，不显眼。");
  }
  if (opts.hasAppliances) {
    frontRead.push("空出来的方框是**家电预留位**（冰箱、灶台、洗碗机），不是柜子。");
  }

  out.push({
    view: "front",
    title: "正视图",
    whatItShows: "站在厨房里正对这面墙看到的样子。这是最接近「装好之后长什么样」的一张。",
    howToRead: frontRead,
  });

  out.push({
    view: "topBase",
    title: "俯视图 · 地柜层",
    whatItShows: "从上往下看这面墙的地柜排布，看的是**平面位置与进深**。",
    howToRead: [
      "矩形是柜体，宽度按实际尺寸画，进深通常是 24 寸。",
      "柜体上的弧线是**开门方向示意**——弧线扫过的地方要留出开门空间。",
      "转角处有两种画法：斜切的是转角柜，L 形的是盲角柜（有一侧伸进转角深处，" +
        "要配拉篮才够得着）。",
    ],
  });

  if (opts.hasWallCabinets) {
    out.push({
      view: "topWall",
      title: "俯视图 · 吊柜层",
      whatItShows: "同一面墙，但看的是吊柜。**与地柜层分开画**，因为两层的分界线位置往往不同。",
      howToRead: [
        "吊柜进深通常是 12 寸，只有地柜的一半——所以人站在台面前操作时头不会撞到。",
        "把这张和地柜层对照着看，能看出上下柜的分界线是否对齐（对齐了正视图上更整齐）。",
      ],
    });
  }

  out.push({
    view: "side",
    title: "侧视图",
    whatItShows: "从侧面剖开看，交代的是**各个高度**：台面多高、吊柜多高、中间留多少。",
    howToRead: [
      "这张图不随墙长变化，同一套做法下所有墙段都一样。",
      "它主要用来确认层高够不够——吊柜顶到天花板之间要留出装顶线的空间。",
    ],
  });

  return out;
}

// ── 为什么这么排 ──────────────────────────────────────────────────────────

export type RationaleKind = "fact" | "good" | "tradeoff" | "warning";

export interface RationaleItem {
  kind: RationaleKind;
  text: string;
}

export interface RationaleSection {
  title: string;
  items: RationaleItem[];
}

export interface DesignRationale {
  headline: string;
  sections: RationaleSection[];
  /** 方案是否通过硬约束——未通过时不该出报价。 */
  acceptable: boolean;
}

export interface ExplainDesignInput {
  run: WallRun;
  placements: readonly Placement[];
  aesthetics?: AestheticScore;
  ergonomics: readonly ErgonomicViolation[];
  warnings?: readonly LayoutWarning[];
  acceptable: boolean;
  /** 客户选的储物偏好——解释里要呼应他的选择。 */
  storagePreference?: "drawers" | "doors" | "balanced";
}

export function explainDesign(input: ExplainDesignInput): DesignRationale {
  const mine = input.placements.filter((p) => p.wallRunId === input.run.id);
  const base = mine.filter((p) => p.layer === "base").sort((a, b) => a.x - b.x);
  const cabinets = base.filter((p) => p.kind === "cabinet");
  const fillers = base.filter((p) => p.kind === "filler");
  const appliances = base.filter((p) => p.kind === "appliance");
  const wall = mine.filter((p) => p.layer === "wall" && p.kind === "cabinet");

  const sections: RationaleSection[] = [
    composition(input.run, cabinets, wall, fillers, appliances),
  ];

  const why = whyThisArrangement(input, base, cabinets);
  if (why.items.length > 0) sections.push(why);

  sections.push(ergonomicSection(input.ergonomics));

  const attention = needsAttention(input.ergonomics, input.warnings ?? []);
  if (attention.items.length > 0) sections.push(attention);

  return {
    headline: headline(input.run, cabinets.length, input.acceptable),
    sections,
    acceptable: input.acceptable,
  };
}

function headline(run: WallRun, cabinetCount: number, acceptable: boolean): string {
  const base = `${run.label}（${formatInches(run.length)}）排了 ${cabinetCount} 个柜体`;
  return acceptable
    ? `${base}，人体工程检查全部通过。`
    : `${base}，但**未通过人体工程检查**——这一版还不能用来出报价，见下方待处理项。`;
}

function composition(
  run: WallRun,
  cabinets: readonly Placement[],
  wall: readonly Placement[],
  fillers: readonly Placement[],
  appliances: readonly Placement[],
): RationaleSection {
  const items: RationaleItem[] = [];

  const widths = cabinets.map((p) => formatInches(p.width)).join(" + ");
  if (cabinets.length > 0) {
    items.push({
      kind: "fact",
      text: `地柜从左到右依次是 ${cabinets.map((p) => p.moduleCode ?? "?").join("、")}，` +
        `宽度 ${widths}。`,
    });
  }
  if (wall.length > 0) {
    items.push({
      kind: "fact",
      text: `吊柜 ${wall.length} 个，高度 ${formatInches(wall[0]!.height)}` +
        `（按层高选的档位，顶上留出装顶线的空间）。`,
    });
  }
  if (appliances.length > 0) {
    const labels = appliances.map((p) => `${p.label ?? "家电"} ${formatInches(p.width)}`);
    items.push({ kind: "fact", text: `预留的家电位：${labels.join("、")}。` });
  }
  if (fillers.length > 0) {
    const total = fillers.reduce((s, p) => s + p.width, 0);
    const atEdge = fillers.every(
      (p) => p.x < 0.26 || Math.abs(p.x + p.width - run.length) < 0.26);
    items.push({
      kind: atEdge ? "good" : "tradeoff",
      text: `用了 ${fillers.length} 条填缝条共 ${formatInches(total)}` +
        (atEdge
          ? "，都放在墙角——墙长不可能刚好等于柜体宽度之和，差额收在角落最不显眼。"
          : "，其中有落在柜体之间的。这会打断门缝节奏，如果介意可以让我们重排。"),
    });
  } else if (cabinets.length > 0) {
    items.push({
      kind: "good",
      text: "这面墙被柜体正好填满，没有用到填缝条。",
    });
  }
  return { title: "这一版的构成", items };
}

/** 从实际几何与评分里读出「为什么这么排」，不是套话。 */
function whyThisArrangement(
  input: ExplainDesignInput,
  base: readonly Placement[],
  cabinets: readonly Placement[],
): RationaleSection {
  const items: RationaleItem[] = [];
  const { run } = input;

  // 水槽与窗的关系——只在两者都存在时才说
  const window = run.features.find((f) => f.kind === "window");
  const sink = base.find((p) => p.label === "sink")
    ?? base.find((p) => /^(SB|SK|FSB|APR)|[-_](SB|SK)/i.test(p.moduleCode ?? ""));
  if (window && sink) {
    const sinkCenter = sink.x + sink.width / 2;
    const winCenter = window.offset + window.width / 2;
    const offBy = Math.abs(sinkCenter - winCenter);
    items.push(offBy <= 3
      ? { kind: "good", text: `水槽居中对准了窗户${offBy > 0.1 ? `（偏差 ${formatInches(offBy)}，视觉上看不出来）` : ""}——洗碗时正对采光，这是厨房排布里优先级很高的一条。` }
      : { kind: "tradeoff", text: `水槽中心比窗中心偏了 ${formatInches(offBy)}。这一版为了给两侧留出足够的台面工作区，没有强行对齐；如果你更在意对称，我们可以换一版。` });
  } else if (sink) {
    items.push({ kind: "fact", text: `水槽放在距墙起点 ${formatInches(sink.x)} 处。这面墙没有窗，所以位置主要由上下水与两侧台面决定。` });
  }

  // 抽屉柜——呼应客户的选择
  const drawers = cabinets.filter((p) => /^\dDB/i.test(p.moduleCode ?? ""));
  if (drawers.length > 0) {
    const pref = input.storagePreference;
    items.push({
      kind: "good",
      text: pref === "drawers"
        ? `按你选的「尽量多做抽屉」，这面墙 ${cabinets.length} 个地柜里有 ${drawers.length} 个是抽屉柜。抽屉比门板柜贵，但取放锅碗不用蹲下来伸手进柜子深处。`
        : `灶台/水槽附近用了 ${drawers.length} 个抽屉柜——这两处是取放最频繁的位置，抽屉的便利性提升最明显；其余位置用门板柜控制造价。`,
    });
  } else if (input.storagePreference === "doors") {
    items.push({ kind: "fact", text: "按你选的「以门板柜为主」，这面墙没有排抽屉柜，造价最低。" });
  } else if (input.storagePreference === "drawers") {
    // 客户明确要抽屉却一个都没排出来，必须解释——沉默会让人以为我们没听见
    items.push({
      kind: "tradeoff",
      text: "你选了「尽量多做抽屉」，但这面墙没能排出抽屉柜：" +
        "这家公司的抽屉柜只有特定几个宽度，而这段墙按现有尺寸拆下来凑不出那些宽度。" +
        "换一家公司或调整家电位置后可能就排得出来。",
    });
  }

  // 宽度节奏与窄柜——直接引用评分明细
  const a = input.aesthetics;
  if (a) {
    if (a.breakdown.widthRhythm >= 0.8 && cabinets.length >= 2) {
      items.push({
        kind: "good",
        text: `柜体宽度接近（${cabinets.map((p) => formatInches(p.width)).join("、")}），正视图上门缝节奏均匀。填满一面墙有很多种排法，我们优先选了宽度跳动小的那种。`,
      });
    }
    if (a.breakdown.narrowPenalty >= 0.999) {
      items.push({
        kind: "good",
        text: "没有为了填满而塞窄柜——纯粹凑数的 9 寸、12 寸柜子单位造价高、储物效率低，也最影响观感。",
      });
    }
    if (a.breakdown.seamAlignment >= 0.8 && base.length > 0) {
      items.push({
        kind: "good",
        text: "吊柜的分界线尽量落在了地柜分界线上，正视图上下对齐。",
      });
    }
    // 评分低的项如实说，不只报喜
    for (const note of a.notes) items.push({ kind: "tradeoff", text: note });
  }

  return { title: "为什么这么排", items };
}

/** 逐条说明人体工程检查的结果——通过的也要说，客户才知道这些被检查过。 */
function ergonomicSection(violations: readonly ErgonomicViolation[]): RationaleSection {
  const failedCodes = new Set(violations.map((v) => v.code));
  const items: RationaleItem[] = [];

  const checks: { code: ErgonomicCode; label: string }[] = [
    { code: "SINK_LANDING", label: `水槽两侧台面工作区（一侧 ≥${CLEARANCE.sinkLandingPrimary}"、另一侧 ≥${CLEARANCE.sinkLandingSecondary}"）` },
    { code: "COOKTOP_LANDING", label: `灶具两侧落台区（≥${CLEARANCE.cooktopLandingPrimary}" / ≥${CLEARANCE.cooktopLandingSecondary}"，用来放刚端下来的热锅）` },
    { code: "REFRIGERATOR_LANDING", label: `冰箱把手侧落台区（≥${CLEARANCE.refrigeratorLanding}"）` },
    { code: "DISHWASHER_TOO_FAR", label: `洗碗机距水槽（≤${CLEARANCE.dishwasherToSinkMax}"，不然每次都要滴一路水）` },
    { code: "DISHWASHER_STANDING", label: `洗碗机门开时的站立空间（≥${CLEARANCE.dishwasherStanding}"）` },
    { code: "NO_CONTINUOUS_PREP", label: `连续备餐台面（至少一段 ≥${CLEARANCE.continuousPrepSurface}"）` },
  ];

  for (const c of checks) {
    if (!failedCodes.has(c.code)) items.push({ kind: "good", text: c.label });
  }
  for (const v of violations) {
    items.push({ kind: v.severity === "blocking" ? "warning" : "tradeoff", text: v.message });
  }

  items.push({
    kind: "fact",
    text: "这些是**硬性检查**，不是偏好——违反了方案就不出图，也不能拿去报价。" +
      "数值取自北美 NKBA 厨房规划指南。",
  });

  return { title: "人体工程与安全检查", items };
}

function needsAttention(
  violations: readonly ErgonomicViolation[],
  warnings: readonly LayoutWarning[],
): RationaleSection {
  const items: RationaleItem[] = [];
  for (const v of violations.filter((x) => x.severity === "blocking")) {
    items.push({ kind: "warning", text: v.message });
  }
  for (const w of warnings) {
    items.push({ kind: "warning", text: w.message });
  }
  return { title: "需要处理", items };
}

// ── 呈现 ──────────────────────────────────────────────────────────────────

const KIND_PREFIX: Record<RationaleKind, string> = {
  fact: "·", good: "✓", tradeoff: "△", warning: "!",
};

export function renderRationaleText(r: DesignRationale): string {
  const lines = [strip(r.headline), ""];
  for (const s of r.sections) {
    lines.push(`【${s.title}】`);
    for (const i of s.items) lines.push(`  ${KIND_PREFIX[i.kind]} ${strip(i.text)}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderViewGuideText(views: readonly ViewExplanation[]): string {
  const lines: string[] = ["【怎么看这几张图】", ""];
  for (const v of views) {
    lines.push(`${v.title} —— ${strip(v.whatItShows)}`);
    for (const h of v.howToRead) lines.push(`  · ${strip(h)}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** 去掉 markdown 强调标记——纯文本里 `**x**` 只会碍眼。 */
function strip(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1");
}

const KIND_CLASS: Record<RationaleKind, string> = {
  fact: "x-fact", good: "x-good", tradeoff: "x-tradeoff", warning: "x-warn",
};

export function renderRationaleHtml(r: DesignRationale): string {
  const sections = r.sections.map((s) => `
    <section class="x-sec">
      <h4>${esc(s.title)}</h4>
      <ul>${s.items.map((i) =>
        `<li class="${KIND_CLASS[i.kind]}">${emphasize(i.text)}</li>`).join("")}</ul>
    </section>`).join("");
  return `<div class="x-rationale${r.acceptable ? "" : " x-blocked"}">
    <p class="x-head">${emphasize(r.headline)}</p>${sections}</div>`;
}

export function renderViewGuideHtml(views: readonly ViewExplanation[]): string {
  return `<div class="x-guide"><h4>怎么看这几张图</h4>${views.map((v) => `
    <section class="x-sec">
      <h5>${esc(v.title)}</h5>
      <p>${emphasize(v.whatItShows)}</p>
      <ul>${v.howToRead.map((h) => `<li>${emphasize(h)}</li>`).join("")}</ul>
    </section>`).join("")}</div>`;
}

/** 先转义再把 `**x**` 变成 `<strong>` —— 顺序反了就是 XSS。 */
function emphasize(s: string): string {
  return esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
