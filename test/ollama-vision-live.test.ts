/**
 * 真实 Ollama 视觉抽取 —— 用 test/sources 里的户型图跑一遍。
 *
 * 依赖本机 `OPENAI_BASE_URL_VISION`（默认 http://localhost:11434）与
 * `LLM_MODEL_VISION`（默认 qwen2.5vl）。Ollama 没开或没模型时跳过，
 * 不把 CI 卡死。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFloorPlanWithOutcome, normalizeExtraction,
} from "../src/floorplan/parse.js";
import {
  createOllamaVisionExtractor, createVisionExtractorFromEnv,
} from "../src/floorplan/ollama-vision.js";
import { createAppContext } from "../src/app/context.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(here, "sources", "Floor Plan - 1.png");

async function ollamaReachable(baseURL: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseURL.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

test("createVisionExtractorFromEnv：有 OPENAI_BASE_URL_VISION 才装配", () => {
  assert.equal(createVisionExtractorFromEnv({}), undefined);
  assert.ok(createVisionExtractorFromEnv({ OPENAI_BASE_URL_VISION: "http://localhost:11434" }));
});

test("createAppContext 默认从环境装配 vision", async () => {
  const prev = process.env.OPENAI_BASE_URL_VISION;
  process.env.OPENAI_BASE_URL_VISION = "http://127.0.0.1:9"; // 不真的调用
  try {
    const ctx = await createAppContext({ ephemeral: true, seedIfEmpty: false, llm: undefined });
    assert.ok(ctx.vision, "应装配 VisionExtractor");
    const disabled = await createAppContext({
      ephemeral: true, seedIfEmpty: false, llm: undefined, vision: undefined,
    });
    assert.equal(disabled.vision, undefined, "显式 vision:undefined 应关掉");
  } finally {
    if (prev === undefined) delete process.env.OPENAI_BASE_URL_VISION;
    else process.env.OPENAI_BASE_URL_VISION = prev;
  }
});

test("Ollama + 样例户型图：能抽出至少一段墙", async (t) => {
  if (!existsSync(SAMPLE)) {
    t.skip("test/sources/Floor Plan - 1.png missing");
    return;
  }
  const baseURL = process.env.OPENAI_BASE_URL_VISION?.trim() || "http://localhost:11434";
  if (!(await ollamaReachable(baseURL))) {
    t.skip(`Ollama not reachable at ${baseURL}`);
    return;
  }

  const png = readFileSync(SAMPLE);
  const image = `data:image/png;base64,${png.toString("base64")}`;
  const extractor = createOllamaVisionExtractor(baseURL, {
    model: process.env.LLM_MODEL_VISION?.trim() || "qwen2.5vl",
    timeoutMs: 180_000,
  });

  const raw = await extractor.extract({ image, mimeType: "image/png" });
  assert.ok(raw, "extractor returned undefined — empty model response?");
  assert.ok((raw.wallRuns?.length ?? 0) > 0, `expected wall runs, got ${JSON.stringify(raw)}`);
  console.log("[vision-live] raw wallRuns:", JSON.stringify(raw.wallRuns, null, 2));
  console.log("[vision-live] notes:", raw.notes);
  console.log("[vision-live] overallConfidence:", raw.overallConfidence);

  const { plan, extraction } = await createFloorPlanWithOutcome(
    {
      conversationId: "c_vision_live",
      file: { name: "Floor Plan - 1.png", mimeType: "image/png", sizeBytes: png.length },
      at: new Date().toISOString(),
      language: "en",
    },
    image,
    // reuse already-extracted result via stub to avoid a second ~30s call
    { extract: async () => raw },
  );

  assert.equal(extraction.status, "ok", `extraction=${JSON.stringify(extraction)}`);
  const { geometry, unresolved } = normalizeExtraction(raw, "en");
  console.log("[vision-live] normalized walls:", geometry.wallRuns.map((w) => `${w.label}=${w.length}"`));
  console.log("[vision-live] unresolved count:", unresolved.length);

  assert.ok(plan.parsedGeometry.wallRuns.length > 0, "normalized geometry has no walls");
  // Kitchen on the sample plan is labeled 11'5" x 10'5" → 137" / 125"
  const lengths = plan.parsedGeometry.wallRuns.map((w) => w.length).filter((n) => n > 0);
  assert.ok(
    lengths.some((n) => Math.abs(n - 137) <= 3) || lengths.some((n) => Math.abs(n - 125) <= 3),
    `expected ~137" or ~125" kitchen walls, got [${lengths.join(", ")}]`,
  );
});
