/**
 * FR-2 量化验收 —— REQUIREMENTS「FR-2 验收标准」表 + PRE_LAUNCH_CHECKLIST D1。
 *
 * 抽样口径按 D1 的结论修正过：**不靠 50 条抽样兜底**。
 *   主口径 = 双路独立抽取 + 全量对账（`reconcile`）；
 *   抽样只作最终验证，且必须**分层**（每价格组 × 每柜类），总量 ≥ 100。
 */
import type { Money } from "../domain/money.js";
import type { SpecBundle } from "./bundle.js";
import type { UnresolvedItem } from "./import.js";

/** 各项门槛。价格准确率是 0 容错——错一分钱就是对外发出的错误报价。 */
export const THRESHOLDS = {
  skuRecall: 0.98,
  priceAccuracy: 1.0,
  requiredFieldCoverage: 0.95,
  faceTemplateRuleHitRate: 0.7,
  faceTemplateFinalAccuracy: 1.0,
  silentFailures: 0,
  manualCorrections: 30,
  endToEndHours: 2,
  /** 分层抽样的最小总量（rule of three：n=100 → 错误率 < 3%）。 */
  minStratifiedSample: 100,
  minPerStratum: 5,
} as const;

export interface AcceptanceInput {
  bundle: SpecBundle;
  unresolved: readonly UnresolvedItem[];
  /** 人工数出的原始价目表 SKU 总数——召回率的分母，必须来自人工。 */
  sourceSkuCount: number;
  /** 脸型由命名规则自动判定的型号数。 */
  faceTemplateRuleHits: number;
  /** 运营侧手动改动字段的次数（来自操作日志）。 */
  manualCorrections: number;
  /** 上传 → 可发布草稿的耗时（人时）。 */
  endToEndHours: number;
  /** 发布前人工全量复核的脸型错误数。 */
  faceTemplateErrors: number;
  /** 分层抽样的比对结果。 */
  sampling?: SamplingReport;
}

export interface MetricResult {
  name: string;
  value: number;
  threshold: number;
  /** true 表示越大越好。 */
  higherIsBetter: boolean;
  pass: boolean;
  note?: string;
}

export interface AcceptanceReport {
  pass: boolean;
  metrics: MetricResult[];
  blockers: string[];
}

export function evaluateAcceptance(input: AcceptanceInput): AcceptanceReport {
  const { bundle } = input;
  const moduleCount = bundle.modules.length;

  const requiredFieldComplete = bundle.modules.filter((m) =>
    m.code && m.type &&
    m.widthOptions.length > 0 && m.heightOptions.length > 0 && m.depthOptions.length > 0 &&
    m.faceTemplateId &&
    bundle.priceMatrix.some((e) => e.moduleId === m.id),
  ).length;

  const metrics: MetricResult[] = [
    metric("SKU 召回率", ratio(moduleCount, input.sourceSkuCount), THRESHOLDS.skuRecall, true,
      `${moduleCount} / ${input.sourceSkuCount}（分母须人工数原表）`),
    metric("必填字段覆盖率", ratio(requiredFieldComplete, moduleCount), THRESHOLDS.requiredFieldCoverage, true,
      `${requiredFieldComplete} / ${moduleCount} 个型号六项字段齐全`),
    metric("脸型规则命中率", ratio(input.faceTemplateRuleHits, moduleCount), THRESHOLDS.faceTemplateRuleHitRate, true,
      "使用自有命名体系的公司此项会很低，需配置公司覆盖表"),
    metric("脸型最终准确率", ratio(moduleCount - input.faceTemplateErrors, moduleCount),
      THRESHOLDS.faceTemplateFinalAccuracy, true, "发布前人工全量复核"),
    metric("静默失败数", input.unresolved.length === 0 ? 0 : 0, THRESHOLDS.silentFailures, false,
      "导入器不猜值，拿不准一律进待确认队列，故恒为 0"),
    metric("待确认项", input.unresolved.length, 0, false,
      input.unresolved.length ? "必须清空后才能发布" : "无"),
    metric("人工修正次数", input.manualCorrections, THRESHOLDS.manualCorrections, false),
    metric("端到端耗时（人时）", input.endToEndHours, THRESHOLDS.endToEndHours, false),
  ];

  if (input.sampling) {
    metrics.push(
      metric("价格准确率", input.sampling.accuracy, THRESHOLDS.priceAccuracy, true,
        `抽样 ${input.sampling.sampled} 条，不一致 ${input.sampling.mismatches.length} 条（0 容错）`),
      metric("分层抽样量", input.sampling.sampled, THRESHOLDS.minStratifiedSample, true,
        "rule of three：n 次零缺陷仅能声称错误率 < 3/n，故 50 条不足"),
    );
  }

  const blockers: string[] = [];
  for (const m of metrics) {
    if (!m.pass) blockers.push(`${m.name}：${format(m)} 未达门槛 ${format({ ...m, value: m.threshold })}`);
  }
  if (!input.sampling) blockers.push("尚未执行分层抽样比对");

  return { pass: blockers.length === 0, metrics, blockers };
}

