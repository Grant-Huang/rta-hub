/**
 * 基于 Ollama 的视觉抽取 —— 实现 `VisionExtractor`（FR-3）。
 *
 * 端点用 Ollama 原生 `/api/generate`（`OPENAI_BASE_URL_VISION`，如
 * `http://localhost:11434`）。模型名取自 `LLM_MODEL_VISION`（默认 qwen2.5vl）。
 *
 * 输出必须是 `RawExtraction`（`wallRuns` 等），好让 `normalizeExtraction`
 * 直接收口——以前这里返回 rooms/walls 形状，归一化永远看不到墙段。
 */
import type { VisionExtractor, RawExtraction, RawWallRun } from "./parse.js";
import { FLOORPLAN_TEMPLATES } from "../samples/templates.js";

interface OllamaGenerateResponse {
  response?: string;
  done?: boolean;
  error?: string;
}

/**
 * 5 种标准布局的分类说明——从 `samples/templates.ts` 现算，不在这里另写一份
 * 重复描述（否则模板改了、这里的分类提示词忘了同步，是同一类"两份判断"的坑）。
 */
function templateGuessSection(): string {
  const lines = Object.values(FLOORPLAN_TEMPLATES).map((t) => {
    const slots = t.walls.map((w) => w.label).join(", ");
    return `- "${t.id}": ${t.noteEn} — slots: ${slots}`;
  });
  const slotNames = [...new Set(Object.values(FLOORPLAN_TEMPLATES).flatMap((t) =>
    t.walls.map((w) => w.label)))].join(", ");
  return `Also classify which of these 5 standard kitchen layouts the sketch most resembles (or none):
${lines.join("\n")}
Set "templateGuess" to { "id": <one of those 5 ids>, "confidence": 0–1 }, or omit it entirely if none of the 5 fit well.
System wall names are those slot labels (${slotNames}), never lettered A/B/C.`;
}

/** 给视觉模型的抽取说明。数字示例会泄漏进输出，所以这里只写字段契约、不写样例对象。 */
export function floorPlanVisionPrompt(hint?: string): string {
  const base = `You are reading an architectural floor plan image to extract the KITCHEN for cabinet layout.

The image may show a whole house (main floor + upper floor + garage). Focus on the room labeled Kitchen / KITCHEN / 厨房. Ignore bedrooms, garage, office, decks unless they are the only room shown.

From the kitchen outline, return the walls where base cabinets would run (usually along the kitchen perimeter walls that have counters/sink/stove). Lengths must be in **inches**.

Convert feet-inches labels: N' M" = N*12+M inches (example: 10'6" = 126).

${templateGuessSection()}

Return ONLY a JSON object (no markdown fences, no commentary) with these fields:
- ceilingHeight: number (inches) if a ceiling height is printed, else omit
- ceilingHeightConfidence: 0–1
- overallConfidence: 0–1
- templateGuess: object as described above, or omit
- wallRuns: array of wall objects
- notes: optional array of uncertainty strings

Each wallRuns item:
- label: the name printed on the drawing (including lettered names like A/B/C or Chinese wall names). Keep it as written.
- slot: the matching system wall name from the north arrow and the guessed layout's slots listed above. Must be one of: North, East, South, West, Island, or Wall. Do not put lettered names in slot.
- length: inches (number). Copy the printed dimension; if it is not on the sketch, omit length.
- lengthConfidence: 0–1
- startsAtCorner / endsAtCorner: booleans
- kind: "wall" (default) or "island"
- depth: inches; only for kind "island" (the short side). Island belongs in wallRuns (kind "island") — there is no separate island field.
- features: array of { kind, offset, width, confidence }

${featureRulesBlock()}

Rules:
- An island is NOT a fourth perimeter wall. Emit it as kind "island" with length (long side) and depth (short side). Island startsAtCorner and endsAtCorner are false.
- Prefer 2–4 kitchen wall runs that form an L / U / galley from the drawing, plus a separate island run when one is drawn.
- If the kitchen is labeled with overall room size (W x D) but individual wall segments are not marked, emit the sides using that W and D.
- Copy numbers from the drawing. Do not copy numbers from this prompt.
- If you truly cannot find any kitchen, set wallRuns to [] and explain in notes — but first look carefully for a Kitchen label on the main floor.
- Do not invent bedrooms as kitchen walls.
- Still return your best-effort wallRuns even when you give a templateGuess — the guess only helps organize them, it does not replace them.`;
  return withHint(base, hint);
}

