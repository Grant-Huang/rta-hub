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
 * 从零开始问"你家有几段墙"**。
 *
 * 标签对不上时**不按出现顺序硬套**：错把第一段 137" 填进北墙，比丢掉这段
 * 更危险。对不上的槽位空着，多出来的 raw 墙进待确认说明。
 *
 * 猜错、没猜、或置信度不够时，`matchesKnownTemplate` 返回 undefined，调用方
 * （`parse.ts` 的 `createFloorPlanWithOutcome`）原样退回现有的自由抽取路径。
 */
import { randomUUID } from "node:crypto";
import type { FloorPlanUnresolved, ParsedGeometry, WallFeature, WallRun } from "./types.js";
import { quantize } from "./types.js";
import {
  ceilingFromVision, ingestRawFeature, wallLengthFromVision,
  type ParseResult, type RawExtraction, type RawWallRun,
} from "./parse.js";
import { FLOORPLAN_TEMPLATES, type FloorplanTemplate, type FloorplanTemplateWall } from "../samples/templates.js";
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";

const newId = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

/** 模板猜测置信度低于此值不采用——宁可退回自由抽取，不能拿一个不确定的猜测硬套框架。 */
export const TEMPLATE_GUESS_THRESHOLD = 0.6;

const COMPASS_ALIASES: Readonly<Record<string, readonly string[]>> = {
  north: ["north", "北"],
  east: ["east", "东"],
  west: ["west", "西"],
  south: ["south", "南"],
  island: ["island", "岛台", "中岛", "岛"],
};

/** 视觉模型的模板猜测是否足够可信、值得用来锚定墙段框架。 */
export function matchesKnownTemplate(raw: RawExtraction | undefined): FloorplanTemplate | undefined {
  const guess = raw?.templateGuess;
  if (!guess || guess.confidence < TEMPLATE_GUESS_THRESHOLD) return undefined;
  return FLOORPLAN_TEMPLATES[guess.id];
}

function declaredSlotMatches(declared: string, slot: FloorplanTemplateWall): boolean {
  const v = declared.toLowerCase().trim();
  const s = slot.label.toLowerCase().trim();
  if (!v) return false;
  if (v === s) return true;
  const aliases = COMPASS_ALIASES[s];
  if (!aliases) return false;
  return aliases.some((a) => v === a || v.includes(a)) || v.includes(s);
}

/**
 * 对齐优先用模型给的 `slot`（图上 A/B/C → 罗盘槽位）。
 * 没有 slot 再认标签：North / north wall / 北墙；岛台还认 kind/depth。
 * 对不上就留空，**不再**按剩余出现顺序补位。
 */
export function rawMatchesSlot(raw: RawWallRun, slot: FloorplanTemplateWall): boolean {
  const declared = (raw.slot ?? "").trim();
  if (declared) return declaredSlotMatches(declared, slot);

  const slotLabel = slot.label.toLowerCase().trim();
  const islandSlot = slot.kind === "island" || slotLabel === "island";
  if (islandSlot) {
    if (raw.kind === "island") return true;
    if (typeof raw.depth === "number" && raw.depth > 0) return true;
  }
  const label = (raw.label ?? "").toLowerCase().trim();
  if (!label) return false;
  if (label.includes(slotLabel) || (slotLabel.length >= 3 && slotLabel.includes(label))) return true;
  return (COMPASS_ALIASES[slotLabel] ?? []).some((a) => label.includes(a));
}

function alignRawWallsToTemplate(
  template: FloorplanTemplate,
  rawWalls: readonly RawWallRun[],
): { aligned: (RawWallRun | undefined)[]; unused: RawWallRun[] } {
  const used = new Set<number>();
  const aligned = template.walls.map((slot) => {
    const idx = rawWalls.findIndex((r, i) => !used.has(i) && rawMatchesSlot(r, slot));
    if (idx < 0) return undefined;
    used.add(idx);
    return rawWalls[idx];
  });
  const unused = rawWalls.filter((_, i) => !used.has(i));
  return { aligned, unused };
}

function islandJoins(slot: FloorplanTemplateWall): boolean {
  return slot.kind === "island";
}