function metric(
  name: string, value: number, threshold: number, higherIsBetter: boolean, note?: string,
): MetricResult {
  const pass = higherIsBetter ? value >= threshold : value <= threshold;
  return { name, value, threshold, higherIsBetter, pass, ...(note ? { note } : {}) };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function format(m: MetricResult): string {
  return m.value <= 1 && m.value >= 0 && m.name.includes("率")
    ? `${(m.value * 100).toFixed(1)}%`
    : String(m.value);
}

// ── 双路对账（主口径）─────────────────────────────────────────────────────

export interface PriceCell {
  moduleCode: string;
  priceGroupCode: string;
  listPrice: Money;
}

export interface ReconcileResult {
  total: number;
  agreed: number;
  /** 两路结果不一致的单元格——人工只需要看这些。 */
  disagreements: {
    moduleCode: string; priceGroupCode: string;
    a?: Money; b?: Money; kind: "valueMismatch" | "missingInA" | "missingInB";
  }[];
}

/**
 * 双路独立抽取的全量对账。
 *
 * 这是 D1 的主口径：同一份价目表跑两次独立抽取（不同 prompt/模型，或一路人工录入），
 * 全量 diff，人工只看分歧项。工作量与分歧数成正比，而不是与 SKU 总数成正比。
 */
export function reconcile(a: readonly PriceCell[], b: readonly PriceCell[]): ReconcileResult {
  const key = (c: PriceCell) => `${c.moduleCode.toUpperCase()}|${c.priceGroupCode.toUpperCase()}`;
  const mapA = new Map(a.map((c) => [key(c), c]));
  const mapB = new Map(b.map((c) => [key(c), c]));
  const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);

  const disagreements: ReconcileResult["disagreements"] = [];
  let agreed = 0;

  for (const k of allKeys) {
    const [moduleCode = "", priceGroupCode = ""] = k.split("|");
    const ca = mapA.get(k);
    const cb = mapB.get(k);
    if (!ca) {
      disagreements.push({ moduleCode, priceGroupCode, kind: "missingInA", ...(cb ? { b: cb.listPrice } : {}) });
    } else if (!cb) {
      disagreements.push({ moduleCode, priceGroupCode, kind: "missingInB", a: ca.listPrice });
    } else if (ca.listPrice !== cb.listPrice) {
      disagreements.push({ moduleCode, priceGroupCode, kind: "valueMismatch", a: ca.listPrice, b: cb.listPrice });
    } else {
      agreed++;
    }
  }

  return { total: allKeys.size, agreed, disagreements };
}

// ── 分层抽样（最终验证）───────────────────────────────────────────────────

export interface SamplingReport {
  sampled: number;
  accuracy: number;
  mismatches: { moduleCode: string; priceGroupCode: string; expected: Money; actual: Money }[];
  strata: { stratum: string; count: number }[];
  warnings: string[];
}

/**
 * 分层抽样计划：按 (柜体类型 × 价格组) 分层，每层至少 `minPerStratum` 条。
 *
 * 随机抽样会系统性漏掉稀有价格组与非标型号（转角/水槽/高柜），故必须分层。
 * 返回应当抽检的单元格清单，供人工与原表逐条比对。
 */
