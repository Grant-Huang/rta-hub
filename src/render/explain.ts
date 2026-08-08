/**
 * 图纸解释 —— 客户拿到四视图时，配一段说清「这是什么图」和「为什么这么排」。
 *
 * ## 语言
 *
 * 默认英文。只有会话里明确记下的语言偏好为中文时才出中文
 * （与对话 / 界面 chrome 同一套 `UiLanguage`）。
 *
 * **图纸上的标注文字**（图例、标题、家电名）不走这里——那些在 palette /
 * annotate 里，一律英文，无视语言偏好。
 *
 * ## 一条硬规则：解释必须来自**实际算出来的结果**
 *
 * 这里不写套话。「水槽对准了窗中心」只有在真的对准时才说，偏了多少也照实说——
 * 数据来自 `aesthetics` 的评分明细与 `ergonomics` 的检查结果，不是模板文案。
 */
import type { UiLanguage } from "../i18n/language.js";
import { DEFAULT_LANGUAGE } from "../i18n/language.js";
import type { WallRun } from "../floorplan/types.js";
import type { AestheticScore } from "../layout/aesthetics.js";
import type { ErgonomicViolation } from "../layout/ergonomics.js";
import { CLEARANCE } from "../layout/ergonomics.js";
import type { ErgonomicCode } from "../layout/ergonomics.js";
import { HEIGHTS, type LayoutWarning, type Placement } from "../layout/generate.js";
import { formatInches } from "./views.js";

type Lang = UiLanguage;

function L(lang: Lang, en: string, zh: string): string {
  return lang === "zh" ? zh : en;
}

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
  /** 客户语言偏好。默认英文。 */
  language?: Lang;
}

function constructionNote(lang: Lang, kind: "framed" | "frameless"): string {
  if (kind === "framed") {
    return L(lang,
      "This seller uses **face-frame** cabinets: a solid wood frame on the front, doors overlay the frame — so each door looks slightly smaller than the box on the elevation.",
      "这家公司做的是**面框柜**：柜体正面有一圈实木框，门板盖在框上。所以正视图上每个柜子的门比柜体略小一圈。");
  }
  return L(lang,
    "This seller uses **frameless** (European) cabinets: no face frame, doors cover the side panels — so reveals are tighter and interior width is larger.",
    "这家公司做的是**无框柜**（欧式）：没有面框，门板直接盖住柜体侧板，所以门缝更窄、内部可用宽度更大。");
}

function overlayNote(lang: Lang, kind: "full" | "partial" | "inset"): string {
  if (kind === "full") {
    return L(lang,
      "Full overlay doors — nearly cover the cabinet front; only a narrow reveal between doors.",
      "全覆盖门板——门几乎盖满柜体正面，相邻两扇门之间只留一条窄缝。");
  }
  if (kind === "partial") {
    return L(lang,
      "Partial overlay doors — cover only part of the front so more of the frame shows, and reveals look wider.",
      "半覆盖门板——门只盖住一部分，柜体边框会露出来，门缝看起来更宽。");
  }
  return L(lang,
    "Inset doors — set into the frame, flush with it; the most expensive and precise approach.",
    "嵌入式门板——门嵌在框里、与框齐平，是造价最高也最考究的做法。");
}

