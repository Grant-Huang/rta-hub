/**
 * 实图 A/B：同一张 L+岛台手绘，单次 vs 两步都当场跑，并记下耗时。
 * Ollama 不可达时跳过，不把 CI 卡死。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOllamaVisionExtractor } from "../src/floorplan/ollama-vision.js";
import { createFloorPlanWithOutcome } from "../src/floorplan/parse.js";
import { matchesKnownTemplate, normalizeExtractionWithTemplate } from "../src/floorplan/template-match.js";
import { exportDesignInput } from "../src/floorplan/design-input.js";
import type { RawExtraction } from "../src/floorplan/parse.js";
import { scoreAgainstTruth } from "./fixtures/l-island-truth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(here, "../src/samples/l-island-kitchen-floorplan.png");

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

function summarize(raw: RawExtraction) {
  return {
    score: scoreAgainstTruth(raw),
    walls: raw.wallRuns?.map((w) => ({
      slot: w.slot, label: w.label, length: w.length, depth: w.depth, kind: w.kind,
      features: w.features,
    })),
  };
}

test("A/B 实图：单次 vs 两步，同时对比耗时", async (t) => {
  if (!existsSync(SAMPLE)) {
    t.skip("l-island-kitchen-floorplan.png missing");
    return;
  }
  const baseURL = process.env.OPENAI_BASE_URL_VISION?.trim() || "http://127.0.0.1:11434";
  if (!(await ollamaReachable(baseURL))) {
    t.skip(`Ollama not reachable at ${baseURL}`);
    return;
  }

  const png = readFileSync(SAMPLE);
  const image = `data:image/png;base64,${png.toString("base64")}`;
  const model = process.env.LLM_MODEL_VISION?.trim() || "qwen2.5vl";
  const timings: { step: string; elapsedMs: number }[] = [];

  const run = async (twoStep: boolean) => {
    const stepTimings: { step: string; elapsedMs: number }[] = [];
    const extractor = createOllamaVisionExtractor(baseURL, {
      model,
      timeoutMs: 360_000,
      twoStep,
      onTiming: (info) => {
        stepTimings.push(info);
        timings.push({ ...info, step: `${twoStep ? "B" : "A"}:${info.step}` });
      },
    });
    const t0 = Date.now();
    const raw = await extractor.extract({ image, mimeType: "image/png" });
    return { raw, elapsedMs: Date.now() - t0, stepTimings };
  };

  const A = await run(false);
  const B = await run(true);
  assert.ok(A.raw, "oneshot extractor returned undefined");
  assert.ok(B.raw, "two-step extractor returned undefined");

  const tmp = path.join(here, "../.tmp");
  mkdirSync(tmp, { recursive: true });
  writeFileSync(path.join(tmp, "l-island-qwen2.5vl-oneshot-raw.json"), JSON.stringify(A.raw, null, 2));
  writeFileSync(path.join(tmp, "l-island-qwen2.5vl-twostep-raw.json"), JSON.stringify(B.raw, null, 2));

  const templateAnchor = (raw: RawExtraction | undefined, lang: "en" | "zh") => {
    const template = matchesKnownTemplate(raw);
    return template ? normalizeExtractionWithTemplate(raw!, template, lang) : undefined;
  };
  const { plan } = await createFloorPlanWithOutcome(
    {
      conversationId: "c_ab_twostep_timed",
      file: { name: "l-island-kitchen-floorplan.png", mimeType: "image/png", sizeBytes: png.length },
      at: new Date().toISOString(),
      language: "zh",
    },
    image,
    { extract: async () => B.raw },
    templateAnchor,
  );
  const exported = exportDesignInput(plan);

  const report = {
    at: new Date().toISOString(),
    model,
    A: { elapsedMs: A.elapsedMs, steps: A.stepTimings, ...summarize(A.raw!) },
    B: { elapsedMs: B.elapsedMs, steps: B.stepTimings, ...summarize(B.raw!) },
    deltaMs: B.elapsedMs - A.elapsedMs,
  };
  writeFileSync(path.join(tmp, "l-island-qwen2.5vl-ab-timing.json"), JSON.stringify(report, null, 2));
  console.log("[vision two-step A/B timed]\n" + JSON.stringify(report, null, 2));

  assert.equal(scoreAgainstTruth(A.raw!).wallHits, 3, "单次墙长应对上");
  assert.equal(scoreAgainstTruth(B.raw!).wallHits, 3, "两步墙长应对上");
  assert.ok(A.elapsedMs > 0 && B.elapsedMs > 0);
  for (const w of exported.geometry.wallRuns) {
    assert.equal(w.provenance, "assumed", `${w.label} 不得标成已确认`);
  }
});