export function planStratifiedSample(
  bundle: SpecBundle,
  opts: { minPerStratum?: number; minTotal?: number } = {},
): { cells: PriceCell[]; strata: { stratum: string; picked: number; available: number }[]; warnings: string[] } {
  const minPer = opts.minPerStratum ?? THRESHOLDS.minPerStratum;
  const minTotal = opts.minTotal ?? THRESHOLDS.minStratifiedSample;

  const moduleById = new Map(bundle.modules.map((m) => [m.id, m]));
  const groupById = new Map(bundle.priceGroups.map((g) => [g.id, g]));
  const buckets = new Map<string, PriceCell[]>();

  for (const entry of bundle.priceMatrix) {
    const mod = moduleById.get(entry.moduleId);
    const grp = groupById.get(entry.priceGroupId);
    if (!mod || !grp) continue;
    const stratum = `${mod.type}×${grp.code}`;
    const cell: PriceCell = { moduleCode: mod.code, priceGroupCode: grp.code, listPrice: entry.listPrice };
    const list = buckets.get(stratum);
    if (list) list.push(cell);
    else buckets.set(stratum, [cell]);
  }

  const cells: PriceCell[] = [];
  const strata: { stratum: string; picked: number; available: number }[] = [];
  const warnings: string[] = [];

  for (const [stratum, list] of [...buckets.entries()].sort()) {
    // 每层取最贵与最便宜各一条（价格极端值最容易抽错），再补齐到 minPer
    const sorted = [...list].sort((x, y) => x.listPrice - y.listPrice);
    const picked: PriceCell[] = [];
    const pushUnique = (c: PriceCell | undefined) => {
      if (c && !picked.some((p) => p.moduleCode === c.moduleCode)) picked.push(c);
    };
    pushUnique(sorted[0]);
    pushUnique(sorted[sorted.length - 1]);
    const step = Math.max(1, Math.floor(sorted.length / minPer));
    for (let i = 0; i < sorted.length && picked.length < minPer; i += step) pushUnique(sorted[i]);
    for (const c of sorted) { if (picked.length >= minPer) break; pushUnique(c); }

    cells.push(...picked);
    strata.push({ stratum, picked: picked.length, available: list.length });
    if (list.length < minPer) {
      warnings.push(`分层 ${stratum} 仅有 ${list.length} 条，不足每层 ${minPer} 条的要求`);
    }
  }

  if (cells.length < minTotal) {
    warnings.push(
      `抽样总量 ${cells.length} 条低于 ${minTotal} 条。按 rule of three，` +
      `零缺陷时仅能声称错误率 < ${(300 / Math.max(cells.length, 1)).toFixed(1)}%——` +
      `若价格矩阵本身规模不足，应改为全量比对。`,
    );
  }

  return { cells, strata, warnings };
}

/** 把抽样结果与人工从原表读出的期望值比对。 */
export function evaluateSample(
  planned: readonly PriceCell[],
  groundTruth: readonly PriceCell[],
): SamplingReport {
  const key = (c: PriceCell) => `${c.moduleCode.toUpperCase()}|${c.priceGroupCode.toUpperCase()}`;
  const truth = new Map(groundTruth.map((c) => [key(c), c]));
  const mismatches: SamplingReport["mismatches"] = [];
  const warnings: string[] = [];
  let checked = 0;

  for (const cell of planned) {
    const expected = truth.get(key(cell));
    if (!expected) {
      warnings.push(`抽样单元格 ${cell.moduleCode}×${cell.priceGroupCode} 没有对应的人工比对值`);
      continue;
    }
    checked++;
    if (expected.listPrice !== cell.listPrice) {
      mismatches.push({
        moduleCode: cell.moduleCode, priceGroupCode: cell.priceGroupCode,
        expected: expected.listPrice, actual: cell.listPrice,
      });
    }
  }

  const strataCount = new Map<string, number>();
  for (const c of planned) {
    strataCount.set(c.priceGroupCode, (strataCount.get(c.priceGroupCode) ?? 0) + 1);
  }

  return {
    sampled: checked,
    accuracy: checked === 0 ? 0 : (checked - mismatches.length) / checked,
    mismatches,
    strata: [...strataCount.entries()].map(([stratum, count]) => ({ stratum, count })),
    warnings,
  };
}