/**
 * 按已识别出的模板类型归一化——`normalizeExtraction` 的模板锚定版本。
 * 墙长/层高/特征的「写几何 + 待确认」走 parse.ts 同一套接口。
 */
export function normalizeExtractionWithTemplate(
  raw: RawExtraction,
  template: FloorplanTemplate,
  language: UiLanguage = DEFAULT_LANGUAGE,
): ParseResult {
  const lang = language;
  const unresolved: FloorPlanUnresolved[] = [];
  const { aligned, unused } = alignRawWallsToTemplate(template, raw.wallRuns ?? []);

  const wallRuns: WallRun[] = template.walls.map((slot, i) => {
    const runId = newId("wr");
    const rawSlot = aligned[i];
    const prev = template.walls[i - 1];
    const next = template.walls[i + 1];

    let length = 0;
    if (rawSlot) {
      const fromVision = wallLengthFromVision(rawSlot, {
        runId, label: slot.label, language: lang, newId,
      });
      length = fromVision.length;
      unresolved.push(...fromVision.unresolved);
    } else {
      unresolved.push({
        id: newId("fpu"),
        target: { kind: "wallRun", id: runId },
        field: "length",
        reason: msg(lang,
          `This looks like a ${template.noteEn} The ${slot.label} wall wasn't clearly readable from your sketch — how long is it (inches)?`,
          `看起来是${template.noteZh}草图上没能清楚读出${slot.label}这段墙的长度，大概多少寸？`),
        resolved: false,
        suggestion: slot.length,
      });
    }

    const features: WallFeature[] = [];
    for (const rf of rawSlot?.features ?? []) {
      const ingested = ingestRawFeature(rf, {
        runId, wallLabel: slot.label, language: lang, newId,
      });
      if (ingested.feature) features.push(ingested.feature);
      unresolved.push(...ingested.unresolved);
    }

    const island = islandJoins(slot);
    const visionDepth = rawSlot && typeof rawSlot.depth === "number" && rawSlot.depth > 0
      ? quantize(rawSlot.depth)
      : undefined;
    const depth = visionDepth ?? slot.depth;
    return {
      id: runId,
      label: slot.label,
      length,
      startsAtCorner: island ? false : (slot.startsAtCorner ?? (i > 0 && !islandJoins(prev!))),
      endsAtCorner: island ? false : Boolean(next && !islandJoins(next)),
      features,
      ...(slot.kind ? { kind: slot.kind } : {}),
      ...(depth !== undefined ? { depth } : {}),
    };
  });

  const ceiling = ceilingFromVision(raw, {
    language: lang, newId, fallbackSuggestion: template.ceilingHeight,
  });
  unresolved.push(...ceiling.unresolved);

  for (const extra of unused) {
    const label = extra.label?.trim() || msg(lang, "unlabeled run", "未标注墙段");
    const len = typeof extra.length === "number" ? extra.length : undefined;
    unresolved.push({
      id: newId("fpu"),
      target: { kind: "global" },
      field: "note",
      reason: len !== undefined
        ? msg(lang,
          `Also read "${label}" ~${len}" which didn't match a ${template.noteEn} wall slot — which wall is this?`,
          `还读到「${label}」约 ${len}"，对不上${template.noteZh}的墙段槽位，这是哪一段？`)
        : msg(lang,
          `Also read "${label}" which didn't match a ${template.noteEn} wall slot — which wall is this?`,
          `还读到「${label}」，对不上${template.noteZh}的墙段槽位，这是哪一段？`),
      resolved: false,
      ...(len !== undefined ? { suggestion: len } : {}),
    });
  }

  for (const note of raw.notes ?? []) {
    unresolved.push({
      id: newId("fpu"), target: { kind: "global" }, field: "note", reason: note, resolved: false,
    });
  }

  const geometry: ParsedGeometry = {
    wallRuns,
    ...(ceiling.ceilingHeight !== undefined ? { ceilingHeight: ceiling.ceilingHeight } : {}),
    confidence: raw.overallConfidence ?? 0,
  };

  return { geometry, unresolved };
}
