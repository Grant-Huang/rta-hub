/**
 * 户型图解析 —— FR-3。
 *
 * 走**同一条通用抽取管线**：户型照片、别家给的报价单截图、方案 PDF 都从这里进
 * （REQUIREMENTS FR-3，不为特定专业软件格式单独建解析器）。
 *
 * 三条硬规则：
 *   1. **完整性优先**：拿不准的尺寸进 `unresolvedItems`，绝不静默跳过某段墙；
 *   2. 置信度低于阈值的字段一律标为待确认，即使模型给了值；
 *   3. 没有视觉模型时降级为**手动录入**，而不是编一个户型出来。
 */
import { randomUUID } from "node:crypto";
import type {
  FloorPlan, FloorPlanUnresolved, ParsedGeometry, WallFeature, WallRun,
} from "./types.js";
import { quantize } from "./types.js";

/** 低于此置信度的字段必须人工确认。 */
export const CONFIDENCE_THRESHOLD = 0.75;

/** 视觉抽取接口——把具体模型隔离在外，便于测试与降级。 */
export interface VisionExtractor {
  extract(input: {
    /** base64 或 data URL。 */
    image: string;
    mimeType: string;
    hint?: string;
  }): Promise<RawExtraction | undefined>;
}

/** 模型的原始输出。字段全部可选——模型看不清就该留空，而不是编。 */
export interface RawExtraction {
  ceilingHeight?: number;
  ceilingHeightConfidence?: number;
  wallRuns?: {
    label?: string;
    length?: number;
    lengthConfidence?: number;
    startsAtCorner?: boolean;
    endsAtCorner?: boolean;
    features?: {
      kind?: string;
      offset?: number;
      width?: number;
      sillHeight?: number;
      confidence?: number;
      note?: string;
    }[];
  }[];
  overallConfidence?: number;
  /** 模型自己说不确定的地方。 */
  notes?: string[];
}

const FEATURE_KINDS = ["window", "door", "plumbing", "gas", "electrical", "obstruction"] as const;

let seq = 0;
const newId = (p: string) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export interface ParseResult {
  geometry: ParsedGeometry;
  unresolved: FloorPlanUnresolved[];
}

/**
 * 把模型的原始输出转成几何 + 待确认队列。
 *
 * 这个函数是**纯的**，不调模型——便于对"哪些情况该进待确认队列"做穷举测试。
 */