export function explainViews(opts: ViewExplainOptions): ViewExplanation[] {
  const lang = opts.language ?? DEFAULT_LANGUAGE;
  const out: ViewExplanation[] = [];

  const frontRead = [
    L(lang,
      "Vertical lines are **cabinet joints**; finer lines on each cabinet are door reveals.",
      "竖线是**柜体之间的分界**，每个柜子上更细的线是门缝。"),
    constructionNote(lang, opts.construction),
    overlayNote(lang, opts.overlay),
    L(lang,
      `Base counter height is ${formatInches(HEIGHTS.counterTop)}; the bottom strip is the toe kick` +
        ` (${formatInches(HEIGHTS.toeKick)} high, set back so you have room for your toes while working).`,
      `地柜台面高 ${formatInches(HEIGHTS.counterTop)}，最下面一条是踢脚线` +
        `（高 ${formatInches(HEIGHTS.toeKick)}，往里缩进，站着操作时脚有地方放）。`),
  ];
  if (opts.hasWallCabinets) {
    frontRead.push(L(lang,
      `Wall cabinets start ${formatInches(HEIGHTS.wallBaseline)} above the floor,` +
        ` leaving ${formatInches(HEIGHTS.backsplash)} between counter and wall cab for work space and backsplash.`,
      `吊柜底边距地 ${formatInches(HEIGHTS.wallBaseline)}，` +
        `与台面之间留出 ${formatInches(HEIGHTS.backsplash)} 的操作与挡水板空间。`));
  }
  if (opts.hasFillers) {
    frontRead.push(L(lang,
      "Narrow strips without door reveals are **fillers** — walls rarely match cabinet widths exactly, so leftover gaps get fillers, usually at corners.",
      "窄条状、没有门缝的那几块是**填缝条**——墙不可能刚好等于柜体宽度之和，差出来的部分用填缝条补，通常靠墙角放，不显眼。"));
  }
  if (opts.hasAppliances) {
    frontRead.push(L(lang,
      "Open rectangles are **appliance openings** (fridge, range, dishwasher) — not cabinets.",
      "空出来的方框是**家电预留位**（冰箱、灶台、洗碗机），不是柜子。"));
  }

  out.push({
    view: "front",
    title: L(lang, "Front elevation", "正视图"),
    whatItShows: L(lang,
      "What you see standing in the kitchen facing this wall — closest to “how it will look installed.”",
      "站在厨房里正对这面墙看到的样子。这是最接近「装好之后长什么样」的一张。"),
    howToRead: frontRead,
  });

  out.push({
    view: "topBase",
    title: L(lang, "Plan · base", "俯视图 · 地柜层"),
    whatItShows: L(lang,
      "Looking down at the base run on this wall — **plan position and depth**.",
      "从上往下看这面墙的地柜排布，看的是**平面位置与进深**。"),
    howToRead: [
      L(lang,
        "Rectangles are cabinets; widths are to scale; depth is usually 24\".",
        "矩形是柜体，宽度按实际尺寸画，进深通常是 24 寸。"),
      L(lang,
        "Arcs on cabinets show **door swing** — leave clearance where the arc sweeps.",
        "柜体上的弧线是**开门方向示意**——弧线扫过的地方要留出开门空间。"),
      L(lang,
        "Corners: a diagonal cut is a corner cabinet; an L shape is a blind corner (one side reaches into the dead corner — needs a pull-out to reach).",
        "转角处有两种画法：斜切的是转角柜，L 形的是盲角柜（有一侧伸进转角深处，要配拉篮才够得着）。"),
    ],
  });

  if (opts.hasWallCabinets) {
    out.push({
      view: "topWall",
      title: L(lang, "Plan · wall", "俯视图 · 吊柜层"),
      whatItShows: L(lang,
        "Same wall, wall cabinets only. **Drawn separately from the base** because joint lines often don't line up.",
        "同一面墙，但看的是吊柜。**与地柜层分开画**，因为两层的分界线位置往往不同。"),
      howToRead: [
        L(lang,
          "Wall cabinets are usually 12\" deep — half of base — so you don't bump your head at the counter.",
          "吊柜进深通常是 12 寸，只有地柜的一半——所以人站在台面前操作时头不会撞到。"),
        L(lang,
          "Compare with the base plan to see whether upper and lower joints align (aligned seams look cleaner on the elevation).",
          "把这张和地柜层对照着看，能看出上下柜的分界线是否对齐（对齐了正视图上更整齐）。"),
      ],
    });
  }

  out.push({
    view: "side",
    title: L(lang, "Side section", "侧视图"),
    whatItShows: L(lang,
      "A side cut showing **heights**: counter, wall cabinets, and the gap between.",
      "从侧面剖开看，交代的是**各个高度**：台面多高、吊柜多高、中间留多少。"),
    howToRead: [
      L(lang,
        "This view doesn't change with wall length — same construction looks the same on every run.",
        "这张图不随墙长变化，同一套做法下所有墙段都一样。"),
      L(lang,
        "Use it to check ceiling height — leave room above wall cabinets for crown molding.",
        "它主要用来确认层高够不够——吊柜顶到天花板之间要留出装顶线的空间。"),
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
  /** 呈现时用的语言（默认英文）。 */
  language: Lang;
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
  /** 客户语言偏好。默认英文。 */
  language?: Lang;
}

export function explainDesign(input: ExplainDesignInput): DesignRationale {
  const lang = input.language ?? DEFAULT_LANGUAGE;
  const mine = input.placements.filter((p) => p.wallRunId === input.run.id);
  const base = mine.filter((p) => p.layer === "base").sort((a, b) => a.x - b.x);
  const cabinets = base.filter((p) => p.kind === "cabinet");
  const fillers = base.filter((p) => p.kind === "filler");
  const appliances = base.filter((p) => p.applianceKind !== undefined);
  const wall = mine.filter((p) => p.layer === "wall" && p.kind === "cabinet");

  const sections: RationaleSection[] = [
    composition(lang, input.run, cabinets, wall, fillers, appliances),
  ];

  const why = whyThisArrangement(lang, input, base, cabinets);
  if (why.items.length > 0) sections.push(why);

  sections.push(ergonomicSection(lang, input.ergonomics));

  const attention = needsAttention(lang, input.ergonomics, input.warnings ?? []);
  if (attention.items.length > 0) sections.push(attention);

  return {
    headline: headline(lang, input.run, cabinets.length, input.acceptable),
    sections,
    acceptable: input.acceptable,
    language: lang,
  };
}

function headline(lang: Lang, run: WallRun, cabinetCount: number, acceptable: boolean): string {
  const base = L(lang,
    `${run.label} (${formatInches(run.length)}) — ${cabinetCount} base cabinet(s)`,
    `${run.label}（${formatInches(run.length)}）排了 ${cabinetCount} 个柜体`);
  return acceptable
    ? L(lang,
      `${base}; all ergonomic checks passed.`,
      `${base}，人体工程检查全部通过。`)
    : L(lang,
      `${base}, but **failed ergonomic checks** — this version can't be quoted yet; see items below.`,
      `${base}，但**未通过人体工程检查**——这一版还不能用来出报价，见下方待处理项。`);
}

function composition(
  lang: Lang,
  run: WallRun,
  cabinets: readonly Placement[],
  wall: readonly Placement[],
  fillers: readonly Placement[],
  appliances: readonly Placement[],
): RationaleSection {
  const items: RationaleItem[] = [];
  const join = lang === "zh" ? "、" : ", ";

  const widths = cabinets.map((p) => formatInches(p.width)).join(" + ");
  if (cabinets.length > 0) {
    items.push({
      kind: "fact",
      text: L(lang,
        `Base left-to-right: ${cabinets.map((p) => p.moduleCode ?? "?").join(join)}; widths ${widths}.`,
        `地柜从左到右依次是 ${cabinets.map((p) => p.moduleCode ?? "?").join("、")}，宽度 ${widths}。`),
    });
  }
  if (wall.length > 0) {
    items.push({
      kind: "fact",
      text: L(lang,
        `${wall.length} wall cabinet(s) at ${formatInches(wall[0]!.height)}` +
          ` (height tier for the ceiling, leaving room for crown).`,
        `吊柜 ${wall.length} 个，高度 ${formatInches(wall[0]!.height)}` +
          `（按层高选的档位，顶上留出装顶线的空间）。`),
    });
  }
  if (appliances.length > 0) {
    const labels = appliances.map((p) =>
      `${p.label ?? L(lang, "appliance", "家电")} ${formatInches(p.width)}`);
    items.push({
      kind: "fact",
      text: L(lang,
        `Appliance openings reserved: ${labels.join(join)}.`,
        `预留的家电位：${labels.join("、")}。`),
    });
  }
  if (fillers.length > 0) {
    const total = fillers.reduce((s, p) => s + p.width, 0);
    const atEdge = fillers.every(
      (p) => p.x < 0.26 || Math.abs(p.x + p.width - run.length) < 0.26);
    items.push({
      kind: atEdge ? "good" : "tradeoff",
      text: L(lang,
        `Used ${fillers.length} filler(s) totaling ${formatInches(total)}` +
          (atEdge
            ? " — all at corners, where leftover wall length is least noticeable."
            : " — some sit between cabinets, which breaks the reveal rhythm; we can re-layout if that bothers you."),
        `用了 ${fillers.length} 条填缝条共 ${formatInches(total)}` +
          (atEdge
            ? "，都放在墙角——墙长不可能刚好等于柜体宽度之和，差额收在角落最不显眼。"
            : "，其中有落在柜体之间的。这会打断门缝节奏，如果介意可以让我们重排。")),
    });
  } else if (cabinets.length > 0) {
    items.push({
      kind: "good",
      text: L(lang,
        "This wall fills exactly with cabinets — no fillers needed.",
        "这面墙被柜体正好填满，没有用到填缝条。"),
    });
  }
  return { title: L(lang, "What's in this layout", "这一版的构成"), items };
}

function whyThisArrangement(
  lang: Lang,
  input: ExplainDesignInput,
  base: readonly Placement[],
  cabinets: readonly Placement[],
): RationaleSection {
  const items: RationaleItem[] = [];
  const { run } = input;
  const join = lang === "zh" ? "、" : ", ";

  const window = run.features.find((f) => f.kind === "window");
  const sink = base.find((p) => p.label === "sink")
    ?? base.find((p) => p.applianceKind === undefined
      && /^(SB|SK|FSB|APR)|[-_](SB|SK)/i.test(p.moduleCode ?? ""));
  if (window && sink) {
    const sinkCenter = sink.x + sink.width / 2;
    const winCenter = window.offset + window.width / 2;
    const offBy = Math.abs(sinkCenter - winCenter);
    items.push(offBy <= 3
      ? {
          kind: "good",
          text: L(lang,
            `Sink is centered on the window${offBy > 0.1 ? ` (offset ${formatInches(offBy)}, not visually obvious)` : ""} — good daylight while washing; high priority in kitchen layout.`,
            `水槽居中对准了窗户${offBy > 0.1 ? `（偏差 ${formatInches(offBy)}，视觉上看不出来）` : ""}——洗碗时正对采光，这是厨房排布里优先级很高的一条。`),
        }
      : {
          kind: "tradeoff",
          text: L(lang,
            `Sink center is ${formatInches(offBy)} off the window center. This version kept landing space on both sides instead of forcing symmetry; we can try another version if symmetry matters more to you.`,
            `水槽中心比窗中心偏了 ${formatInches(offBy)}。这一版为了给两侧留出足够的台面工作区，没有强行对齐；如果你更在意对称，我们可以换一版。`),
        });
  } else if (sink) {
    items.push({
      kind: "fact",
      text: L(lang,
        `Sink starts ${formatInches(sink.x)} from the wall start. No window on this run, so placement follows plumbing and landings.`,
        `水槽放在距墙起点 ${formatInches(sink.x)} 处。这面墙没有窗，所以位置主要由上下水与两侧台面决定。`),
    });
  }

  const drawers = cabinets.filter((p) => /^\dDB/i.test(p.moduleCode ?? ""));
  if (drawers.length > 0) {
    const pref = input.storagePreference;
    items.push({
      kind: "good",
      text: pref === "drawers"
        ? L(lang,
          `Per your “as many drawers as possible” preference, ${drawers.length} of ${cabinets.length} base cabinets on this wall are drawers. Drawers cost more than doors but you don't crouch to reach pots.`,
          `按你选的「尽量多做抽屉」，这面墙 ${cabinets.length} 个地柜里有 ${drawers.length} 个是抽屉柜。抽屉比门板柜贵，但取放锅碗不用蹲下来伸手进柜子深处。`)
        : L(lang,
          `${drawers.length} drawer cabinet(s) near the range/sink — highest-use zones get the biggest convenience lift; door cabinets elsewhere keep cost down.`,
          `灶台/水槽附近用了 ${drawers.length} 个抽屉柜——这两处是取放最频繁的位置，抽屉的便利性提升最明显；其余位置用门板柜控制造价。`),
    });
  } else if (input.storagePreference === "doors") {
    items.push({
      kind: "fact",
      text: L(lang,
        "Per your “mostly door cabinets” preference, this wall has no drawer bases — lowest cost.",
        "按你选的「以门板柜为主」，这面墙没有排抽屉柜，造价最低。"),
    });
  } else if (input.storagePreference === "drawers") {
    items.push({
      kind: "tradeoff",
      text: L(lang,
        "You asked for “as many drawers as possible,” but this wall couldn't place any: this seller's drawer SKUs only come in certain widths, and the remaining segments don't match. Another seller or appliance shift may unlock them.",
        "你选了「尽量多做抽屉」，但这面墙没能排出抽屉柜：这家公司的抽屉柜只有特定几个宽度，而这段墙按现有尺寸拆下来凑不出那些宽度。换一家公司或调整家电位置后可能就排得出来。"),
    });
  }

  const a = input.aesthetics;
  if (a) {
    if (a.breakdown.widthRhythm >= 0.8 && cabinets.length >= 2) {
      items.push({
        kind: "good",
        text: L(lang,
          `Cabinet widths are close (${cabinets.map((p) => formatInches(p.width)).join(join)}), so elevation reveals look even. Many packings fill a wall; we preferred smaller width jumps.`,
          `柜体宽度接近（${cabinets.map((p) => formatInches(p.width)).join("、")}），正视图上门缝节奏均匀。填满一面墙有很多种排法，我们优先选了宽度跳动小的那种。`),
      });
    }
    if (a.breakdown.narrowPenalty >= 0.999) {
      items.push({
        kind: "good",
        text: L(lang,
          "No filler-width “spacer” cabinets just to fill the wall — pure 9\"/12\" fillers as cabinets cost more per inch, store less, and hurt the look.",
          "没有为了填满而塞窄柜——纯粹凑数的 9 寸、12 寸柜子单位造价高、储物效率低，也最影响观感。"),
      });
    }
    if (a.breakdown.seamAlignment >= 0.8 && base.length > 0) {
      items.push({
        kind: "good",
        text: L(lang,
          "Wall-cabinet joints land on base joints where possible — aligned seams on the elevation.",
          "吊柜的分界线尽量落在了地柜分界线上，正视图上下对齐。"),
      });
    }
    for (const note of a.notes) items.push({ kind: "tradeoff", text: note });
  }

  return { title: L(lang, "Why this arrangement", "为什么这么排"), items };
}

function ergonomicSection(lang: Lang, violations: readonly ErgonomicViolation[]): RationaleSection {
  const failedCodes = new Set(violations.map((v) => v.code));
  const items: RationaleItem[] = [];

  const checks: { code: ErgonomicCode; label: string }[] = [
    {
      code: "SINK_LANDING",
      label: L(lang,
        `Sink landing (one side ≥${CLEARANCE.sinkLandingPrimary}", other ≥${CLEARANCE.sinkLandingSecondary}")`,
        `水槽两侧台面工作区（一侧 ≥${CLEARANCE.sinkLandingPrimary}"、另一侧 ≥${CLEARANCE.sinkLandingSecondary}"）`),
    },
    {
      code: "COOKTOP_LANDING",
      label: L(lang,
        `Cooktop landing (≥${CLEARANCE.cooktopLandingPrimary}" / ≥${CLEARANCE.cooktopLandingSecondary}" for hot pans)`,
        `灶具两侧落台区（≥${CLEARANCE.cooktopLandingPrimary}" / ≥${CLEARANCE.cooktopLandingSecondary}"，用来放刚端下来的热锅）`),
    },
    {
      code: "REFRIGERATOR_LANDING",
      label: L(lang,
        `Fridge handle-side landing (≥${CLEARANCE.refrigeratorLanding}")`,
        `冰箱把手侧落台区（≥${CLEARANCE.refrigeratorLanding}"）`),
    },
    {
      code: "DISHWASHER_TOO_FAR",
      label: L(lang,
        `Dishwasher to sink (≤${CLEARANCE.dishwasherToSinkMax}" — else you drip across the floor)`,
        `洗碗机距水槽（≤${CLEARANCE.dishwasherToSinkMax}"，不然每次都要滴一路水）`),
    },
    {
      code: "DISHWASHER_STANDING",
      label: L(lang,
        `Standing space with dishwasher door open (≥${CLEARANCE.dishwasherStanding}")`,
        `洗碗机门开时的站立空间（≥${CLEARANCE.dishwasherStanding}"）`),
    },
    {
      code: "NO_CONTINUOUS_PREP",
      label: L(lang,
        `Continuous prep surface (at least one run ≥${CLEARANCE.continuousPrepSurface}")`,
        `连续备餐台面（至少一段 ≥${CLEARANCE.continuousPrepSurface}"）`),
    },
  ];

  for (const c of checks) {
    if (!failedCodes.has(c.code)) items.push({ kind: "good", text: c.label });
  }
  for (const v of violations) {
    items.push({ kind: v.severity === "blocking" ? "warning" : "tradeoff", text: v.message });
  }

  items.push({
    kind: "fact",
    text: L(lang,
      "These are **hard checks**, not preferences — failing them blocks drawings and quotes. Clearances follow North American NKBA kitchen guidelines.",
      "这些是**硬性检查**，不是偏好——违反了方案就不出图，也不能拿去报价。数值取自北美 NKBA 厨房规划指南。"),
  });

  return { title: L(lang, "Ergonomics & safety", "人体工程与安全检查"), items };
}

function needsAttention(
  lang: Lang,
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
  return { title: L(lang, "Needs attention", "需要处理"), items };
}

// ── 呈现 ──────────────────────────────────────────────────────────────────

const KIND_PREFIX: Record<RationaleKind, string> = {
  fact: "·", good: "✓", tradeoff: "△", warning: "!",
};

export function renderRationaleText(r: DesignRationale): string {
  const wrap = (title: string) =>
    r.language === "zh" ? `【${title}】` : `[${title}]`;
  const lines = [strip(r.headline), ""];
  for (const s of r.sections) {
    lines.push(wrap(s.title));
    for (const i of s.items) lines.push(`  ${KIND_PREFIX[i.kind]} ${strip(i.text)}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderViewGuideText(views: readonly ViewExplanation[], language: Lang = DEFAULT_LANGUAGE): string {
  const sep = language === "zh" ? " —— " : " — ";
  const lines: string[] = [
    L(language, "[How to read these drawings]", "【怎么看这几张图】"),
    "",
  ];
  for (const v of views) {
    lines.push(`${v.title}${sep}${strip(v.whatItShows)}`);
    for (const h of v.howToRead) lines.push(`  · ${strip(h)}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

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

export function renderViewGuideHtml(
  views: readonly ViewExplanation[],
  language: Lang = DEFAULT_LANGUAGE,
): string {
  const heading = L(language, "How to read these drawings", "怎么看这几张图");
  return `<div class="x-guide"><h4>${esc(heading)}</h4>${views.map((v) => `
    <section class="x-sec">
      <h5>${esc(v.title)}</h5>
      <p>${emphasize(v.whatItShows)}</p>
      <ul>${v.howToRead.map((h) => `<li>${emphasize(h)}</li>`).join("")}</ul>
    </section>`).join("")}</div>`;
}

function emphasize(s: string): string {
  return esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
