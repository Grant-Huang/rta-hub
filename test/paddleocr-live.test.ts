/**
 * 真实 PaddleOCR 服务 —— 用 test/sources 里的户型图跑一遍。
 *
 * 依赖本机跑着 `scripts/paddleocr_server.py`（默认 :8891，`OCR_BASE_URL_TEST`
 * 可覆盖）。没起服务就跳过，不把 CI 卡死——和 ollama-vision-live.test.ts 同一个
 * 跳过策略。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPaddleOcrExtractor, formatOcrGroundingBlock } from "../src/floorplan/paddleocr.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(here, "sources", "Floor Plan - 1.png");

/** 只要连得上、拿到 HTTP 响应就算活着——空 image 探针本身会走 500（解码失败），不代表服务没起来。 */
async function ocrReachable(baseURL: string): Promise<boolean> {
  try {
    await fetch(`${baseURL.replace(/\/$/, "")}/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: "" }),
      signal: AbortSignal.timeout(3000),
    });
    return true;
  } catch {
    return false;
  }
}

test("PaddleOCR + 样例户型图（15927 Pacific Place）：读到厨房尺寸 11'5\"X 10'5\"", async (t) => {
  if (!existsSync(SAMPLE)) {
    t.skip("test/sources/Floor Plan - 1.png missing");
    return;
  }
  const baseURL = process.env.OCR_BASE_URL_TEST?.trim() || "http://localhost:8891";
  if (!(await ocrReachable(baseURL))) {
    t.skip(`PaddleOCR server not reachable at ${baseURL} — run scripts/paddleocr_server.py first`);
    return;
  }

  const png = readFileSync(SAMPLE);
  const image = `data:image/png;base64,${png.toString("base64")}`;
  const extractor = createPaddleOcrExtractor(baseURL);

  const t0 = Date.now();
  const tokens = await extractor.extract({ image, mimeType: "image/png" });
  const elapsedMs = Date.now() - t0;
  console.log(`[paddleocr-live] ${tokens?.length ?? 0} tokens in ${elapsedMs}ms`);

  assert.ok(tokens && tokens.length > 20, `expected many text tokens, got ${tokens?.length}`);
  const kitchenDim = tokens!.find((t) => /11'5"X\s*10'5"/i.test(t.text));
  assert.ok(kitchenDim, `expected kitchen dimension text among tokens: ${JSON.stringify(tokens!.map((t) => t.text))}`);
  assert.ok(kitchenDim!.score > 0.9, `expected high-confidence read, got ${kitchenDim!.score}`);

  const block = formatOcrGroundingBlock(tokens!);
  assert.ok(block && block.includes("KITCHEN"));
});
