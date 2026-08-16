/**
 * PaddleOCR 读数外援 —— 单测覆盖：
 *   1. formatOcrGroundingBlock 的排序/截断/阈值（paddleocr.ts 的纯函数部分）；
 *   2. 三条提示词在传入 ocrBlock 时正确附上外援段，不传时保持原样（向后兼容）；
 *   3. createOllamaVisionExtractor 的编排：OCR 每张图只调一次、两步都能看到同一段
 *      文本、OCR 失败时优雅退化（不中断抽取，也不重复报错）。
 * 3 用 stub 实现 OcrExtractor 接口 + 临时替换 globalThis.fetch（测试后还原），
 * 不依赖真实 Ollama / PaddleOCR 服务——和 vision-twostep.test.ts 的纯函数打法一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOllamaVisionExtractor,
  floorPlanVisionFeaturesPrompt,
  floorPlanVisionPrompt,
  floorPlanVisionWallsPrompt,
} from "../src/floorplan/ollama-vision.js";
import {
  createPaddleOcrExtractorFromEnv,
  createPaddleOcrExtractorFromTestEnv,
  formatOcrGroundingBlock,
  type OcrExtractor,
  type OcrToken,
} from "../src/floorplan/paddleocr.js";

test("formatOcrGroundingBlock：按阅读顺序排、过滤低分、截断上限", () => {
  const tokens: OcrToken[] = [
    { text: "144\"", score: 0.98, xPct: 40, yPct: 10, wPct: 5, hPct: 3 },
    { text: "noise", score: 0.2, xPct: 5, yPct: 5, wPct: 5, hPct: 3 },
    { text: "36\"", score: 0.9, xPct: 10, yPct: 10, wPct: 5, hPct: 3 },
    { text: "KITCHEN", score: 0.99, xPct: 20, yPct: 50, wPct: 5, hPct: 3 },
  ];
  const block = formatOcrGroundingBlock(tokens);
  assert.ok(block);
  assert.doesNotMatch(block!, /noise/, "低于 minScore 的噪声应被过滤");
  const lines = block!.split("\n");
  assert.equal(lines.length, 3);
  // 同一行（y 差 <3%）按 x 排序：36" 在 144" 之前
  assert.ok(lines[0]?.startsWith('"36"'), `expected 36" first, got ${lines[0]}`);
  assert.ok(lines[1]?.startsWith('"144"'));
  assert.ok(lines[2]?.startsWith('"KITCHEN"'));

  assert.equal(formatOcrGroundingBlock([]), undefined);
  assert.equal(formatOcrGroundingBlock([{ text: "x", score: 0.1, xPct: 0, yPct: 0, wPct: 1, hPct: 1 }]), undefined);

  const many = Array.from({ length: 100 }, (_, i) => (
    { text: `t${i}`, score: 0.9, xPct: 0, yPct: i, wPct: 1, hPct: 1 }
  ));
  assert.equal(formatOcrGroundingBlock(many, { maxTokens: 10 })!.split("\n").length, 10);
});

test("三条提示词：传 ocrBlock 才附外援段，不传保持原样", () => {
  const noOcr = floorPlanVisionWallsPrompt();
  assert.doesNotMatch(noOcr, /OCR pass/);

  const withOcr = floorPlanVisionWallsPrompt(undefined, '"144" at (40%,10%)');
  assert.match(withOcr, /OCR pass \(dedicated text recognizer/);
  assert.match(withOcr, /"144" at \(40%,10%\)/);
  assert.match(withOcr, /does NOT know which wall/);

  assert.doesNotMatch(floorPlanVisionPrompt(), /OCR pass/);
  assert.match(floorPlanVisionPrompt(undefined, '"36"'), /OCR pass/);

  const feat = floorPlanVisionFeaturesPrompt({ wallRuns: [{ slot: "North", length: 144 }] }, undefined, '"door"');
  assert.match(feat, /OCR pass/);
  assert.match(feat, /"door"/);
});

/** 拿真实两步夹具当基底，只在意 OCR 编排是否正确，不在意几何是否合理。 */
const WALLS_RESPONSE = { wallRuns: [{ label: "North", slot: "North", length: 144, lengthConfidence: 0.9 }] };
const FEATURES_RESPONSE = { wallRuns: [{ slot: "North", features: [{ kind: "window", offset: 48, confidence: 0.9 }] }] };

function stubOllamaFetch(capturePrompts: string[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { prompt: string };
    capturePrompts.push(body.prompt);
    const isFeatures = /Locked wall runs/.test(body.prompt);
    const response = isFeatures ? FEATURES_RESPONSE : WALLS_RESPONSE;
    return new Response(JSON.stringify({ response: JSON.stringify(response), done: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

test("createOllamaVisionExtractor：OCR 每张图只调一次，两步提示词都带同一段外援文本", async () => {
  const originalFetch = globalThis.fetch;
  const prompts: string[] = [];
  let ocrCalls = 0;
  const ocr: OcrExtractor = {
    async extract() {
      ocrCalls++;
      return [{ text: "137\"", score: 0.97, xPct: 30, yPct: 12, wPct: 4, hPct: 2 }];
    },
  };
  try {
    globalThis.fetch = stubOllamaFetch(prompts);
    const extractor = createOllamaVisionExtractor("http://stub", { ocr });
    const raw = await extractor.extract({ image: "data:image/png;base64,aa", mimeType: "image/png" });
    assert.ok(raw?.wallRuns?.length);
    assert.equal(ocrCalls, 1, "两步共用同一次 OCR 结果，不应各调一次");
    assert.equal(prompts.length, 2, "两步各一次 Ollama 调用");
    for (const p of prompts) assert.match(p, /"137"" at \(30%,12%\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createOllamaVisionExtractor：OCR 失败时优雅退化，不中断抽取、不抛出", async () => {
  const originalFetch = globalThis.fetch;
  const prompts: string[] = [];
  let ocrErr: unknown;
  const ocr: OcrExtractor = {
    async extract() {
      throw new Error("paddleocr unreachable");
    },
  };
  try {
    globalThis.fetch = stubOllamaFetch(prompts);
    const extractor = createOllamaVisionExtractor("http://stub", {
      ocr,
      onOcrError: (err) => { ocrErr = err; },
    });
    const raw = await extractor.extract({ image: "data:image/png;base64,aa", mimeType: "image/png" });
    assert.ok(raw?.wallRuns?.length, "OCR 失败不该让整个抽取失败");
    assert.ok(ocrErr instanceof Error && /unreachable/.test(ocrErr.message));
    for (const p of prompts) assert.doesNotMatch(p, /OCR pass/, "OCR 没数据时不该附外援段");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createPaddleOcrExtractorFromEnv / FromTestEnv：没配 OCR_BASE_URL(_TEST) 就不装配", () => {
  assert.equal(createPaddleOcrExtractorFromEnv({}), undefined);
  assert.ok(createPaddleOcrExtractorFromEnv({ OCR_BASE_URL: "http://localhost:8891" }));
  assert.equal(createPaddleOcrExtractorFromTestEnv({}), undefined);
  assert.ok(createPaddleOcrExtractorFromTestEnv({ OCR_BASE_URL_TEST: "http://localhost:8891" }));
});
