/**
 * 批量目录/价目表上传适配器（厂商员工会话 Type2 A）——Excel/JSON 转成的
 * `ImportSources` 必须跟手填 CSV 完全等价：下游 `ingestTemplates` 一行不改。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseJsonCatalog, parseXlsxCatalog, rowsToCsv } from "../src/spec/catalog-upload.js";
import { ingestTemplates } from "../src/spec/onboarding.js";
import { startSession } from "../src/spec/onboarding.js";

const AT = "2026-06-01T00:00:00.000Z";

test("rowsToCsv：含逗号/引号的字段正确加引号转义", () => {
  const csv = rowsToCsv([{ code: "B30", note: "1/2\" plywood, upgraded" }]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "code,note");
  assert.equal(lines[1], 'B30,"1/2"" plywood, upgraded"');
});

test("JSON 上传：转成的 ImportSources 能被 ingestTemplates 正常消化", () => {
  const parsed = parseJsonCatalog({
    priceGroups: [{ code: "STD", displayName: "Standard" }],
    doorStyles: [{ name: "Plain White", priceGroup: "STD" }],
    modules: [
      { code: "B30", type: "base", widths: "30", heights: "34-1/2", depths: "24" },
      { code: "W3030", type: "wall", widths: "30", heights: "30", depths: "12" },
    ],
    priceMatrix: [
      { moduleCode: "B30", priceGroup: "STD", listPrice: "200.00" },
      { moduleCode: "W3030", priceGroup: "STD", listPrice: "150.00" },
    ],
  });
  assert.deepEqual(parsed.missingRequiredSheets, []);

  const { session } = startSession("co_json", AT);
  const r = ingestTemplates(session, parsed.sources, AT);
  assert.equal(r.bundle.modules.length, 2);
  assert.equal(r.importResult.stats.priceMatrixImported, 2);
});

test("JSON 上传缺必填表时如实报告缺了哪些", () => {
  const parsed = parseJsonCatalog({ modules: [{ code: "B30", type: "base", widths: "30", heights: "30", depths: "24" }] });
  assert.deepEqual(parsed.missingRequiredSheets, ["priceGroups", "doorStyles", "priceMatrix"]);
});

test("Excel 上传：多标签页按名字（大小写/空格不敏感）映射到对应表", () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["code", "displayName"], ["STD", "Standard"],
  ]), "Price Groups"); // 故意用不同大小写/带空格
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["name", "priceGroup"], ["Plain White", "STD"],
  ]), "doorstyles");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["code", "type", "widths", "heights", "depths"], ["B30", "base", "30", "34-1/2", "24"],
  ]), "MODULES");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["moduleCode", "priceGroup", "listPrice"], ["B30", "STD", "200.00"],
  ]), "price_matrix");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["note"], ["random extra tab, not a recognized sheet"],
  ]), "Notes");

  const buffer = XLSX.write(wb, { type: "buffer" }) as Buffer;
  const parsed = parseXlsxCatalog(buffer);
  assert.deepEqual(parsed.missingRequiredSheets, []);
  assert.deepEqual(parsed.unmatchedSheets, ["Notes"]);
  assert.match(parsed.sources.modules, /B30/);
  assert.match(parsed.sources.priceMatrix, /200\.00|200/);

  const { session } = startSession("co_xlsx", AT);
  const r = ingestTemplates(session, parsed.sources, AT);
  assert.equal(r.bundle.modules.length, 1);
  assert.equal(r.bundle.modules[0]?.code, "B30");
});
