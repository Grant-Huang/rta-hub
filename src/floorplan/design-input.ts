/**
 * 设计输入标准化导入导出 —— FR-24。
 *
 * 目的：允许体外系统（更强的 VL 模型读图、CAD/设计软件导出、另一套系统迁移数据）
 * 直接产出一份结构化 JSON，导入后**跳过本系统的逐项收集**——但前提是每一项数据
 * 都显式声明了 `provenance`。这不是新发明一套信任机制，是复用两处已有的：
 *
 *   - 家电 `ApplianceSpec.provenance`（FR-3.2）：`customer` 直接采信，`assumed`
 *     仍要走确认（`assumedOnes()` / `isConfirmAssumedAppliances()`）。
 *   - 户型几何用 `FloorPlanUnresolved`（FR-15.5 / FR-17.4）：`customer` 不生成
 *     待确认项，`assumed` 生成一条，走与模板预填相同的 Q# 确认门禁。
 *
 * `provenance: "customer"` 的含义是"已经核实过，不是猜的"——可以是客户自己
 * 给的，也可以是体外流程量过/核对过的；系统不关心"谁"确认的，只认"有没有
 * 被确认过"。**缺省按 `"assumed"` 处理**（安全默认值——不能因为数据来自
 * "更强的模型"就自动当成已确认，FR-15.5 同一条原则）。
 */
import { randomUUID } from "node:crypto";
import type { FloorPlan, FloorPlanUnresolved, WallFeatureKind, WallRun } from "./types.js";
import { quantize } from "./types.js";
import { addFeature, addWallRun, createChatSourcedFloorPlan, isWallLengthPending, resolveCeilingHeight } from "./parse.js";
import { APPLIANCE_DEFAULTS, normalizeAppliances, type ApplianceKind, type ApplianceSpec, type Provenance } from "./appliances.js";

export class DesignInputError extends Error {}

export const DESIGN_INPUT_SCHEMA_VERSION = "1.0";

const WALL_FEATURE_KINDS = new Set<string>([
  "window", "door", "plumbing", "gas", "electrical", "obstruction",
]);
const APPLIANCE_KINDS = new Set<string>(Object.keys(APPLIANCE_DEFAULTS));

export interface DesignInputFeature {
  kind: WallFeatureKind;
  offset: number;
  width: number;
  sillHeight?: number;
  note?: string;
  provenance?: Provenance;
}

export interface DesignInputWallRun {
  label: string;
  length: number;
  kind?: "wall" | "island";
  depth?: number;
  startsAtCorner?: boolean;
  endsAtCorner?: boolean;
  provenance?: Provenance;
  features: DesignInputFeature[];
}

export type DesignInputSourceKind = "vl_model" | "cad_export" | "manual_entry" | "other_system" | "export";

export interface DesignInputDocument {
  schemaVersion: string;
  source?: {
    kind?: DesignInputSourceKind;
    producer?: string;
    generatedAt?: string;
    note?: string;
  };
  geometry: {
    wallRuns: DesignInputWallRun[];
    ceilingHeight?: { value: number; provenance?: Provenance };
    confidence?: number;
  };
  appliances?: ApplianceSpec[];
}

/** 未显式声明就按「未核实」处理——不能因为体外系统给了数字就当成已确认（FR-15.5）。 */
function provenanceOf(p: Provenance | undefined): Provenance {
  return p === "customer" ? "customer" : "assumed";
}

function assertProvenance(v: unknown, field: string): Provenance | undefined {
  if (v === undefined) return undefined;
  if (v !== "customer" && v !== "assumed") {
    throw new DesignInputError(`${field} must be "customer" or "assumed"`);
  }
  return v;
}
function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new DesignInputError(`${field} must be a non-empty string`);
  return v;
}
function requirePositiveNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new DesignInputError(`${field} must be a positive number`);
  }
  return v;
}
function requireNonNegativeNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new DesignInputError(`${field} must be a non-negative number`);
  }
  return v;
}

