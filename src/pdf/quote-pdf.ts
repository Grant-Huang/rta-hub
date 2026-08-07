/**
 * 正式报价单 PDF —— MVP-3（REQUIREMENTS 第 9 节、开放问题 2）。
 *
 * 立面图**直接从 `Placement` 几何画成 PDF 矢量指令**，不经过 SVG 再转换——
 * 我们本来就持有绝对英寸坐标（RENDERING.md 4.3），转换一道只会引入误差与依赖。
 * 门缝、面框这些绝对尺寸同样按绝对量画，不随页面缩放变形。
 */
import { format, type Money } from "../domain/money.js";
import type { Quote } from "../domain/types.js";
import type { WallRun } from "../floorplan/types.js";
import { HEIGHTS, type Placement } from "../layout/generate.js";
import { layoutFace } from "../render/face-grammar.js";
import { buildFace, type FaceTemplateId } from "../render/templates.js";
import { formatInches } from "../render/views.js";
import {
  BLACK, GREY, LETTER, LETTER_LANDSCAPE, LIGHT, PdfPage, buildPdf, isWinAnsiSafe,
} from "./writer.js";

const MARGIN = 54; // 0.75"

/**
 * 墙段标签的英文呈现。
 *
 * 户型解析出来的标签是中文（「北墙」「灶台墙」），而这份 PDF 的收件方是
 * 加拿大橱柜公司——正文本来就该是英文。base-14 字体画不出中文，
 * 与其在图纸上留一串 `??`，不如换成对方看得懂的说法。
 */
const WALL_LABEL_EN: Record<string, string> = {
  "北墙": "North Wall", "南墙": "South Wall", "东墙": "East Wall", "西墙": "West Wall",
  "左墙": "Left Wall", "右墙": "Right Wall", "主墙": "Main Wall", "对墙": "Opposite Wall",
  "灶台墙": "Range Wall", "水槽墙": "Sink Wall", "冰箱墙": "Refrigerator Wall",
  "岛台": "Island", "半岛": "Peninsula",
};

/** 画得出来就用原标签；画不出来先查译名，再退到位置编号——绝不留 `??`。 */
export function elevationLabel(label: string, index: number): string {
  if (isWinAnsiSafe(label)) return label;
  const mapped = WALL_LABEL_EN[label.trim()];
  if (mapped) return mapped;
  return `Wall ${index + 1}`;
}

export interface QuotePdfInput {
  quote: Quote;
  companyName: string;
  customerName: string;
  customerEmail: string;
  province: string;
  doorStyleName: string;
  /**
   * 箱体板材名。PDF 是客户拿去下单、拿去比价的那一份，
   * 「同一款门配什么箱体」必须写在抬头上——不写，两家的价看起来就是可比的。
   */
  boxMaterialName?: string;
  /** 每段墙的几何与摆放，用于画立面图。 */
  runs: { run: WallRun; placements: readonly Placement[] }[];
  senderName: string;
  senderContact?: string;
  construction?: "framed" | "frameless";
  overlay?: "full" | "partial" | "inset";
}

export interface QuotePdfResult {
  pdf: Buffer;
  /** 字符替换等提示——不静默丢字。 */
  warnings: string[];
}

export function buildQuotePdf(input: QuotePdfInput): QuotePdfResult {
  const pages: PdfPage[] = [buildSummaryPage(input)];
  input.runs.forEach((r, i) => {
    if (r.run.length > 0) {
      pages.push(buildElevationPage(input, r.run, r.placements, elevationLabel(r.run.label, i)));
    }
  });

  const warnings = [...new Set(pages.flatMap((p) => p.warnings))];
  return {
    pdf: buildPdf(pages, {
      title: `Quote ${input.quote.id}`,
      author: input.senderName,
      subject: `Kitchen cabinet quote for ${input.companyName}`,
    }),
    warnings,
  };
}

// ── 第 1 页：摘要与价格明细 ───────────────────────────────────────────────

