/**
 * 批量目录/价目表上传适配器（厂商员工会话 Type2 A）。
 *
 * Excel(.xlsx) 与 JSON 都转成现有 `ImportSources`（每张表一段 CSV 文本）——
 * 下游 `ingestTemplates`/`assertPublishable`/发布/追问循环**一行不改**，
 * 上传只是给那条早就写好的管线换了个前门。
 *
 * PDF 走 LLM 文本抽取（见 `parsePdfCatalog`），置信度明显更低——表格版式
 * 五花八门，文本抽取常把列错位。它照样要过 `unresolved` 复核队列，只是预期
 * 复核量会大得多，不是"抽错了直接进规格库"。Word/Txt 不支持：没有稳定的
 * 表格结构可依赖，宁可让商家转存成 Excel 或 JSON。
 */
import * as XLSX from "xlsx";
import type { ImportSources } from "./import.js";

const SHEET_KEYS = ["modules", "priceGroups", "doorStyles", "priceMatrix", "boxMaterials"] as const;
const REQUIRED = ["modules", "priceGroups", "doorStyles", "priceMatrix"] as const satisfies readonly (typeof SHEET_KEYS[number])[];

export interface UploadParseResult {
  sources: ImportSources;
  /** 工作簿/JSON 里有、但认不出对应哪张表的名字——不是错误，只是提示。 */
  unmatchedSheets: string[];
  /** 必填表（modules/priceGroups/doorStyles/priceMatrix）里缺的。 */
  missingRequiredSheets: string[];
}

function normalizeSheetName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, "");
}

function matchSheetKey(name: string): typeof SHEET_KEYS[number] | undefined {
  const norm = normalizeSheetName(name);
  return SHEET_KEYS.find((k) => normalizeSheetName(k) === norm);
}

/** 把一行对象数组转成 CSV 文本——JSON 上传、PDF 抽取结果都走这条路复用同一套 CSV 解析。 */
export function rowsToCsv(rows: readonly Record<string, string | number | undefined>[]): string {
  if (rows.length === 0) return "";
  const header: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) { seen.add(k); header.push(k); }
    }
  }
  const escape = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(header.map((h) => escape(String(r[h] ?? ""))).join(","));
  }
  return lines.join("\n");
}

function assembleSources(found: Partial<Record<typeof SHEET_KEYS[number], string>>): UploadParseResult {
  const missingRequiredSheets = REQUIRED.filter((k) => !found[k]);
  return {
    sources: {
      modules: found.modules ?? "",
      priceGroups: found.priceGroups ?? "",
      doorStyles: found.doorStyles ?? "",
      priceMatrix: found.priceMatrix ?? "",
      ...(found.boxMaterials ? { boxMaterials: found.boxMaterials } : {}),
    },
    unmatchedSheets: [],
    missingRequiredSheets,
  };
}

/**
 * 解一个多标签页 Excel。标签页名对应 modules/priceGroups/doorStyles/priceMatrix/
 * boxMaterials（大小写、空格、下划线不敏感），跟 `blankTemplates()` 给的模板一致。
 */
export function parseXlsxCatalog(buffer: Buffer): UploadParseResult {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const found: Partial<Record<typeof SHEET_KEYS[number], string>> = {};
  const unmatchedSheets: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const key = matchSheetKey(sheetName);
    if (!key) { unmatchedSheets.push(sheetName); continue; }
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    found[key] = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
  }
  const result = assembleSources(found);
  return { ...result, unmatchedSheets };
}

export interface JsonCatalogPayload {
  modules?: Record<string, string | number>[];
  priceGroups?: Record<string, string | number>[];
  doorStyles?: Record<string, string | number>[];
  priceMatrix?: Record<string, string | number>[];
  boxMaterials?: Record<string, string | number>[];
}

/** 解一份 JSON 目录（每张表是一个对象数组，字段名与 CSV 表头一致）。 */
export function parseJsonCatalog(payload: JsonCatalogPayload): UploadParseResult {
  const found: Partial<Record<typeof SHEET_KEYS[number], string>> = {};
  for (const key of SHEET_KEYS) {
    const rows = payload[key];
    if (rows?.length) found[key] = rowsToCsv(rows);
  }
  return assembleSources(found);
}