/** 第一步：只读墙段 / 岛台 / 层高，不扫门窗上下水。 */
export function floorPlanVisionWallsPrompt(hint?: string): string {
  const base = `You are reading an architectural floor plan image to extract the KITCHEN outline for cabinet layout.

The image may show a whole house (main floor + upper floor + garage). Focus on the room labeled Kitchen / KITCHEN / 厨房. Ignore bedrooms, garage, office, decks unless they are the only room shown.

From the kitchen outline, return the walls where base cabinets would run (usually along the kitchen perimeter walls that have counters/sink/stove). Lengths must be in **inches**.

Convert feet-inches labels: N' M" = N*12+M inches (example: 10'6" = 126).

${templateGuessSection()}

THIS PASS IS WALLS ONLY. Do not list windows, doors, plumbing, or other features. Omit the features field.

Return ONLY a JSON object (no markdown fences, no commentary) with these fields:
- ceilingHeight: number (inches) if a ceiling height is printed, else omit
- ceilingHeightConfidence: 0–1
- overallConfidence: 0–1
- templateGuess: object as described above, or omit
- wallRuns: array of wall objects
- notes: optional array of uncertainty strings

Each wallRuns item:
- label: the name printed on the drawing (including lettered names like A/B/C or Chinese wall names). Keep it as written.
- slot: the matching system wall name from the north arrow and the guessed layout's slots listed above. Must be one of: North, East, South, West, Island, or Wall. Do not put lettered names in slot.
- length: inches (number). Copy the printed dimension; if it is not on the sketch, omit length.
- lengthConfidence: 0–1
- startsAtCorner / endsAtCorner: booleans
- kind: "wall" (default) or "island"
- depth: inches; only for kind "island" (the short side). Island belongs in wallRuns (kind "island") — there is no separate island field.

Rules:
- A hatched or diagonally filled rectangle standing in the room (not on a wall) = island.
- An island is NOT a fourth perimeter wall. Emit it as kind "island" with length (long side) and depth (short side). Island startsAtCorner and endsAtCorner are false.
- Prefer 2–4 kitchen wall runs that form an L / U / galley from the drawing, plus a separate island run when one is drawn.
- If the kitchen is labeled with overall room size (W x D) but individual wall segments are not marked, emit the sides using that W and D.
- Copy numbers from the drawing. Do not copy numbers from this prompt.
- If you truly cannot find any kitchen, set wallRuns to [] and explain in notes — but first look carefully for a Kitchen label on the main floor.
- Do not invent bedrooms as kitchen walls.
- Still return your best-effort wallRuns even when you give a templateGuess — the guess only helps organize them, it does not replace them.`;
  return withHint(base, hint);
}

function featureRulesBlock(): string {
  return `Legend (prefer the drawing's own legend if present; otherwise these common marks):
- two parallel thin lines crossing a wall = window
- arc or door-swing on a wall = door
- two circles / sink / faucet mark = plumbing
- hatched or diagonally filled rectangle standing in the room (not on a wall) = island

Feature kind must be one of: window, door, plumbing, gas, electrical, obstruction.
For EVERY listed kitchen run, scan for those marks. Put what you see in that wall's features[]. An empty features array means you looked and found none — not that you skipped the wall.
If a mark is drawn but its numbers are missing, still emit kind (and offset/width when readable); omit missing numbers and lower confidence. Do not invent a mark that is not drawn.
offset is inches from THAT wall's starting corner (the labeled corner on the sketch), not from the room origin. A door is often near the far end — do not default offset to 0.
A mark drawn on one wall near a corner belongs to THAT wall, not the adjoining wall.`;
}

