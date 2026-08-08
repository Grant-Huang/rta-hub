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
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";

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
export function normalizeExtraction(
  raw: RawExtraction | undefined,
  language: UiLanguage = DEFAULT_LANGUAGE,
): ParseResult {
  const lang = language;
  const unresolved: FloorPlanUnresolved[] = [];
  const wallRuns: WallRun[] = [];

  if (!raw || !raw.wallRuns || raw.wallRuns.length === 0) {
    unresolved.push({
      id: newId("fpu"),
      target: { kind: "global" },
      field: "wallRuns",
      reason: msg(lang,
        "Couldn't identify any wall runs from the image — please tell me how many walls your kitchen has and how long each is",
        "没能从图上识别出任何墙段，需要你手动告诉我厨房有几面墙、各多长"),
      resolved: false,
    });
    return {
      geometry: { wallRuns: [], confidence: 0 },
      unresolved,
    };
  }

  raw.wallRuns.forEach((rawRun, i) => {
    const runId = newId("wr");
    const label = rawRun.label?.trim() || msg(lang, `Wall ${i + 1}`, `墙段 ${i + 1}`);
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
          ? msg(lang,
            `${label} length looks uncertain (confidence ${(lengthConf * 100).toFixed(0)}%) — please confirm the actual size`,
            `${label} 的长度看不太准（置信度 ${(lengthConf * 100).toFixed(0)}%），请确认实际尺寸`)
          : msg(lang,
            `${label} length could not be read — please measure and tell me`,
            `${label} 的长度没能识别出来，请量一下告诉我`),
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
          reason: msg(lang,
            `${label} has something we couldn't classify (${rawFeature.note ?? "unlabeled"}) — is it a window, door, or plumbing?`,
            `${label} 上有个识别不出类型的东西（${rawFeature.note ?? "未标注"}），是窗、门、还是上下水？`),
          resolved: false,
        });
        continue;
      }
      if (typeof rawFeature.offset !== "number" || conf < CONFIDENCE_THRESHOLD) {
        unresolved.push({
          id: newId("fpu"),
          target: { kind: "wallRun", id: runId },
          field: `feature.${kind}.offset`,
          reason: msg(lang,
            `${label}: ${featureName(kind, lang)} position is uncertain — how far is it from the corner?`,
            `${label} 上的${featureName(kind, lang)}位置不确定，请告诉我它距墙角多远`),
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
      reason: msg(lang,
        "Ceiling height can't be read from the image (it sets wall/tall cabinet height options) — roughly how high are your ceilings?",
        "天花板高度没法从图上看出来（它决定吊柜和高柜的高度档位），你家层高大概是多少？"),
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

function featureName(kind: WallFeature["kind"], lang: UiLanguage = DEFAULT_LANGUAGE): string {
  const en = {
    window: "window", door: "door", plumbing: "plumbing", gas: "gas line",
    electrical: "electrical", obstruction: "obstruction",
  }[kind];
  const zh = {
    window: "窗", door: "门", plumbing: "上下水", gas: "燃气口",
    electrical: "电源", obstruction: "障碍物",
  }[kind];
  return msg(lang, en, zh);
}

export interface CreateFloorPlanInput {
  conversationId: string;
  file: { name: string; mimeType: string; sizeBytes: number };
  at: string;
  /** 客户可见文案语言；默认英文。 */
  language?: UiLanguage;
}

/**
 * 从上传的图片创建户型图。
 *
 * 没有视觉模型时（`extractor` 为 undefined）返回一个**空几何 + 手动录入提示**，
 * 而不是编一个户型出来——这与 FR-2 的零静默失败是同一条原则。
 */
/**
 * 这次上传，视觉抽取到底走没走、结果如何。
 *
 * **必须报出来。** 三种"没读出东西"看起来一模一样，但要做的事完全不同：
 * 没配模型（去配）、没收到图（前端没传，是 bug）、模型报错（去看端点）。
 * 都退化成一句"请手动录入尺寸"，配错了的人永远不知道自己配错了——
 * 这正是这一轮测试里「视觉模型尚未测试」卡住的地方。
 */
export type ExtractionOutcome =
  | { status: "ok" }
  | { status: "notConfigured" }
  | { status: "noImage" }
  | { status: "failed"; reason: string }
  | { status: "emptyResult" };

export interface CreateFloorPlanResult {
  plan: FloorPlan;
  extraction: ExtractionOutcome;
}

export async function createFloorPlan(
  input: CreateFloorPlanInput,
  image: string | undefined,
  extractor: VisionExtractor | undefined,
): Promise<FloorPlan> {
  return (await createFloorPlanWithOutcome(input, image, extractor)).plan;
}

export async function createFloorPlanWithOutcome(
  input: CreateFloorPlanInput,
  image: string | undefined,
  extractor: VisionExtractor | undefined,
): Promise<CreateFloorPlanResult> {
  let raw: RawExtraction | undefined;
  let extraction: ExtractionOutcome =
    !extractor ? { status: "notConfigured" }
      : !image ? { status: "noImage" }
        : { status: "emptyResult" };

  if (extractor && image) {
    try {
      raw = await extractor.extract({ image, mimeType: input.file.mimeType });
      extraction = raw ? { status: "ok" } : { status: "emptyResult" };
    } catch (err) {
      // 抽取失败不该让上传失败——手动录入这条路一直是通的（FR-3 的降级设计）。
      // 但**失败的原因要说出来**，否则配错端点的人只会看到"请手动录入"。
      raw = undefined;
      extraction = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  const { geometry, unresolved } = normalizeExtraction(raw, input.language ?? DEFAULT_LANGUAGE);
  return {
    plan: {
      id: newId("fp"),
      conversationId: input.conversationId,
      sourceFile: input.file,
      parsedGeometry: geometry,
      parseConfidence: geometry.confidence,
      unresolvedItems: unresolved,
      createdAt: input.at,
      updatedAt: input.at,
    },
    extraction,
  };
}

/** 把抽取结果翻成一句给客户看的话。 */
export function extractionNote(
  outcome: ExtractionOutcome,
  language: UiLanguage = DEFAULT_LANGUAGE,
): string | undefined {
  const lang = language;
  switch (outcome.status) {
    case "ok": return undefined;
    case "notConfigured":
      return msg(lang,
        "No vision model is configured, so I can't read this image — fill in each wall's dimensions below.",
        "没有配置视觉模型，这张图我读不了——下面一段墙一段墙地填尺寸就行。");
    case "noImage":
      return msg(lang,
        "Got file metadata but no image content, so nothing was recognized. " +
          "(Usually an upload issue — you can keep going by entering sizes manually.)",
        "只收到了文件信息、没收到图片内容，所以没能识别。" +
          "（这多半是上传环节的问题，可以先手动录入尺寸继续。）");
    case "emptyResult":
      return msg(lang,
        "The vision model couldn't read usable sizes from this image — that happens when drawings are blurry or unlabeled. " +
          "Enter sizes manually below; measured numbers beat guesses.",
        "视觉模型没能从这张图里读出可用的尺寸——图纸太模糊或标注不清时会这样。" +
          "下面手动填一下就行，手填的数比猜的准。");
    case "failed":
      return msg(lang,
        `Vision recognition failed (${outcome.reason}). Enter sizes manually for now — that path always works; check the vision endpoint if recognition keeps failing.`,
        `视觉识别没跑成功（${outcome.reason}）。先手动录入尺寸继续，` +
          "这条路一直是通的；识别的问题请检查视觉模型端点配置。");
  }
}

/** 手动录入/修正一段墙的长度，同时消解对应的待确认项。 */
export function resolveWallLength(plan: FloorPlan, wallRunId: string, length: number, at: string): FloorPlan {
  const value = quantize(length);
  if (value <= 0) {
    throw new RangeError(msg(DEFAULT_LANGUAGE, "Wall length must be positive", "墙长必须为正"));
  }

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

/**
 * 手动添加一段墙（完全没识别出来时的兜底路径）。
 *
 * **默认与上一段相接。** 人一段一段报自己家厨房的墙时，报的是一圈连着的墙：
 * 「U 型，三面墙 11 尺、9 尺、11 尺」说的是一个 U，不是三面各自独立的墙。
 *
 * 这个默认值以前是 `false`，后果一直摆在客户眼前：手工录入的 U 型厨房，
 * 三段墙在全局俯视图上被画成三条各自独立的横条、底下附一句「示意排列」——
 * 也就是客户说的「把南墙、北墙、东墙分开写」。而且不止是画得难看：墙角不成立，
 * 转角处的干涉、转角柜、让位就全都无从算起。
 *
 * 从图里识别出来的那条路径（`parseFloorPlan`）本来就是按"首尾相接"推的，
 * 两条路径的默认值不一致，是同一件事有两份判断的又一例。
 * 真的不相接（岛台、隔断另一侧的备餐台）就显式传 `false`。
 */
export function addWallRun(
  plan: FloorPlan,
  input: {
    label: string; length: number;
    startsAtCorner?: boolean; endsAtCorner?: boolean;
    kind?: WallRun["kind"]; depth?: number;
  },
  at: string,
): FloorPlan {
  const existing = plan.parsedGeometry.wallRuns;
  // 接的是**上一段墙**，不是上一条记录：岛台夹在中间时，它前后的两面墙
  // 仍然是相接的。按"最后一条记录"找的话，岛台会把墙链切成两半，
  // 平面退回「示意排列」——正是这一轮要修掉的那个症状。
  const prev = [...existing].reverse().find((r) => r.kind !== "island");
  const island = input.kind === "island";
  const run: WallRun = {
    id: newId("wr"),
    label: input.label,
    length: quantize(input.length),
    // 岛台不接任何墙——它四面都是过道
    startsAtCorner: input.startsAtCorner ?? (!island && prev !== undefined),
    endsAtCorner: input.endsAtCorner ?? false,
    features: [],
    ...(island ? { kind: "island" as const } : {}),
    ...(input.depth !== undefined ? { depth: quantize(input.depth) } : {}),
  };
  // 上一段的"末端是墙角"要同步打上，否则相接只成立一半，平面依然拼不起来
  const joins = run.startsAtCorner && prev !== undefined && prev.kind !== "island";
  const wallRuns = existing.map((r) =>
    joins && r.id === prev.id ? { ...r, endsAtCorner: true } : r);

  return {
    ...plan,
    parsedGeometry: { ...plan.parsedGeometry, wallRuns: [...wallRuns, run] },
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