function parseFeature(raw: unknown, path: string): DesignInputFeature {
  const f = (raw ?? {}) as Record<string, unknown>;
  const kind = requireString(f.kind, `${path}.kind`);
  if (!WALL_FEATURE_KINDS.has(kind)) {
    throw new DesignInputError(`${path}.kind "${kind}" is not a known feature kind`);
  }
  return {
    kind: kind as WallFeatureKind,
    offset: requireNonNegativeNumber(f.offset, `${path}.offset`),
    width: requireNonNegativeNumber(f.width, `${path}.width`),
    sillHeight: typeof f.sillHeight === "number" ? f.sillHeight : undefined,
    note: typeof f.note === "string" ? f.note : undefined,
    provenance: assertProvenance(f.provenance, `${path}.provenance`),
  };
}

function parseWallRun(raw: unknown, path: string): DesignInputWallRun {
  const w = (raw ?? {}) as Record<string, unknown>;
  const featuresRaw = w.features;
  if (featuresRaw !== undefined && !Array.isArray(featuresRaw)) {
    throw new DesignInputError(`${path}.features must be an array`);
  }
  return {
    label: requireString(w.label, `${path}.label`),
    length: requirePositiveNumber(w.length, `${path}.length`),
    kind: w.kind === "island" ? "island" : undefined,
    depth: typeof w.depth === "number" ? w.depth : undefined,
    startsAtCorner: typeof w.startsAtCorner === "boolean" ? w.startsAtCorner : undefined,
    endsAtCorner: typeof w.endsAtCorner === "boolean" ? w.endsAtCorner : undefined,
    provenance: assertProvenance(w.provenance, `${path}.provenance`),
    features: Array.isArray(featuresRaw)
      ? featuresRaw.map((f, j) => parseFeature(f, `${path}.features[${j}]`))
      : [],
  };
}

function parseAppliance(raw: unknown, path: string): ApplianceSpec {
  const a = (raw ?? {}) as Record<string, unknown>;
  const kind = requireString(a.kind, `${path}.kind`);
  if (!APPLIANCE_KINDS.has(kind)) {
    throw new DesignInputError(`${path}.kind "${kind}" is not a known appliance kind`);
  }
  const preferredZone = a.preferredZone;
  if (
    preferredZone !== undefined
    && preferredZone !== "nearEntry" && preferredZone !== "nearSink"
    && preferredZone !== "nearWindow" && preferredZone !== "any"
  ) {
    throw new DesignInputError(`${path}.preferredZone is not a known zone`);
  }
  return {
    kind: kind as ApplianceKind,
    width: requirePositiveNumber(a.width, `${path}.width`),
    clearanceEachSide: requireNonNegativeNumber(a.clearanceEachSide, `${path}.clearanceEachSide`),
    ...(preferredZone ? { preferredZone: preferredZone as ApplianceSpec["preferredZone"] } : {}),
    provenance: provenanceOf(assertProvenance(a.provenance, `${path}.provenance`)),
  };
}

/** 校验导入体的形状；不合规直接拒绝，不做静默纠正（同 FR-3 完整性原则）。 */
export function validateDesignInputDocument(body: unknown): DesignInputDocument {
  if (!body || typeof body !== "object") throw new DesignInputError("Body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (b.schemaVersion !== DESIGN_INPUT_SCHEMA_VERSION) {
    throw new DesignInputError(`Unsupported schemaVersion (expected "${DESIGN_INPUT_SCHEMA_VERSION}")`);
  }
  const geometry = b.geometry as Record<string, unknown> | undefined;
  if (!geometry || !Array.isArray(geometry.wallRuns) || geometry.wallRuns.length === 0) {
    throw new DesignInputError("geometry.wallRuns must be a non-empty array");
  }
  const wallRuns = geometry.wallRuns.map((w, i) => parseWallRun(w, `geometry.wallRuns[${i}]`));

  let ceilingHeight: { value: number; provenance?: Provenance } | undefined;
  if (geometry.ceilingHeight !== undefined) {
    const ch = geometry.ceilingHeight as Record<string, unknown>;
    ceilingHeight = {
      value: requirePositiveNumber(ch.value, "geometry.ceilingHeight.value"),
      provenance: assertProvenance(ch.provenance, "geometry.ceilingHeight.provenance"),
    };
  }

  const appliancesRaw = b.appliances;
  if (appliancesRaw !== undefined && !Array.isArray(appliancesRaw)) {
    throw new DesignInputError("appliances must be an array");
  }
  const appliances = Array.isArray(appliancesRaw)
    ? appliancesRaw.map((a, i) => parseAppliance(a, `appliances[${i}]`))
    : undefined;

  return {
    schemaVersion: DESIGN_INPUT_SCHEMA_VERSION,
    source: (b.source ?? undefined) as DesignInputDocument["source"],
    geometry: {
      wallRuns,
      ceilingHeight,
      confidence: typeof geometry.confidence === "number" ? geometry.confidence : undefined,
    },
    appliances,
  };
}

