/**
 * 草图 → 5 种标准布局之一 的锚定归一化。
 *
 * 桥接两条本来互不相干的路径：`parse.ts` 的 `normalizeExtraction`（视觉模型
 * 自由抽取墙段，抽不出/不确定就进待确认队列）与 FR-17.4 的模板快选
 * （`samples/templates.ts`，客户自己点"我家像这个"来预填）。
 *
 * 客户上传草图时，视觉模型除了照旧自由抽取墙段，还要猜"这张图像不像 5 种
 * 标准布局里的哪一种"（`RawExtraction.templateGuess`）。猜中且置信度够时，
 * 不再把墙段当完全自由的列表处理，而是按该模板的墙段框架（几段墙、标签、
 * 大致顺序）来对齐：框架里哪一段图上量出来了（且置信度过关）就用图上的值，
 * 框架里哪一段没读到就生成一条待确认项——**问的是"框架里缺的这一段"，不是
 * 从零开始问"你家有几段墙"**。这正是客户体验上的差别：系统先说"看起来是U型
 * 布局"，再具体问"西墙/北墙/东墙里哪一段还没读出来"，而不是一句空泛的
 * "尺寸不齐，请补充"。
 *
 * 猜错、没猜、或置信度不够时，`matchesKnownTemplate` 返回 undefined，调用方
 * （`parse.ts` 的 `createFloorPlanWithOutcome`）原样退回现有的自由抽取路径
 * ——对没有 `templateGuess` 字段的既有测试夹具，行为与这次改动前完全一致。
 */
import { randomUUID } from "node:crypto";
import type { FloorPlanUnresolved, ParsedGeometry, WallFeature, WallRun } from "./types.js";
import { quantize } from "./types.js";
import { CONFIDENCE_THRESHOLD, type ParseResult, type RawExtraction } from "./parse.js";
import { FLOORPLAN_TEMPLATES, type FloorplanTemplate } from "../samples/templates.js";
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";

const newId = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

/** 模板猜测置信度低于此值不采用——宁可退回自由抽取，不能拿一个不确定的猜测硬套框架。 */
export const TEMPLATE_GUESS_THRESHOLD = 0.6;

const FEATURE_KINDS = ["window", "door", "plumbing", "gas", "electrical", "obstruction"] as const;

/** 视觉模型的模板猜测是否足够可信、值得用来锚定墙段框架。 */
export function matchesKnownTemplate(raw: RawExtraction | undefined): FloorplanTemplate | undefined {
  const guess = raw?.templateGuess;
  if (!guess || guess.confidence < TEMPLATE_GUESS_THRESHOLD) return undefined;
  return FLOORPLAN_TEMPLATES[guess.id];
}

type RawWall = NonNullable<RawExtraction["wallRuns"]>[number];

/**
 * 把自由抽取出的墙段对齐到模板的槎位上：先按标签模糊匹配（"North wall" 对得上
 * 模板槎位 "North"），标签对不上的原始墙段按剩余出现顺序依次补位——图上确实
 * 量出来的东西，不能因为标签文字对不上就白白扔掉。
 */
function alignRawWallsToTemplate(
  template: FloorplanTemplate,
  rawWalls: readonly RawWall[],
): (RawWall | undefined)[] {
  const used = new Set<number>();
  const byLabel = template.walls.map((slot) => {
    const slotLabel = slot.label.toLowerCase();
    const idx = rawWalls.findIndex((r, i) => {
      if (used.has(i)) return false;
      const label = (r.label ?? "").toLowerCase().trim();
      return label.length > 0 && (label.includes(slotLabel) || slotLabel.includes(label));
    });
    if (idx < 0) return undefined;
    used.add(idx);
    return rawWalls[idx];
  });

  let cursor = 0;
  return byLabel.map((match) => {
    if (match) return match;
    while (cursor < rawWalls.length && used.has(cursor)) cursor++;
    if (cursor >= rawWalls.length) return undefined;
    used.add(cursor);
    return rawWalls[cursor++];
  });
}