export function normalizeExtraction(raw: RawExtraction | undefined): ParseResult {
  const unresolved: FloorPlanUnresolved[] = [];
  const wallRuns: WallRun[] = [];

  if (!raw || !raw.wallRuns || raw.wallRuns.length === 0) {
    unresolved.push({
      id: newId("fpu"),
      target: { kind: "global" },
      field: "wallRuns",
      reason: "没能从图上识别出任何墙段，需要你手动告诉我厨房有几面墙、各多长",
      resolved: false,
    });
    return {
      geometry: { wallRuns: [], confidence: 0 },
      unresolved,
    };
  }

  raw.wallRuns.forEach((rawRun, i) => {
    const runId = newId("wr");
    const label = rawRun.label?.trim() || `墙段 ${i + 1}`;
    const lengthConf = rawRun.lengthConfidence ?? 0;

    // 长度缺失或置信度不足 → 进待确认，**不猜**
    let length = 0;
    if (typeof rawRun.length === "number" && rawRun.length > 0 && lengthConf >= CONFIDENCE_THRESHOLD) {
      length = quantize(rawRun.length);
    } else {
      const item: FloorPlanUnresolved = {
        id: newId("fpu"),
        target: { kind: "wallRun", id: runId },
        field: "length",
        reason: typeof rawRun.length === "number"
          ? `${label} 的长度看不太准（置信度 ${(lengthConf * 100).toFixed(0)}%），请确认实际尺寸`
          : `${label} 的长度没能识别出来，请量一下告诉我`,
        resolved: false,
        ...(typeof rawRun.length === "number" ? { suggestion: quantize(rawRun.length) } : {}),
      };
      unresolved.push(item);
    }

    const features: WallFeature[] = [];
    for (const rawFeature of rawRun.features ?? []) {
      const kind = FEATURE_KINDS.find((k) => k === rawFeature.kind);
      const conf = rawFeature.confidence ?? 0;
      if (!kind) {
        unresolved.push({
          id: newId("fpu"),
          target: { kind: "wallRun", id: runId },
          field: "feature.kind",
          reason: `${label} 上有个识别不出类型的东西（${rawFeature.note ?? "未标注"}），是窗、门、还是上下水？`,
          resolved: false,
        });
        continue;
      }
      if (typeof rawFeature.offset !== "number" || conf < CONFIDENCE_THRESHOLD) {
        unresolved.push({
          id: newId("fpu"),
          target: { kind: "wallRun", id: runId },
          field: `feature.${kind}.offset`,
          reason: `${label} 上的${featureName(kind)}位置不确定，请告诉我它距墙角多远`,
          resolved: false,
          ...(typeof rawFeature.offset === "number" ? { suggestion: quantize(rawFeature.offset) } : {}),
        });
        continue;
      }
      features.push({
        id: newId("wf"),
        kind,
        offset: quantize(rawFeature.offset),
        width: quantize(rawFeature.width ?? 0),
        ...(rawFeature.sillHeight !== undefined ? { sillHeight: quantize(rawFeature.sillHeight) } : {}),
        ...(rawFeature.note ? { note: rawFeature.note } : {}),
      });
    }

    wallRuns.push({
      id: runId,
      label,
      length,
      startsAtCorner: rawRun.startsAtCorner ?? i > 0,
      endsAtCorner: rawRun.endsAtCorner ?? i < (raw.wallRuns?.length ?? 0) - 1,
      features,
    });
  });

  // 天花板高度影响吊柜/高柜档位；不确定就问，不默认 96"
  let ceilingHeight: number | undefined;
  const ceilConf = raw.ceilingHeightConfidence ?? 0;
  if (typeof raw.ceilingHeight === "number" && ceilConf >= CONFIDENCE_THRESHOLD) {
    ceilingHeight = quantize(raw.ceilingHeight);
  } else {
    unresolved.push({
      id: newId("fpu"),
      target: { kind: "global" },
      field: "ceilingHeight",
      reason: "天花板高度没法从图上看出来（它决定吊柜和高柜的高度档位），你家层高大概是多少？",
      resolved: false,
      ...(typeof raw.ceilingHeight === "number" ? { suggestion: quantize(raw.ceilingHeight) } : {}),
    });
  }

  // 模型自己提出的疑问也进队列
  for (const note of raw.notes ?? []) {
    unresolved.push({
      id: newId("fpu"), target: { kind: "global" }, field: "note",
      reason: note, resolved: false,
    });
  }

  return {
    geometry: {
      wallRuns,
      ...(ceilingHeight !== undefined ? { ceilingHeight } : {}),
      confidence: raw.overallConfidence ?? 0,
    },
    unresolved,
  };
}

function featureName(kind: WallFeature["kind"]): string {
  return { window: "窗", door: "门", plumbing: "上下水", gas: "燃气口", electrical: "电源", obstruction: "障碍物" }[kind];
}

export interface CreateFloorPlanInput {
  conversationId: string;
  file: { name: string; mimeType: string; sizeBytes: number };
  at: string;
}

/**
 * 从上传的图片创建户型图。
 *
 * 没有视觉模型时（`extractor` 为 undefined）返回一个**空几何 + 手动录入提示**，
 * 而不是编一个户型出来——这与 FR-2 的零静默失败是同一条原则。
 */
