/**
 * 最小 PDF 写入器 —— 零依赖。
 *
 * 只实现报价单需要的部分：多页、文本、矢量图形、base-14 标准字体。
 * 不做字体嵌入、不做图片——因为**不需要**：视图是我们自己算出来的几何，
 * 直接写成 PDF 矢量指令即可，不必先出 SVG 再转换（那才是引第三方库的理由）。
 *
 * ## 已知限制：非 Latin-1 字符
 *
 * base-14 字体用 WinAnsiEncoding，覆盖不了中文。报价单的收件方是加拿大橱柜公司，
 * 正文本就该是英文，所以这不影响主用途；但**公司名/客户名里的中文会被替换**，
 * 且会在 `warnings` 里报出来，不静默丢字。要支持中文得嵌入 CJK 字体（体积以 MB 计），
 * 属于后续决策，不在此处偷偷降级。
 */

const PT_PER_INCH = 72;

export interface PageSize {
  width: number;
  height: number;
}

/** US Letter —— 北美报价单的默认纸张。 */
export const LETTER: PageSize = { width: 8.5 * PT_PER_INCH, height: 11 * PT_PER_INCH };
export const LETTER_LANDSCAPE: PageSize = { width: 11 * PT_PER_INCH, height: 8.5 * PT_PER_INCH };

export type StandardFont = "Helvetica" | "Helvetica-Bold" | "Courier";

const FONT_KEYS: Record<StandardFont, string> = {
  "Helvetica": "F1",
  "Helvetica-Bold": "F2",
  "Courier": "F3",
};

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export const BLACK: RGB = { r: 0, g: 0, b: 0 };
export const GREY: RGB = { r: 0.42, g: 0.42, b: 0.42 };
export const LIGHT: RGB = { r: 0.88, g: 0.88, b: 0.88 };

/**
 * 一页的内容流构造器。
 *
 * 坐标系：PDF 原点在**左下角**，y 向上。为了与我们其他渲染代码一致
 * （SVG 原点在左上、y 向下），这里的 API 统一用**左上原点**，内部再翻转。
 */
export class PdfPage {
  private readonly ops: string[] = [];
  readonly warnings: string[] = [];

  constructor(readonly size: PageSize) {}

  private y(top: number): number {
    return this.size.height - top;
  }

  setLineWidth(w: number): this {
    this.ops.push(`${num(w)} w`);
    return this;
  }

  setStroke(c: RGB): this {
    this.ops.push(`${num(c.r)} ${num(c.g)} ${num(c.b)} RG`);
    return this;
  }

  setFill(c: RGB): this {
    this.ops.push(`${num(c.r)} ${num(c.g)} ${num(c.b)} rg`);
    return this;
  }

  rect(x: number, top: number, w: number, h: number, mode: "S" | "f" | "B" = "S"): this {
    this.ops.push(`${num(x)} ${num(this.y(top + h))} ${num(w)} ${num(h)} re ${mode}`);
    return this;
  }

  line(x1: number, top1: number, x2: number, top2: number): this {
    this.ops.push(`${num(x1)} ${num(this.y(top1))} m ${num(x2)} ${num(this.y(top2))} l S`);
    return this;
  }

  /** 虚线；传空数组恢复实线。 */
  dash(pattern: number[]): this {
    this.ops.push(pattern.length ? `[${pattern.map(num).join(" ")}] 0 d` : "[] 0 d");
    return this;
  }

  text(str: string, x: number, top: number, opts: {
    font?: StandardFont; size?: number; color?: RGB;
    align?: "left" | "right" | "center";
  } = {}): this {
    const font = opts.font ?? "Helvetica";
    const size = opts.size ?? 10;
    const { encoded, replaced } = encodeWinAnsi(str);
    if (replaced.length > 0) {
      this.warnings.push(
        `PDF 不支持这些字符（base-14 字体只覆盖 Latin-1），已替换为 "?"：${replaced.join("")}`,
      );
    }

    let drawX = x;
    if (opts.align === "right" || opts.align === "center") {
      const w = measure(str, size, font);
      drawX = opts.align === "right" ? x - w : x - w / 2;
    }

    if (opts.color) this.setFill(opts.color);
    this.ops.push(
      "BT",
      `/${FONT_KEYS[font]} ${num(size)} Tf`,
      `${num(drawX)} ${num(this.y(top + size * 0.8))} Td`,
      `(${encoded}) Tj`,
      "ET",
    );
    return this;
  }

  /** 文本宽度（点）。用于右对齐与换行。 */
  static width(str: string, size: number, font: StandardFont = "Helvetica"): number {
    return measure(str, size, font);
  }

  build(): string {
    return this.ops.join("\n");
  }
}

/**
 * 字宽估算。
 *
 * base-14 字体的真实字宽表有 200+ 条目；报价单只需要右对齐金额与表头，
 * 用分段平均宽度足够（误差 < 5%，不会造成错位）。Courier 是等宽字体，精确。
 */
function measure(str: string, size: number, font: StandardFont): number {
  if (font === "Courier") return str.length * size * 0.6;
  let units = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === " ") units += 278;
    else if (/[.,:;'`|!]/.test(ch)) units += 278;
    else if (/[ijltI]/.test(ch)) units += 278;
    else if (/[fr]/.test(ch)) units += 333;
    else if (/[0-9]/.test(ch)) units += 556;
    else if (/[A-Z]/.test(ch)) units += 700;
    else if (/[mwMW]/.test(ch)) units += 833;
    else if (code > 127) units += 700;
    else units += 556;
  }
  const bold = font === "Helvetica-Bold" ? 1.06 : 1;
  return (units / 1000) * size * bold;
}

