/**
 * 实图 A/B：同一张 L+岛台手绘。
 * A = 已冻结的单次抽取 raw（不重跑，约 90s）。
 * B = 当前两步抽取（先墙后特征）。Ollama 不可达时跳过。
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
const ONESHOT = JSON.parse(
  readFileSync(path.join(here, "fixtures", "l-island-qwen2.5vl-oneshot-raw.json"), "utf8"),
) as RawExtraction;

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

test("A/B 实图：两步抽取 vs 冻结的单次 raw", async (t) => {
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
  const extractor = createOllamaVisionExtractor(baseURL, {
    model: process.env.LLM_MODEL_VISION?.trim() || "qwen2.5vl",
    timeoutMs: 180_000,
    twoStep: true,
  });

  const rawB = await extractor.extract({ image, mimeType: "image/png" });
  assert.ok(rawB, "two-step extractor returned undefined");

  const tmp = path.join(here, "../.tmp");
  mkdirSync(tmp, { recursive: true });
  writeFileSync(path.join(tmp, "l-island-qwen2.5vl-twostep-raw.json"), JSON.stringify(rawB, null, 2));

  const A = scoreAgainstTruth(ONESHOT);
  const B = scoreAgainstTruth(rawB);
  const templateAnchor = (raw: RawExtraction | undefined, lang: "en" | "zh") => {
    const template = matchesKnownTemplate(raw);
    return template ? normalizeExtractionWithTemplate(raw!, template, lang) : undefined;
  };
  const { plan } = await createFloorPlanWithOutcome(
    {
      conversationId: "c_ab_twostep",
      file: { name: "l-island-kitchen-floorplan.png", mimeType: "image/png", sizeBytes: png.length },
      at: new Date().toISOString(),
      language: "zh",
    },
    image,
    { extract: async () => rawB },
    templateAnchor,
  );
  const exported = exportDesignInput(plan);
  const expBySlot = Object.fromEntries(
    exported.geometry.wallRuns.map((w) => [w.label, {
      length: w.length, kind: w.kind, depth: w.depth, provenance: w.provenance,
      features: w.features.map((f) => ({ kind: f.kind, offset: f.offset, width: f.width })),
    }]),
  );

  console.log("[vision two-step A/B]\n" + JSON.stringify({
    A: { score: A, features: ONESHOT.wallRuns?.map((w) => ({ slot: w.slot, features: w.features })) },
    B: { score: B, raw: rawB.wallRuns?.map((w) => ({ slot: w.slot, label: w.label, length: w.length, features: w.features })), export: expBySlot },
  }, null, 2));

  assert.equal(B.wallHits, 3, "两步墙长仍应对上 North 144 / East 120 / Island 72");
  for (const w of exported.geometry.wallRuns) {
    assert.equal(w.provenance, "assumed", `${w.label} 不得标成已确认`);
  }
});