export async function createFloorPlan(
  input: CreateFloorPlanInput,
  image: string | undefined,
  extractor: VisionExtractor | undefined,
): Promise<FloorPlan> {
  let raw: RawExtraction | undefined;
  if (extractor && image) {
    try {
      raw = await extractor.extract({ image, mimeType: input.file.mimeType });
    } catch {
      raw = undefined;
    }
  }

  const { geometry, unresolved } = normalizeExtraction(raw);
  return {
    id: newId("fp"),
    conversationId: input.conversationId,
    sourceFile: input.file,
    parsedGeometry: geometry,
    parseConfidence: geometry.confidence,
    unresolvedItems: unresolved,
    createdAt: input.at,
    updatedAt: input.at,
  };
}

/** 手动录入/修正一段墙的长度，同时消解对应的待确认项。 */
export function resolveWallLength(plan: FloorPlan, wallRunId: string, length: number, at: string): FloorPlan {
  const value = quantize(length);
  if (value <= 0) throw new RangeError("墙长必须为正");

  return {
    ...plan,
    parsedGeometry: {
      ...plan.parsedGeometry,
      wallRuns: plan.parsedGeometry.wallRuns.map((r) => (r.id === wallRunId ? { ...r, length: value } : r)),
    },
    unresolvedItems: plan.unresolvedItems.map((u) =>
      u.target.kind === "wallRun" && u.target.id === wallRunId && u.field === "length"
        ? { ...u, resolved: true }
        : u),
    updatedAt: at,
  };
}

export function resolveCeilingHeight(plan: FloorPlan, height: number, at: string): FloorPlan {
  return {
    ...plan,
    parsedGeometry: { ...plan.parsedGeometry, ceilingHeight: quantize(height) },
    unresolvedItems: plan.unresolvedItems.map((u) =>
      u.field === "ceilingHeight" ? { ...u, resolved: true } : u),
    updatedAt: at,
  };
}

/** 通用地消解一条待确认项（客户在对话里回答后调用）。 */
export function resolveItem(plan: FloorPlan, itemId: string, at: string): FloorPlan {
  return {
    ...plan,
    unresolvedItems: plan.unresolvedItems.map((u) => (u.id === itemId ? { ...u, resolved: true } : u)),
    updatedAt: at,
  };
}

/** 手动添加一段墙（完全没识别出来时的兜底路径）。 */
export function addWallRun(
  plan: FloorPlan,
  input: { label: string; length: number; startsAtCorner?: boolean; endsAtCorner?: boolean },
  at: string,
): FloorPlan {
  const run: WallRun = {
    id: newId("wr"),
    label: input.label,
    length: quantize(input.length),
    startsAtCorner: input.startsAtCorner ?? false,
    endsAtCorner: input.endsAtCorner ?? false,
    features: [],
  };
  return {
    ...plan,
    parsedGeometry: { ...plan.parsedGeometry, wallRuns: [...plan.parsedGeometry.wallRuns, run] },
    unresolvedItems: plan.unresolvedItems.map((u) =>
      u.field === "wallRuns" ? { ...u, resolved: true } : u),
    updatedAt: at,
  };
}

export function addFeature(
  plan: FloorPlan,
  wallRunId: string,
  feature: Omit<WallFeature, "id">,
  at: string,
): FloorPlan {
  return {
    ...plan,
    parsedGeometry: {
      ...plan.parsedGeometry,
      wallRuns: plan.parsedGeometry.wallRuns.map((r) =>
        r.id === wallRunId
          ? { ...r, features: [...r.features, { ...feature, id: newId("wf"), offset: quantize(feature.offset), width: quantize(feature.width) }] }
          : r),
    },
    updatedAt: at,
  };
}

/** 生成给客户的追问列表——按待确认项逐条问，不合并成一大段。 */
export function pendingQuestions(plan: FloorPlan): { id: string; question: string; suggestion?: number }[] {
  return plan.unresolvedItems
    .filter((u) => !u.resolved)
    .map((u) => ({
      id: u.id,
      question: u.reason,
      ...(u.suggestion !== undefined ? { suggestion: u.suggestion } : {}),
    }));
}
