/**
 * 本轮刚从"未确认"变成"已确认"的具体数字——用来在回复里加一句弱确认复述
 * （见 orchestrator.ts 的 `intakeStatus.justConfirmed`）。
 *
 * 跟 `readiness.ts` 的 `confirmedFacts`/`confirmedBriefs` 不是一回事：那两个
 * 是"全量已确认清单"，用来告诉模型"这些别再问了"；这里只要**这一轮新增的**，
 * 用来告诉客户"你刚说的这句，我记下了什么"——每轮都报全量清单会很啰嗦，
 * 只报这一轮变化的才像正常对话里的一句回应。
 */
import { ceilingHeightProvenance, wallRunProvenance } from "../floorplan/design-input.js";
import { applianceLabel } from "../floorplan/appliances.js";
import type { FloorPlan } from "../floorplan/types.js";
import { DEFAULT_LANGUAGE, type UiLanguage } from "../i18n/language.js";

/** 这一轮之前，这段墙的长度是否已经是"已确认"状态、且就是这个值。 */
function wallAlreadyConfirmed(plan: FloorPlan | undefined, runId: string, length: number): boolean {
  if (!plan) return false;
  const run = plan.parsedGeometry.wallRuns.find((r) => r.id === runId);
  return Boolean(run && run.length === length && wallRunProvenance(plan, runId) === "customer");
}

/** 这一轮之前，这段墙上是否已经有这个位置的燃气/强电接口。 */
function featureAlreadyConfirmed(
  plan: FloorPlan | undefined,
  kind: "gas" | "electrical",
  wallRunId: string,
  offset: number,
): boolean {
  if (!plan) return false;
  const run = plan.parsedGeometry.wallRuns.find((r) => r.id === wallRunId);
  return Boolean(run && run.features.some((f) => f.kind === kind && f.offset === offset));
}

export function justConfirmedNotes(
  before: FloorPlan | undefined,
  after: FloorPlan | undefined,
  language: UiLanguage = DEFAULT_LANGUAGE,
): string[] {
  if (!after) return [];
  const notes: string[] = [];

  for (const r of after.parsedGeometry.wallRuns) {
    if (r.length <= 0) continue;
    if (wallRunProvenance(after, r.id) !== "customer") continue;
    if (wallAlreadyConfirmed(before, r.id, r.length)) continue;
    notes.push(language === "zh" ? `${r.label} ${r.length}寸` : `${r.label} ${r.length}"`);
  }

  const ceil = after.parsedGeometry.ceilingHeight;
  if (ceil != null && ceilingHeightProvenance(after) === "customer") {
    const beforeCeil = before?.parsedGeometry.ceilingHeight;
    const beforeConfirmed = beforeCeil === ceil && Boolean(before) && ceilingHeightProvenance(before!) === "customer";
    if (!beforeConfirmed) {
      notes.push(language === "zh" ? `层高 ${ceil}寸` : `ceiling ${ceil}"`);
    }
  }

  for (const a of after.appliances ?? []) {
    if (a.provenance !== "customer") continue;
    const prev = before?.appliances?.find((b) => b.kind === a.kind);
    if (prev && prev.width === a.width && prev.provenance === "customer") continue;
    const name = applianceLabel(a.kind, language === "zh" ? "zh" : "en");
    notes.push(language === "zh" ? `${name} ${a.width}寸` : `${name} ${a.width}"`);
  }

  for (const kind of ["gas", "electrical"] as const) {
    for (const r of after.parsedGeometry.wallRuns) {
      for (const f of r.features.filter((x) => x.kind === kind)) {
        if (featureAlreadyConfirmed(before, kind, r.id, f.offset)) continue;
        const label = kind === "gas"
          ? (language === "zh" ? "燃气接口" : "gas hookup")
          : (language === "zh" ? "强电接口" : "electrical hookup");
        notes.push(language === "zh" ? `${r.label} ${label}` : `${label} on ${r.label}`);
      }
    }
  }

  return notes;
}