function buildSummaryPage(input: QuotePdfInput): PdfPage {
  const { quote: q } = input;
  const page = new PdfPage(LETTER);
  const right = LETTER.width - MARGIN;
  let y = MARGIN;

  page.setFill(BLACK).text("KITCHEN CABINET QUOTE", MARGIN, y, { font: "Helvetica-Bold", size: 18 });
  page.text(`No. ${q.id}`, right, y + 4, { align: "right", size: 10, color: GREY });
  y += 26;
  page.setStroke(BLACK).setLineWidth(1.2).line(MARGIN, y, right, y);
  y += 18;

  // 双栏抬头
  const colW = (right - MARGIN) / 2;
  const meta: [string, string][] = [
    ["To", input.companyName],
    ["From", `${input.customerName} <${input.customerEmail}>`],
    ["Province", input.province],
    ["Door style", input.doorStyleName],
    ...(input.boxMaterialName
      ? [["Box material", input.boxMaterialName] as [string, string]] : []),
  ];
  const dates: [string, string][] = [
    ["Issued", q.createdAt.slice(0, 10)],
    ["Valid until", q.validUntil.slice(0, 10)],
    ["Currency", q.currency],
    ["Account type", q.accountTypeAtQuote === "trade" ? "Trade" : "Consumer"],
  ];
  meta.forEach(([label, value], i) => {
    page.text(label, MARGIN, y + i * 14, { size: 8, color: GREY });
    page.text(value, MARGIN + 62, y + i * 14, { size: 10, color: BLACK });
  });
  dates.forEach(([label, value], i) => {
    page.text(label, MARGIN + colW, y + i * 14, { size: 8, color: GREY });
    page.text(value, MARGIN + colW + 62, y + i * 14, { size: 10, color: BLACK });
  });
  y += meta.length * 14 + 18;

  // 明细表
  const cols = { code: MARGIN, spec: MARGIN + 78, qty: MARGIN + 240, list: MARGIN + 310, net: MARGIN + 400, sub: right };
  page.setFill(LIGHT).rect(MARGIN, y - 3, right - MARGIN, 16, "f");
  page.text("Item", cols.code, y, { font: "Helvetica-Bold", size: 9, color: BLACK });
  page.text("Size", cols.spec, y, { font: "Helvetica-Bold", size: 9 });
  page.text("Qty", cols.qty + 30, y, { font: "Helvetica-Bold", size: 9, align: "right" });
  page.text("List", cols.list + 60, y, { font: "Helvetica-Bold", size: 9, align: "right" });
  page.text("Net", cols.net + 60, y, { font: "Helvetica-Bold", size: 9, align: "right" });
  page.text("Amount", cols.sub, y, { font: "Helvetica-Bold", size: 9, align: "right" });
  y += 18;

  page.setStroke(LIGHT).setLineWidth(0.5);
  for (const line of q.lineItems) {
    page.text(line.moduleCode, cols.code, y, { size: 9 });
    page.text(
      `${formatInches(line.width)} x ${formatInches(line.height)} x ${formatInches(line.depth)}`,
      cols.spec, y, { size: 8, color: GREY },
    );
    page.text(String(line.qty), cols.qty + 30, y, { size: 9, align: "right" });
    page.text(format(line.unitListPrice), cols.list + 60, y, { size: 9, align: "right" });
    page.text(format(line.unitNetPrice), cols.net + 60, y, { size: 9, align: "right" });
    page.text(format(line.lineSubtotal), cols.sub, y, { size: 9, align: "right" });
    y += 13;
    page.line(MARGIN, y - 3, right, y - 3);
  }

  // 汇总
  y += 8;
  const sumX = right - 170;
  const rows: [string, string, boolean][] = [
    ["Subtotal", format(q.subtotal), false],
    ...q.discounts.map((d) => [truncate(d.description, 28), `-${format(d.amount)}`, false] as [string, string, boolean]),
    ["Shipping", format(q.shipping.amount), false],
    ...q.taxes.map((t) => [`${t.name} ${t.ratePercent}%`, format(t.amount), false] as [string, string, boolean]),
  ];
  for (const [label, value] of rows) {
    page.text(label, sumX, y, { size: 9, color: GREY });
    page.text(value, right, y, { size: 9, align: "right" });
    y += 13;
  }
  page.setStroke(BLACK).setLineWidth(1).line(sumX, y, right, y);
  y += 6;
  page.text(`TOTAL (${q.currency})`, sumX, y, { font: "Helvetica-Bold", size: 11 });
  page.text(format(q.total), right, y, { font: "Helvetica-Bold", size: 13, align: "right" });

  // 页脚
  const footY = LETTER.height - MARGIN - 34;
  page.setStroke(LIGHT).setLineWidth(0.5).line(MARGIN, footY, right, footY);
  page.text(
    "This is a one-time quote request confirmed by the customer, not a marketing message.",
    MARGIN, footY + 8, { size: 8, color: GREY },
  );
  page.text(
    `${input.senderName}${input.senderContact ? `  |  ${input.senderContact}` : ""}`,
    MARGIN, footY + 20, { size: 8, color: GREY },
  );
  page.text("Page 1", right, footY + 20, { size: 8, color: GREY, align: "right" });
  return page;
}