/** 把第一步读到的墙压成给第二步看的清单——不含 features，避免第一步的错特征污染。 */
export function compactWallList(raw: RawExtraction): string {
  const rows = raw.wallRuns ?? [];
  if (!rows.length) return "(no walls)";
  return rows.map((w, i) => {
    const bits = [
      `slot=${w.slot?.trim() || "?"}`,
      `label=${JSON.stringify(w.label ?? "")}`,
      `kind=${w.kind ?? "wall"}`,
    ];
    if (typeof w.length === "number") bits.push(`length=${w.length}`);
    if (typeof w.depth === "number") bits.push(`depth=${w.depth}`);
    return `${i + 1}. ${bits.join(" ")}`;
  }).join("\n");
}

/** 第二步：墙已经锁定，只扫门窗上下水。 */
export function floorPlanVisionFeaturesPrompt(walls: RawExtraction, hint?: string): string {
  const base = `You already extracted the kitchen wall runs from this floor plan. Do not change them.

Locked wall runs (copy slot exactly; Do not change length, depth, kind, or slot):
${compactWallList(walls)}

Return ONLY a JSON object with wallRuns. Each item needs slot (same as above) and features: array of { kind, offset, width, confidence }.

${featureRulesBlock()}

Copy numbers from the drawing. Do not copy numbers from this prompt.`;
  return withHint(base, hint);
}

function withHint(base: string, hint?: string): string {
  const extra = hint?.trim();
  return extra ? `${base}\n\nExtra hint from user: ${extra}` : base;
}

function featureRunFor(wall: RawWallRun, featRuns: readonly RawWallRun[]): RawWallRun | undefined {
  const slot = (wall.slot ?? "").toLowerCase().trim();
  if (slot) {
    const bySlot = featRuns.find((f) => {
      const fs = (f.slot ?? "").toLowerCase().trim();
      const fl = (f.label ?? "").toLowerCase().trim();
      return fs === slot || fl.includes(slot);
    });
    if (bySlot) return bySlot;
  }
  const label = (wall.label ?? "").toLowerCase().trim();
  if (!label) return undefined;
  return featRuns.find((f) => {
    const fl = (f.label ?? "").toLowerCase().trim();
    const fs = (f.slot ?? "").toLowerCase().trim();
    return (fl && (fl === label || fl.includes(label) || label.includes(fl)))
      || (fs && label.includes(fs));
  });
}

/**
 * 把第二步的 features 挂到第一步的墙上。墙长 / slot / kind / depth 以第一步为准。
 */
export function mergeWallsAndFeatures(walls: RawExtraction, features: RawExtraction): RawExtraction {
  const featRuns = features.wallRuns ?? [];
  const wallRuns = (walls.wallRuns ?? []).map((w) => {
    const match = featureRunFor(w, featRuns);
    if (!match) return w;
    const feats = match.features ?? [];
    if (!feats.length) {
      const { features: _drop, ...rest } = w;
      return rest;
    }
    return { ...w, features: feats };
  });
  const notes = [...(walls.notes ?? []), ...(features.notes ?? [])];
  return {
    ...walls,
    wallRuns,
    ...(notes.length ? { notes } : {}),
  };
}

export interface OllamaVisionOptions {
  /** Ollama base URL, e.g. http://localhost:11434 */
  baseURL: string;
  /** Model tag; default LLM_MODEL_VISION or qwen2.5vl */
  model?: string;
  /** Fetch timeout ms. Vision models can be slow on CPU. Per-call when two-step. */
  timeoutMs?: number;
  /**
   * 默认两步：先墙后特征。`false` 退回单次提示词（A/B 对照用）。
   */
  twoStep?: boolean;
}

/** 从环境变量装配；没配 base URL 就返回 undefined（上传降级为手动录入）。 */
export function createVisionExtractorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VisionExtractor | undefined {
  const baseURL = env.OPENAI_BASE_URL_VISION?.trim();
  if (!baseURL) return undefined;
  return createOllamaVisionExtractor(baseURL, {
    ...(env.LLM_MODEL_VISION?.trim() ? { model: env.LLM_MODEL_VISION.trim() } : {}),
  });
}