export interface ApplyDesignInputResult {
  plan: FloorPlan;
  /** 有多少项因为 provenance !== "customer" 仍需走确认——用于会话复述。 */
  pendingConfirmCount: number;
}

/**
 * 把校验过的导入体套用成一份 FloorPlan。
 *
 * 与模板预填（FR-17.4）同一套规则：`provenance: "customer"` 的项直接采信、
 * 不生成待确认项；其余（含未声明）都生成一条 `unresolvedItems`，走 Q# 确认。
 */
export function applyDesignInput(
  conversationId: string,
  doc: DesignInputDocument,
  at: string,
  carriedAppliances: ApplianceSpec[] = [],
): ApplyDesignInputResult {
  let plan = createChatSourcedFloorPlan(conversationId, at);
  plan = {
    ...plan,
    sourceFile: { name: "design-input.json", mimeType: "application/json", sizeBytes: JSON.stringify(doc).length },
    parsedGeometry: { ...plan.parsedGeometry, confidence: doc.geometry.confidence ?? 0.9 },
    parseConfidence: doc.geometry.confidence ?? 0.9,
  };

  const confirmItems: FloorPlanUnresolved[] = [];

  for (const w of doc.geometry.wallRuns) {
    plan = addWallRun(plan, {
      label: w.label,
      length: w.length,
      ...(w.kind ? { kind: w.kind } : {}),
      ...(w.depth !== undefined ? { depth: w.depth } : {}),
      ...(w.startsAtCorner !== undefined ? { startsAtCorner: w.startsAtCorner } : {}),
      ...(w.endsAtCorner !== undefined ? { endsAtCorner: w.endsAtCorner } : {}),
    }, at);
    const runId = plan.parsedGeometry.wallRuns[plan.parsedGeometry.wallRuns.length - 1]!.id;

    if (provenanceOf(w.provenance) === "assumed") {
      confirmItems.push({
        id: `imp_${randomUUID().slice(0, 8)}`,
        target: { kind: "wallRun", id: runId },
        field: "length",
        reason: `Confirm "${w.label}" is about ${quantize(w.length)}" (from imported design data).`,
        suggestion: w.length,
        resolved: false,
      });
    }

    for (const f of w.features) {
      plan = addFeature(plan, runId, {
        kind: f.kind, offset: f.offset, width: f.width, sillHeight: f.sillHeight, note: f.note,
      }, at);
      if (provenanceOf(f.provenance) === "assumed") {
        const run = plan.parsedGeometry.wallRuns.find((r) => r.id === runId)!;
        const featureId = run.features[run.features.length - 1]!.id;
        confirmItems.push({
          id: `imp_${randomUUID().slice(0, 8)}`,
          target: { kind: "feature", id: featureId },
          field: f.kind,
          reason: `Confirm the ${f.kind} on "${w.label}" (from imported design data) `
            + `— offset ${quantize(f.offset)}", width ${quantize(f.width)}".`,
          suggestion: f.offset,
          resolved: false,
        });
      }
    }
  }

  if (doc.geometry.ceilingHeight) {
    plan = resolveCeilingHeight(plan, doc.geometry.ceilingHeight.value, at);
    if (provenanceOf(doc.geometry.ceilingHeight.provenance) === "assumed") {
      confirmItems.push({
        id: `imp_${randomUUID().slice(0, 8)}`,
        target: { kind: "global" },
        field: "ceilingHeight",
        reason: `Confirm ceiling height is about ${quantize(doc.geometry.ceilingHeight.value)}" `
          + `(from imported design data).`,
        suggestion: doc.geometry.ceilingHeight.value,
        resolved: false,
      });
    }
  }

  const appliances = doc.appliances && doc.appliances.length > 0
    ? normalizeAppliances(doc.appliances)
    : carriedAppliances;

  plan = {
    ...plan,
    unresolvedItems: [...plan.unresolvedItems, ...confirmItems],
    ...(appliances.length > 0 ? { appliances } : {}),
    updatedAt: at,
  };

  return { plan, pendingConfirmCount: confirmItems.length };
}