// ── 后续页：立面图 ────────────────────────────────────────────────────────

function buildElevationPage(
  input: QuotePdfInput,
  run: WallRun,
  placements: readonly Placement[],
  label: string,
): PdfPage {
  const page = new PdfPage(LETTER_LANDSCAPE);
  const right = LETTER_LANDSCAPE.width - MARGIN;
  let y = MARGIN;

  page.setFill(BLACK).text(`ELEVATION — ${label}`, MARGIN, y, { font: "Helvetica-Bold", size: 14 });
  page.text(`Wall length ${formatInches(run.length)}`, right, y + 3, { align: "right", size: 9, color: GREY });
  y += 22;
  page.setStroke(BLACK).setLineWidth(1).line(MARGIN, y, right, y);
  y += 24;

  const mine = placements.filter((p) => p.wallRunId === run.id);
  const wallTop = Math.max(
    ...mine.filter((p) => p.layer === "wall").map((p) => HEIGHTS.wallBaseline + p.height),
    HEIGHTS.counterTop,
  );
  const drawingHeight = wallTop + 4;

  // 按可用区域定比例（点/英寸）。比例只影响整体大小，
  // 门缝等绝对尺寸在算完英寸坐标后统一乘以同一个比例，不会各自变形。
  const availW = right - MARGIN;
  const availH = LETTER_LANDSCAPE.height - y - MARGIN - 60;
  const scale = Math.min(availW / run.length, availH / drawingHeight);
  const originTop = y;
  const px = (inches: number) => MARGIN + inches * scale;
  const pyTop = (heightAboveFloor: number) => originTop + (drawingHeight - heightAboveFloor) * scale;

  // 地面线
  page.setStroke(BLACK).setLineWidth(1.2)
    .line(px(0), pyTop(0), px(run.length), pyTop(0));

  for (const p of mine) {
    if (p.layer === "base") {
      drawCabinet(page, p, px, pyTop, scale, HEIGHTS.baseBox, input);
    } else if (p.layer === "wall") {
      drawCabinet(page, p, px, pyTop, scale, HEIGHTS.wallBaseline + p.height, input, HEIGHTS.wallBaseline);
    }
  }

  // 台面
  page.setFill({ r: 0.23, g: 0.23, b: 0.23 })
    .rect(px(0), pyTop(HEIGHTS.counterTop), run.length * scale, HEIGHTS.counterThickness * scale, "f");

  // 标注
  const dimY = pyTop(0) + 16;
  page.setStroke(GREY).setLineWidth(0.6).dash([]);
  page.line(px(0), dimY, px(run.length), dimY);
  page.line(px(0), dimY - 3, px(0), dimY + 3);
  page.line(px(run.length), dimY - 3, px(run.length), dimY + 3);
  page.text(formatInches(run.length), px(run.length / 2), dimY + 4, {
    size: 8, color: GREY, align: "center",
  });
  page.text(
    `Counter ${formatInches(HEIGHTS.counterTop)}  |  Backsplash ${formatInches(HEIGHTS.backsplash)}  |  ` +
    `Toe kick ${formatInches(HEIGHTS.toeKick)}`,
    MARGIN, dimY + 20, { size: 8, color: GREY },
  );

  const footY = LETTER_LANDSCAPE.height - MARGIN - 14;
  page.text(
    "Drawn from calculated cabinet positions. Not to scale when printed at reduced size.",
    MARGIN, footY, { size: 8, color: GREY },
  );
  return page;
}