/**
 * 测试 / simulate 专用视觉抽取。
 * 读 `OPENAI_BASE_URL_TEST_VISION`（或 TEST 文本端点去 `/v1`）+ `LLM_MODEL_TEST_VISION`，
 * **不**使用生产 `LLM_MODEL_VISION` / `OPENAI_BASE_URL_VISION`。
 */
export function createVisionExtractorFromTestEnv(
  env: NodeJS.ProcessEnv = process.env,
): VisionExtractor | undefined {
  const hasTestSignal = Boolean(
    env.LLM_MODEL_TEST_VISION?.trim()
    || env.OPENAI_BASE_URL_TEST_VISION?.trim()
    || env.LLM_MODEL_TEST_CHAT?.trim()
    || env.OPENAI_BASE_URL_TEST?.trim(),
  );
  if (!hasTestSignal) return undefined;

  const rawBase = env.OPENAI_BASE_URL_TEST_VISION?.trim()
    || env.OPENAI_BASE_URL_TEST?.trim()
    || "http://localhost:11434";
  const baseURL = rawBase.replace(/\/v1\/?$/, "");
  const model = env.LLM_MODEL_TEST_VISION?.trim() || "qwen2.5vl:latest";
  return createOllamaVisionExtractor(baseURL, { model });
}

export function createOllamaVisionExtractor(
  baseURL: string,
  opts: Omit<OllamaVisionOptions, "baseURL"> = {},
): VisionExtractor {
  const root = baseURL.replace(/\/$/, "");
  const model = opts.model?.trim() || process.env.LLM_MODEL_VISION?.trim() || "qwen2.5vl";
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const twoStep = opts.twoStep !== false;

  const generate = (prompt: string, b64: string, mimeType: string) =>
    ollamaGenerateJson(root, model, prompt, b64, mimeType, timeoutMs);

  return {
    async extract({ image, mimeType, hint }): Promise<RawExtraction | undefined> {
      const b64 = stripDataUrl(image);
      if (!b64) return undefined;

      if (!twoStep) {
        const parsed = await generate(floorPlanVisionPrompt(hint), b64, mimeType);
        return parsed ? toRawExtraction(parsed) : undefined;
      }

      const wallsParsed = await generate(floorPlanVisionWallsPrompt(hint), b64, mimeType);
      if (!wallsParsed) return undefined;
      const walls = toRawExtraction(wallsParsed);
      if (!walls.wallRuns?.length) return walls;

      const featParsed = await generate(floorPlanVisionFeaturesPrompt(walls, hint), b64, mimeType);
      if (!featParsed) return walls;
      return mergeWallsAndFeatures(walls, toRawExtraction(featParsed));
    },
  };
}