// ── 导出 ──────────────────────────────────────────────────────────────────

/**
 * 这段墙的长度是否已确认（无待处理项）——导出用，也被 `chat-site-answers.ts`
 * 的"确认锁"复用：已确认的字段不许被聊天解析静默覆盖（见 `confirm-lock.ts`）。
 */
export function wallRunProvenance(plan: FloorPlan, wallRunId: string): Provenance {
  return isWallLengthPending(plan, wallRunId) ? "assumed" : "customer";
}

export function featureProvenance(plan: FloorPlan, featureId: string): Provenance {
  const pending = plan.unresolvedItems.some(
    (u) => !u.resolved && u.target.kind === "feature" && u.target.id === featureId,
  );
  return pending ? "assumed" : "customer";
}

export function ceilingHeightProvenance(plan: FloorPlan): Provenance {
  const pending = plan.unresolvedItems.some(
    (u) => !u.resolved && u.target.kind === "global" && u.field === "ceilingHeight",
  );
  return pending ? "assumed" : "customer";
}

/**
 * 把当前 FloorPlan 序列化成同一套 schema——供导出给另一套系统，或供客户
 * 换设备/换会话时把已确认的结果原样带走。
 *
 * provenance 由当前 `unresolvedItems` 的状态**推出来**，不另存一份——避免
 * 出现"字段值已改、provenance 标记忘了同步"的漂移。
 */
export function exportDesignInput(plan: FloorPlan): DesignInputDocument {
  const wallRuns: DesignInputWallRun[] = plan.parsedGeometry.wallRuns.map((r: WallRun) => ({
    label: r.label,
    length: r.length,
    ...(r.kind ? { kind: r.kind } : {}),
    ...(r.depth !== undefined ? { depth: r.depth } : {}),
    startsAtCorner: r.startsAtCorner,
    endsAtCorner: r.endsAtCorner,
    provenance: wallRunProvenance(plan, r.id),
    features: r.features.map((f) => ({
      kind: f.kind,
      offset: f.offset,
      width: f.width,
      ...(f.sillHeight !== undefined ? { sillHeight: f.sillHeight } : {}),
      ...(f.note !== undefined ? { note: f.note } : {}),
      provenance: featureProvenance(plan, f.id),
    })),
  }));

  return {
    schemaVersion: DESIGN_INPUT_SCHEMA_VERSION,
    source: { kind: "export", producer: "rta-hub", generatedAt: new Date().toISOString() },
    geometry: {
      wallRuns,
      ...(plan.parsedGeometry.ceilingHeight !== undefined
        ? { ceilingHeight: { value: plan.parsedGeometry.ceilingHeight, provenance: ceilingHeightProvenance(plan) } }
        : {}),
      confidence: plan.parsedGeometry.confidence,
    },
    ...(plan.appliances && plan.appliances.length > 0 ? { appliances: plan.appliances } : {}),
  };
}