/**
 * WinAnsi 在 0x80–0x9F 区间放了一批排版标点，它们的 Unicode 码位在别处，
 * 需要显式映射——否则破折号、弯引号这些常见字符会被误判为"不支持"。
 */
const WINANSI_HIGH: Record<string, number> = {
  "\u20AC": 0x80, "\u201A": 0x82, "\u0192": 0x83, "\u201E": 0x84,
  "\u2026": 0x85, "\u2020": 0x86, "\u2021": 0x87, "\u02C6": 0x88,
  "\u2030": 0x89, "\u0160": 0x8A, "\u2039": 0x8B, "\u0152": 0x8C,
  "\u017D": 0x8E, "\u2018": 0x91, "\u2019": 0x92, "\u201C": 0x93,
  "\u201D": 0x94, "\u2022": 0x95, "\u2013": 0x96, "\u2014": 0x97,
  "\u02DC": 0x98, "\u2122": 0x99, "\u0161": 0x9A, "\u203A": 0x9B,
  "\u0153": 0x9C, "\u017E": 0x9E, "\u0178": 0x9F,
};

/**
 * 这段文本能否原样出现在 PDF 上。
 *
 * 调用方据此**换一个能画的说法**，而不是画个 `?` 再报警告——
 * 报价单发给加拿大橱柜公司，纸面上出现 `??` 比换成英文说法更糟。
 */
export function isWinAnsiSafe(str: string): boolean {
  return encodeWinAnsi(str).replaced.length === 0;
}

/** 转成 WinAnsi 字节并转义 PDF 字符串里的特殊字符。 */
function encodeWinAnsi(str: string): { encoded: string; replaced: string[] } {
  const replaced: string[] = [];
  let out = "";
  for (const ch of str) {
    const code = ch.codePointAt(0)!;
    if (ch === "(" || ch === ")" || ch === "\\") {
      out += `\\${ch}`;
    } else if (code >= 32 && code <= 126) {
      out += ch;
    } else if (WINANSI_HIGH[ch] !== undefined) {
      out += `\\${WINANSI_HIGH[ch]!.toString(8).padStart(3, "0")}`;
    } else if (code >= 160 && code <= 255) {
      out += `\\${code.toString(8).padStart(3, "0")}`;
    } else {
      // 不静默丢字：替换成 ? 并记录，让调用方知道
      out += "?";
      replaced.push(ch);
    }
  }
  return { encoded: out, replaced };
}

function num(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

// ── 文档组装 ──────────────────────────────────────────────────────────────

export interface PdfDocumentMeta {
  title?: string;
  author?: string;
  subject?: string;
  createdAt?: Date;
}

/**
 * 把若干页组装成完整的 PDF 文件（PDF 1.4）。
 *
 * 返回 `Buffer`，因为 PDF 是二进制格式——xref 表里的偏移量是**字节偏移**，
 * 用字符串长度算会在有多字节字符时错位。
 */
export function buildPdf(pages: readonly PdfPage[], meta: PdfDocumentMeta = {}): Buffer {
  if (pages.length === 0) throw new Error("PDF 至少需要一页");

  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length; // 对象号从 1 开始
  };

  // 先占位：Catalog=1、Pages=2
  objects.push("", "");

  const fontIds: Record<string, number> = {};
  for (const [name, key] of Object.entries(FONT_KEYS)) {
    fontIds[key] = add(
      `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`,
    );
  }
  const fontDict = Object.entries(fontIds)
    .map(([key, id]) => `/${key} ${id} 0 R`).join(" ");

  const pageIds: number[] = [];
  for (const page of pages) {
    const content = page.build();
    const streamId = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    const pageId = add(
      `<< /Type /Page /Parent 2 0 R ` +
      `/MediaBox [0 0 ${num(page.size.width)} ${num(page.size.height)}] ` +
      `/Resources << /Font << ${fontDict} >> >> ` +
      `/Contents ${streamId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  if (meta.title || meta.author || meta.subject) {
    const parts = [
      meta.title ? `/Title (${encodeWinAnsi(meta.title).encoded})` : "",
      meta.author ? `/Author (${encodeWinAnsi(meta.author).encoded})` : "",
      meta.subject ? `/Subject (${encodeWinAnsi(meta.subject).encoded})` : "",
      `/Producer (RTA-Hub)`,
      `/CreationDate (${pdfDate(meta.createdAt ?? new Date())})`,
    ].filter(Boolean);
    add(`<< ${parts.join(" ")} >>`);
  }

  // 组装文件体，同时记录每个对象的字节偏移
  const chunks: Buffer[] = [];
  let offset = 0;
  const push = (s: string): void => {
    const b = Buffer.from(s, "latin1");
    chunks.push(b);
    offset += b.length;
  };

  push("%PDF-1.4\n");
  // 二进制标记，告诉工具这是二进制文件
  chunks.push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  offset += 6;

  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    push(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefStart = offset;
  const infoId = meta.title || meta.author || meta.subject ? objects.length : undefined;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R` +
    (infoId ? ` /Info ${infoId} 0 R` : "") +
    ` >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );

  return Buffer.concat(chunks);
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
