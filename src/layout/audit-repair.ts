/**
 * 出图 audit 失败时的定向修复策略 —— 按阻断 SR 选钩子，而非只轮换 drawerBias。
 *
 * 仍失败则由调用方走 adjusting 叙事 + 不泄半成品（FR-14）。
 */
import type { AuditReport } from "../delivery/audit.js";
import type { SanityRuleId } from "../delivery/sanity-rules.js";
import type { ParsedGeometry, WallRun } from "../floorplan/types.js";
import { isIsland, quantize } from "../floorplan/types.js";
import type { LayoutOptions } from "./generate.js";

export type RepairStrategyKind =
  | "shrinkIsland"
  | "preferNoCooktopBase"
  | "drawerBias"
  | "clearIslandBoost";

export interface RepairStrategy {
  kind: RepairStrategyKind;
  /** 关联的阻断 SR（便于日志 / 叙事）。 */
  rules: SanityRuleId[];
  /** shrinkIsland 时缩短岛台的英寸数。 */
  shrinkInches?: number;
  drawerBias?: NonNullable<LayoutOptions["drawerBias"]>;
  label: string;
}

const BIAS_CYCLE: NonNullable<LayoutOptions["drawerBias"]>[] = [
  "highUseOnly",
  "always",
  "never",
];

/** 从 audit blockers 收集去重后的 SR id。 */
export function blockingRules(report: AuditReport): SanityRuleId[] {
  return [...new Set(
    report.blockers.map((b) => b.rule).filter((r): r is SanityRuleId => Boolean(r)),
  )];
}

/**
 * 按阻断 SR 生成有序修复策略（去重）；末尾总有 drawerBias 软扰动兜底。
 */
export function repairStrategiesFor(report: AuditReport): RepairStrategy[] {
  const rules = blockingRules(report);
  const set = new Set(rules);
  const out: RepairStrategy[] = [];
  const push = (s: RepairStrategy) => {
    if (out.some((x) => x.label === s.label)) return;
    out.push(s);
  };

  if (set.has("SR-E5")) {
    push({
      kind: "shrinkIsland",
      rules: ["SR-E5"],
      shrinkInches: 12,
      label: "shrinkIsland:12",
    });
    push({
      kind: "shrinkIsland",
      rules: ["SR-E5"],
      shrinkInches: 24,
      label: "shrinkIsland:24",
    });
    push({
      kind: "clearIslandBoost",
      rules: ["SR-E5"],
      label: "clearIslandBoost",
    });
  }

  if (set.has("SR-E2") || set.has("SR-E3")) {
    const hit = (["SR-E2", "SR-E3"] as const).filter((r) => set.has(r));
    push({
      kind: "preferNoCooktopBase",
      rules: hit,
      label: "preferNoCooktopBase",
    });
  }

  // 转角干涉 / 让位：换装箱宽度分布（抽屉倾向）往往能挪开碰撞盒
  if (set.has("SR-G3") || set.has("SR-G5")) {
    const hit = (["SR-G3", "SR-G5"] as const).filter((r) => set.has(r));
    for (const bias of ["never", "always"] as const) {
      push({
        kind: "drawerBias",
        rules: hit,
        drawerBias: bias,
        label: `drawerBias:${bias}:corner`,
      });
    }
  }

  // 水槽落台 / 洗碗机 / 连续备餐：换抽屉倾向腾出连续台面
  if (set.has("SR-E1") || set.has("SR-E4") || set.has("SR-E8")) {
    const hit = (["SR-E1", "SR-E4", "SR-E8"] as const).filter((r) => set.has(r));
    for (const bias of ["never", "always"] as const) {
      push({
        kind: "drawerBias",
        rules: hit,
        drawerBias: bias,
        label: `drawerBias:${bias}:landing`,
      });
    }
  }

  // 兜底：与历史行为一致的 drawerBias 轮换
  for (const bias of BIAS_CYCLE) {
    push({
      kind: "drawerBias",
      rules: rules.length ? rules : (["SR-D2"] as SanityRuleId[]),
      drawerBias: bias,
      label: `drawerBias:${bias}:fallback`,
    });
  }

  return out;
}

export interface AppliedRepair {
  opts: LayoutOptions;
  /** 若缩短了岛台，返回改写后的几何（调用方在 audit 通过后可落库）。 */
  geometry?: ParsedGeometry;
  strategy: RepairStrategy;
}

/** 把一条策略叠到 LayoutOptions / 几何副本上。 */
export function applyRepairStrategy(
  base: LayoutOptions,
  geometry: ParsedGeometry,
  strategy: RepairStrategy,
): AppliedRepair {
  let opts: LayoutOptions = { ...base };
  let nextGeom: ParsedGeometry | undefined;

  switch (strategy.kind) {
    case "preferNoCooktopBase":
      opts = {
        ...opts,
        layoutHeuristic: {
          ...(opts.layoutHeuristic ?? {}),
          preferNoCooktopBase: true,
        },
      };
      break;
    case "drawerBias":
      opts = { ...opts, drawerBias: strategy.drawerBias ?? "highUseOnly" };
      break;
    case "clearIslandBoost":
      if (opts.layoutHints) {
        const { enlargeIslandInches: _drop, ...rest } = opts.layoutHints;
        opts = { ...opts, layoutHints: rest };
      }
      break;
    case "shrinkIsland": {
      const inches = strategy.shrinkInches ?? 12;
      const wallRuns = geometry.wallRuns.map((r) => shrinkIslandRun(r, inches));
      nextGeom = { ...geometry, wallRuns };
      break;
    }
    default:
      break;
  }

  return {
    opts,
    ...(nextGeom ? { geometry: nextGeom } : {}),
    strategy,
  };
}

function shrinkIslandRun(run: WallRun, inches: number): WallRun {
  if (!isIsland(run)) return run;
  const next = Math.max(24, quantize(run.length - inches));
  if (next >= run.length) return run;
  return { ...run, length: next };
}