function drawCabinet(
  page: PdfPage,
  p: Placement,
  px: (i: number) => number,
  pyTop: (h: number) => number,
  scale: number,
  topHeight: number,
  input: QuotePdfInput,
  bottomHeight = 0,
): void {
  const x = px(p.x);
  const w = p.width * scale;

  if (p.kind === "appliance") {
    page.setStroke(GREY).setLineWidth(0.8).dash([4, 3]);
    page.rect(x, pyTop(topHeight), w, (topHeight - bottomHeight) * scale, "S");
    page.dash([]);
    page.text(applianceLabel(p), x + w / 2, pyTop(topHeight) + (topHeight - bottomHeight) * scale / 2 - 4,
      { size: 8, color: GREY, align: "center" });
    return;
  }

  if (p.kind === "filler") {
    page.setFill({ r: 0.9, g: 0.88, b: 0.83 }).setStroke(BLACK).setLineWidth(0.8);
    page.rect(x, pyTop(topHeight), w, (topHeight - bottomHeight) * scale, "B");
    return;
  }

  // 柜体：用脸型文法算出门/抽屉分格的绝对英寸坐标，再统一乘比例
  const faceHeight = p.layer === "base" ? p.height - HEIGHTS.toeKick : p.height;
  const faceTop = p.layer === "base" ? HEIGHTS.baseBox : topHeight;
  const templateId = p.faceTemplateId as FaceTemplateId | undefined;

  page.setFill({ r: 0.98, g: 0.97, b: 0.94 }).setStroke(BLACK).setLineWidth(0.8);
  page.rect(x, pyTop(faceTop), w, faceHeight * scale, "B");

  if (templateId) {
    try {
      const face = layoutFace(buildFace(templateId, {}), p.width, faceHeight, {
        overlay: input.overlay ?? "full",
        construction: input.construction ?? "framed",
        faceFrameWidth: 1.5,
      });
      page.setLineWidth(0.6);
      for (const leaf of face.leaves) {
        page.setFill(leafFill(leaf.kind));
        page.rect(
          px(p.x + leaf.x), pyTop(faceTop - leaf.y),
          leaf.w * scale, leaf.h * scale, "B",
        );
      }
    } catch {
      // 脸型算不出来（尺寸太小容不下缝隙）就只画外框，不画错的分格
    }
  }

  // 踢脚线
  if (p.layer === "base") {
    page.setFill({ r: 0.85, g: 0.83, b: 0.78 }).setStroke(BLACK).setLineWidth(0.6);
    page.rect(px(p.x + 3), pyTop(HEIGHTS.toeKick), (p.width - 3) * scale, HEIGHTS.toeKick * scale, "B");
  }

  if (p.moduleCode) {
    page.text(p.moduleCode, x + w / 2, pyTop(0) + 4, { size: 7, color: GREY, align: "center" });
  }
}

function leafFill(kind: string): { r: number; g: number; b: number } {
  switch (kind) {
    case "drawer": return { r: 0.94, g: 0.92, b: 0.87 };
    case "falseFront": return { r: 0.91, g: 0.89, b: 0.83 };
    case "blind": return { r: 0.85, g: 0.83, b: 0.78 };
    case "open": return { r: 1, g: 1, b: 1 };
    case "applianceOpening": return { r: 0.81, g: 0.81, b: 0.81 };
    default: return { r: 0.96, g: 0.95, b: 0.91 };
  }
}

/**
 * 家电在 PDF 立面图上的标签。
 *
 * PDF 写入器只支持 WinAnsi，所以这里一律用英文缩写；认不出的种类退到
 * `APPLIANCE` 而不是留空——图上一个没有字的方块，客户看不懂。
 */
function applianceLabel(p: Placement): string {
  const map: Partial<Record<NonNullable<Placement["applianceKind"]>, string>> = {
    refrigerator: "FRIDGE", range: "RANGE", cooktop: "COOKTOP",
    wallOven: "OVEN", rangeHood: "HOOD", microwave: "MICRO", dishwasher: "DW",
  };
  return (p.applianceKind ? map[p.applianceKind] : undefined) ?? "APPLIANCE";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** 总价的展示辅助（供调用方在附件名等处使用）。 */
export function quoteFilename(quote: Quote, total: Money = quote.total): string {
  void total;
  return `quote-${quote.id}.pdf`;
}