async function ollamaGenerateJson(
  root: string,
  model: string,
  prompt: string,
  b64: string,
  mimeType: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  const url = `${root}/api/generate`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        prompt,
        images: [b64],
        stream: false,
        format: "json",
        options: { temperature: 0.1, num_ctx: 8192 },
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Ollama vision request failed (${url}, model=${model}): ${msg}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Ollama API error: ${response.status} ${response.statusText}` +
        (body ? ` — ${body.slice(0, 200)}` : "") +
        ` (model=${model}; image=${mimeType})`,
    );
  }

  const data = (await response.json()) as OllamaGenerateResponse;
  if (data.error) throw new Error(`Ollama error: ${data.error}`);
  const text = data.response?.trim();
  if (!text) return undefined;

  const parsed = parseJsonObject(text);
  if (!parsed) {
    throw new Error(
      `Vision model returned non-JSON (model=${model}): ${text.slice(0, 280)}`,
    );
  }
  return parsed;
}

/** Ollama `images` 要裸 base64，不要 data URL 前缀。 */
function stripDataUrl(image: string): string {
  const s = image.trim();
  const m = /^data:[^;]+;base64,(.+)$/i.exec(s);
  return (m?.[1] ?? s).replace(/\s+/g, "");
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* try fence */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) {
    try {
      const v = JSON.parse(fenced[1].trim());
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* fall through */ }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(text.slice(start, end + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* ignore */ }
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** @internal 导出供单测直接断言 JSON→RawExtraction 的转换，不用真的起一个 Ollama。 */
export function toRawExtraction(parsed: Record<string, unknown>): RawExtraction {
  const wallRunsRaw = Array.isArray(parsed.wallRuns) ? parsed.wallRuns
    : Array.isArray(parsed.walls) ? parsed.walls
      : [];

  const wallRuns = wallRunsRaw.map((w) => {
    const row = (w && typeof w === "object" ? w : {}) as Record<string, unknown>;
    const length = num(row.length) ?? inchesFromFtIn(row.lengthFt, row.lengthIn)
      ?? num(row.lengthInches);
    const features = Array.isArray(row.features)
      ? row.features.map((f) => {
          const feat = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
          return {
            ...(typeof feat.kind === "string" ? { kind: feat.kind } : {}),
            ...(num(feat.offset) !== undefined ? { offset: num(feat.offset)! } : {}),
            ...(num(feat.width) !== undefined ? { width: num(feat.width)! }
              : inchesFromFtIn(feat.widthFt, feat.widthIn) !== undefined
                ? { width: inchesFromFtIn(feat.widthFt, feat.widthIn)! } : {}),
            ...(num(feat.sillHeight) !== undefined ? { sillHeight: num(feat.sillHeight)! } : {}),
            ...(num(feat.confidence) !== undefined ? { confidence: num(feat.confidence)! } : {}),
            ...(typeof feat.note === "string" ? { note: feat.note } : {}),
          };
        })
      : undefined;

    return {
      ...(typeof row.label === "string" ? { label: row.label }
        : typeof row.id === "string" ? { label: row.id }
          : typeof row.name === "string" ? { label: row.name } : {}),
      ...(typeof row.slot === "string" && row.slot.trim() ? { slot: row.slot.trim() } : {}),
      ...(length !== undefined ? { length } : {}),
      ...(num(row.lengthConfidence) !== undefined
        ? { lengthConfidence: num(row.lengthConfidence)! }
        : length !== undefined ? { lengthConfidence: 0.8 } : {}),
      ...(typeof row.startsAtCorner === "boolean" ? { startsAtCorner: row.startsAtCorner } : {}),
      ...(typeof row.endsAtCorner === "boolean" ? { endsAtCorner: row.endsAtCorner } : {}),
      ...(row.kind === "island" ? { kind: "island" as const } : {}),
      ...(num(row.depth) !== undefined ? { depth: num(row.depth)! } : {}),
      ...(features && features.length ? { features } : {}),
    };
  });

  const ceilingHeight = num(parsed.ceilingHeight);
  const notes = Array.isArray(parsed.notes)
    ? parsed.notes.filter((n): n is string => typeof n === "string")
    : undefined;

  const templateGuessRaw = (parsed.templateGuess && typeof parsed.templateGuess === "object"
    ? parsed.templateGuess : undefined) as Record<string, unknown> | undefined;
  const templateGuessId = typeof templateGuessRaw?.id === "string" ? templateGuessRaw.id : undefined;
  const templateGuessConfidence = num(templateGuessRaw?.confidence);

  return {
    ...(ceilingHeight !== undefined ? { ceilingHeight } : {}),
    ...(num(parsed.ceilingHeightConfidence) !== undefined
      ? { ceilingHeightConfidence: num(parsed.ceilingHeightConfidence)! } : {}),
    ...(num(parsed.overallConfidence) !== undefined
      ? { overallConfidence: num(parsed.overallConfidence)! } : {}),
    ...(wallRuns.length ? { wallRuns } : { wallRuns: [] }),
    ...(notes && notes.length ? { notes } : {}),
    ...(templateGuessId && templateGuessConfidence !== undefined
      ? { templateGuess: { id: templateGuessId, confidence: templateGuessConfidence } }
      : {}),
  };
}

function inchesFromFtIn(ft: unknown, inch: unknown): number | undefined {
  const f = num(ft) ?? 0;
  const i = num(inch) ?? 0;
  if (f === 0 && i === 0 && num(ft) === undefined && num(inch) === undefined) return undefined;
  return f * 12 + i;
}