/**
 * 按已识别出的模板类型归一化——`normalizeExtraction` 的模板锚定版本。
 * 同样是纯函数，不调模型，便于穷举测试。
 */
export function normalizeExtractionWithTemplate(
  raw: RawExtraction,
  template: FloorplanTemplate,
  language: UiLanguage = DEFAULT_LANGUAGE,
): ParseResult {
  const lang = language;
  const unresolved: FloorPlanUnresolved[] = [];
  const aligned = alignRawWallsToTemplate(template, raw.wallRuns ?? []);

  const wallRuns: WallRun[] = template.walls.map((slot, i) => {
    const runId = newId("wr");
    const rawSlot = aligned[i];
    const lengthConf = rawSlot?.lengthConfidence ?? 0;
    const readFromImage = typeof rawSlot?.length === "number" && rawSlot.length > 0
      && lengthConf >= CONFIDENCE_THRESHOLD;

    if (!readFromImage) {
      unresolved.push({
        id: newId("fpu"),
        target: { kind: "wallRun", id: runId },
        field: "length",
        reason: typeof rawSlot?.length === "number"
          ? msg(lang,
            `This looks like a ${template.noteEn} The ${slot.label} wall's length looks uncertain — please confirm the actual size.`,
            `看起来是${template.noteZh}${slot.label}这段墙的长度看不太准，请确认实际尺寸。`)
          : msg(lang,
            `This looks like a ${template.noteEn} The ${slot.label} wall wasn't clearly readable from your sketch — how long is it (inches)?`,
            `看起来是${template.noteZh}草图上没能清楚读出${slot.label}这段墙的长度，大概多少寸？`),
        resolved: false,
        suggestion: typeof rawSlot?.length === "number" ? quantize(rawSlot.length) : slot.length,
      });
    }

    const features: WallFeature[] = [];
    for (const rf of rawSlot?.features ?? []) {
      const kind = FEATURE_KINDS.find((k) => k === rf.kind);
      const conf = rf.confidence ?? 0;
      if (!kind || typeof rf.offset !== "number" || conf < CONFIDENCE_THRESHOLD) continue;
      features.push({
        id: newId("wf"),
        kind,
        offset: quantize(rf.offset),
        width: quantize(rf.width ?? 0),
        ...(rf.sillHeight !== undefined ? { sillHeight: quantize(rf.sillHeight) } : {}),
        ...(rf.note ? { note: rf.note } : {}),
      });
    }

    return {
      id: runId,
      label: slot.label,
      length: readFromImage ? quantize(rawSlot!.length!) : 0,
      startsAtCorner: slot.startsAtCorner ?? i > 0,
      endsAtCorner: i < template.walls.length - 1,
      features,
      ...(slot.kind ? { kind: slot.kind } : {}),
      ...(slot.depth !== undefined ? { depth: slot.depth } : {}),
    };
  });

  let ceilingHeight: number | undefined;
  const ceilConf = raw.ceilingHeightConfidence ?? 0;
  if (typeof raw.ceilingHeight === "number" && ceilConf >= CONFIDENCE_THRESHOLD) {
    ceilingHeight = quantize(raw.ceilingHeight);
  } else {
    unresolved.push({
      id: newId("fpu"),
      target: { kind: "global" },
      field: "ceilingHeight",
      reason: msg(lang,
        "Ceiling height wasn't clearly readable from the sketch (it sets wall/tall cabinet height options) — roughly how high are your ceilings?",
        "草图上没能清楚读出层高（它决定吊柜和高柜的高度档位），你家层高大概是多少？"),
      resolved: false,
      suggestion: typeof raw.ceilingHeight === "number" ? quantize(raw.ceilingHeight) : template.ceilingHeight,
    });
  }

  for (const note of raw.notes ?? []) {
    unresolved.push({
      id: newId("fpu"), target: { kind: "global" }, field: "note", reason: note, resolved: false,
    });
  }

  const geometry: ParsedGeometry = {
    wallRuns,
    ...(ceilingHeight !== undefined ? { ceilingHeight } : {}),
    confidence: raw.overallConfidence ?? 0,
  };

  return { geometry, unresolved };
}
