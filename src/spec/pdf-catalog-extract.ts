/**
 * PDF 价目表抽取——批量目录上传的兜底格式，置信度明显低于 Excel/JSON。
 *
 * PDF 里的表格版式五花八门（多栏、合并单元格、页眉页脚穿插），纯文本抽取
 * 常常把列错位、把页眉当成数据行。这里刻意**不**冒充高置信度：抽出来的行照样
 * 要过 `spec/onboarding.ts` 的 unresolved 复核队列，只是预期复核量会大得多。
 *
 * 没配 LLM 时直接拒绝——没有结构化表格坐标可依赖的纯文本，没有 LLM 兜底就是
 * 一堆无法可靠拆列的字符串，硬解析出来的东西比人工重新录入更危险（零静默失败）。
 *
 * 只做一轮抽取，不分页分批：真正成百上千 SKU 的价目表，应该建议商家转成
 * Excel/JSON（那条路完全无损）——这里只覆盖"手头只有一份 PDF"的兜底场景。
 */
import { PDFParse } from "pdf-parse";
import type { CompletionClient } from "../agents/types.js";
import { parseJsonCatalog, type JsonCatalogPayload, type UploadParseResult } from "./catalog-upload.js";

export class PdfCatalogExtractError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "PdfCatalogExtractError";
  }
}

const SCHEMA_HINT = '{"modules"?: object[], "priceGroups"?: object[], "doorStyles"?: object[], ' +
  '"priceMatrix"?: object[], "boxMaterials"?: object[]}';

const SYSTEM = [
  "You extract a cabinet catalog/price list from raw PDF text into four tables.",
  "Only extract rows that are clearly present in the text — never invent a SKU, price, or option.",
  "Tables and required columns per row:",
  "- modules: code, type (base/wall/tall/corner/sinkBase/filler/panel/toeKick/crown), widths, heights, depths " +
    "(each a '/'-separated list of numbers, inches)",
  "- priceGroups: code, displayName",
  "- doorStyles: name, priceGroup (must match a priceGroups.code)",
  "- priceMatrix: moduleCode (must match a modules.code), priceGroup (must match a priceGroups.code), listPrice " +
    "(number, no currency symbol)",
  "If the text has no reliable table structure for a given sheet, omit that key entirely rather than guessing rows.",
].join("\n");

/** 抽 PDF 全文——单轮、不分页。抽取失败（加密/扫描版无文字层）直接报错，不静默返回空文本。 */
async function extractText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text ?? "";
  } finally {
    await parser.destroy();
  }
}

export async function parsePdfCatalog(
  buffer: Buffer,
  client: CompletionClient | undefined,
): Promise<UploadParseResult> {
  if (!client?.completeJson) {
    throw new PdfCatalogExtractError(
      "PDF import requires an LLM to be configured — there is no reliable column structure to parse otherwise. " +
        "Please export the catalog as Excel (.xlsx) or JSON instead.",
      "LLM_NOT_CONFIGURED",
    );
  }

  let text: string;
  try {
    text = await extractText(buffer);
  } catch (e) {
    throw new PdfCatalogExtractError(
      `Could not extract text from this PDF (${e instanceof Error ? e.message : String(e)}). ` +
        "It may be a scanned image without a text layer — please export as Excel or JSON instead.",
      "TEXT_EXTRACT_FAILED",
    );
  }
  if (!text.trim()) {
    throw new PdfCatalogExtractError(
      "This PDF has no extractable text (likely a scanned image) — please export as Excel or JSON instead.",
      "EMPTY_TEXT",
    );
  }

  const raw = await client.completeJson<JsonCatalogPayload>({
    system: SYSTEM,
    messages: [{ role: "user", content: text.slice(0, 60_000) }],
    schemaHint: SCHEMA_HINT,
    temperature: 0,
    callSite: "specTemplateParse",
  });
  if (!raw || Object.keys(raw).length === 0) {
    throw new PdfCatalogExtractError(
      "Could not extract any table structure from this PDF — please export as Excel or JSON instead.",
      "NO_STRUCTURE_FOUND",
    );
  }
  return parseJsonCatalog(raw);
}
