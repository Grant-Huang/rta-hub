/**
 * 最小 CSV 解析 —— 支持引号包裹、转义双引号、字段内换行与逗号。
 *
 * 不引三方库：价目表导入是规格数据进入系统的入口，这段代码的行为必须完全可控可测。
 */

export type CsvRow = Record<string, string>;

export class CsvParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(`第 ${line} 行：${message}`);
    this.name = "CsvParseError";
  }
}

/** 解析成字段数组的二维表。自动识别 `,` 与 `\t` 分隔。 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, ""); // 去 BOM
  const delim = delimiter ?? (src.slice(0, src.indexOf("\n") + 1).includes("\t") ? "\t" : ",");

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    // 引号**只在字段开头**才是引号（RFC 4180）。
    //
    // 之前这里是"见到引号就进引号模式"，于是商家写「1/2" 夹板箱体」这种
    // 完全正常的一句话，整张表就报「引号未闭合」并且一行都导不进来。
    // 英寸符号在橱柜价目表里到处都是——这不是边角情况。
    if (ch === '"' && field.length === 0) { inQuotes = true; continue; }
    if (ch === delim) { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = []; field = ""; line++;
      continue;
    }
    field += ch;
  }
  if (inQuotes) throw new CsvParseError("引号未闭合", line);
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** 解析为对象数组，首行为表头。表头做 trim + 小写归一化。 */
export function parseCsvRows(text: string, delimiter?: string): CsvRow[] {
  const table = parseCsv(text, delimiter);
  const header = table[0];
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return table.slice(1).map((cells) => {
    const row: CsvRow = {};
    keys.forEach((k, i) => { row[k] = (cells[i] ?? "").trim(); });
    return row;
  });
}

/** 橱柜尺寸里合法的分母（1/2、1/4、1/8、1/16…）。 */
const FRACTION_DENOMINATORS = new Set([2, 4, 8, 16, 32]);

/**
 * `/` 在价目表里身兼两职：分隔符（`30/36/42`）与分数线（`34-1/2`）。
 *
 * 消歧规则：`A/B` 只有在 **A < B 且 B 是 2/4/8/16/32** 时才当分数——
 * 橱柜尺寸的分数一律是这几个分母的真分数。`30/36` 不满足，按分隔符处理。
 */
function isFraction(numerator: number, denominator: number): boolean {
  return numerator < denominator && FRACTION_DENOMINATORS.has(denominator);
}

/** 把 `12|15|18`、`12,15,18`、`30/36/42`、`34-1/2` 这类单元格解析成数字数组。 */
export function parseNumberList(value: string): number[] {
  const out: number[] = [];
  // 先按明确的分隔符切，再在每段里处理 `/`
  for (const chunk of value.split(/[|;,]/)) {
    const token = chunk.trim();
    if (!token) continue;

    // 34-1/2 这类带分数的混合数
    const mixed = /^(\d+)\s*-\s*(\d+)\/(\d+)$/.exec(token);
    if (mixed) {
      const [w, n, d] = [Number(mixed[1]), Number(mixed[2]), Number(mixed[3])];
      if (isFraction(n, d)) { out.push(w + n / d); continue; }
    }

    // 纯分数 1/2
    const frac = /^(\d+)\/(\d+)$/.exec(token);
    if (frac) {
      const [n, d] = [Number(frac[1]), Number(frac[2])];
      if (isFraction(n, d)) { out.push(n / d); continue; }
    }

    // 其余情况下 `/` 视作分隔符：30/36/42
    for (const part of token.split("/")) {
      const s = part.trim().replace(/["″']/g, "");
      if (!s) continue;
      const n = Number(s);
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}
