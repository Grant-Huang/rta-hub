/**
 * 冷启动通用预估 —— FR-10、SCENARIOS 场景 B。
 *
 * 设计要点：
 *   - `EstimateDraft` **没有 companyId**，因此结构上不可能进入发送闸门（FR-8 第 4 条）。
 *     这不是靠一条校验规则，而是靠类型里根本没有那个字段。
 *   - 给**区间**不给精确数字——避免"报低吸引、真实报价高很多"的信任风险。
 *   - `disclaimer` 必须与 `GenericCatalog.sourceNote` 的真实来源一致；
 *     来源尚未定案时（开放问题 5），文案必须如实说明这一点。
 */
import { add, format, mulQty, percentOf, type Money } from "../domain/money.js";
import type {
  EstimateDraft, EstimateDraftLine, GenericCatalog, ModuleSpec, ModuleType, Province,
} from "../domain/types.js";
import { resolveTaxRule } from "../pricing/tax.js";
import type { TaxRule } from "../domain/types.js";
import type { ParsedGeometry } from "../floorplan/types.js";
import { generateLayout } from "../layout/generate.js";
import { renderFourViews, type FourViews, type ViewStyle } from "../render/views.js";
import { matchFaceTemplate } from "../render/templates.js";

export interface EstimateRequest {
  conversationId: string;
  /** 各柜类的数量。 */
  moduleCounts: Partial<Record<ModuleType, number>>;
  /** 省份——用于给出含税区间；不给则只给未税区间。 */
  province?: Province;
  at: string;
}

export interface EstimateOptions {
  taxRules?: readonly TaxRule[];
  /** 来源是否已经过核实。未核实时 disclaimer 会额外说明。 */
  sourceVerified?: boolean;
}

let seq = 0;

export function buildEstimateDraft(
  catalog: GenericCatalog,
  req: EstimateRequest,
  opts: EstimateOptions = {},
): EstimateDraft {
  const lineItems: EstimateDraftLine[] = [];

  for (const [type, qty] of Object.entries(req.moduleCounts) as [ModuleType, number][]) {
    if (!qty || qty <= 0) continue;
    const entry = catalog.modules.find((m) => m.type === type);
    if (!entry) continue; // 目录里没有这个柜类就跳过，不臆造区间
    lineItems.push({
      moduleType: type,
      qty,
      estimatedPriceRange: {
        low: mulQty(entry.typicalPriceRange.low, qty),
        high: mulQty(entry.typicalPriceRange.high, qty),
      },
    });
  }

  let low = add(...lineItems.map((l) => l.estimatedPriceRange.low));
  let high = add(...lineItems.map((l) => l.estimatedPriceRange.high));

  let taxNote = "";
  if (req.province && opts.taxRules?.length) {
    try {
      const rule = resolveTaxRule(opts.taxRules, req.province, req.at);
      const rate = rule.components.reduce((s, c) => s + c.ratePercent, 0);
      low = add(low, percentOf(low, rate));
      high = add(high, percentOf(high, rate));
      taxNote = `，已按 ${req.province} ${rate}% 税率含税`;
    } catch {
      taxNote = "";
    }
  }

  return {
    id: `est_${Date.now().toString(36)}_${(seq++).toString(36)}`,
    conversationId: req.conversationId,
    basedOn: "genericCatalog",
    lineItems,
    totalRange: { low, high },
    disclaimer: buildDisclaimer(catalog, taxNote, opts.sourceVerified ?? false),
    createdAt: req.at,
  };
}

/**
 * 免责声明。
 *
 * 如果 `GenericCatalog` 的数据来源还没定案（开放问题 5 / 检查清单 A4），
 * 文案必须**如实说明这是构造的占位区间**——不能一边用占位数据一边宣称"行业典型区间"。
 */
function buildDisclaimer(catalog: GenericCatalog, taxNote: string, sourceVerified: boolean): string {
  const head = "以上为行业典型区间，**不是任何具体公司的真实报价**。";
  const body = sourceVerified
    ? `区间来自平台维护的行业基准目录${taxNote}。实际价格取决于公司、门板样式、五金配置与安装条件。`
    : `⚠️ 当前区间为**未经核实的占位数据**（来源：${catalog.sourceNote}）${taxNote}，仅供感知量级，不应作为决策依据。`;
  return `${head}${body}`;
}

/** MVP-1 的纯文本呈现（四视图版本在 MVP-2，复用同一套脸型模板）。 */
export function renderEstimateText(draft: EstimateDraft): string {
  const typeNames: Record<string, string> = {
    base: "地柜", wall: "吊柜", tall: "高柜", corner: "转角柜", sinkBase: "水槽柜",
    filler: "填缝条", panel: "饰面板", toeKick: "踢脚板", crown: "顶角线",
  };
  const rows = draft.lineItems.map((l) =>
    `  ${(typeNames[l.moduleType] ?? l.moduleType).padEnd(6)} × ${String(l.qty).padStart(2)}   ` +
    `${format(l.estimatedPriceRange.low)} – ${format(l.estimatedPriceRange.high)}`,
  );
  return [
    "通用预估（非具体公司报价）",
    "────────────────────────────",
    ...rows,
    "────────────────────────────",
    `  合计区间   ${format(draft.totalRange.low)} – ${format(draft.totalRange.high)}`,
    "",
    draft.disclaimer,
  ].join("\n");
}

/**
 * 结构性保证：`EstimateDraft` 不可能被发送。
 *
 * 这个函数存在的意义是把「为什么不需要额外防护」写成可执行的断言——
 * 它没有 companyId，也就没有收件地址（FR-8 第 4 条 / 场景 B 第 5 点）。
 */
export function isSendable(draft: EstimateDraft): false {
  void draft;
  return false;
}

/** 从需求文本里粗略估算各柜类数量——MVP-1 没有户型图解析（FR-3 在 MVP-2）。 */
export function estimateCountsFromText(text: string): Partial<Record<ModuleType, number>> {
  // 找一个「厨房长度（英尺）」的线索，按行业经验折算柜体数量
  const feet = /(\d+(?:\.\d+)?)\s*(?:尺|英尺|ft|feet|')/i.exec(text);
  const meters = /(\d+(?:\.\d+)?)\s*(?:米|m\b)/i.exec(text);
  const runFeet = feet ? Number(feet[1]) : meters ? Number(meters[1]) * 3.28 : 12;

  // 一趟标准厨房：地柜按 2 尺一个、吊柜按 2.5 尺一个估
  const baseCount = Math.max(2, Math.round(runFeet / 2));
  const wallCount = Math.max(2, Math.round(runFeet / 2.5));

  return {
    base: Math.max(1, baseCount - 1), // 留一个位置给水槽柜
    sinkBase: 1,
    wall: wallCount,
    ...(runFeet >= 12 ? { tall: 1 } : {}),
    ...(runFeet >= 10 ? { corner: 1 } : {}),
  };
}


// ── 含四视图的版本（MVP-2）────────────────────────────────────────────────

/**
 * 把 `GenericCatalog` 的尺寸档位转成"伪型号"，好让排布算法与渲染管线复用。
 *
 * 这些型号**不属于任何公司**（companyId 为空），因此不可能通过 FR-8 校验、
 * 也就不可能进入报价与发送闸门——与 `EstimateDraft` 无 companyId 是同一个保障。
 */
export function catalogToPseudoModules(catalog: GenericCatalog): ModuleSpec[] {
  const codePrefix: Partial<Record<ModuleType, string>> = {
    base: "B", wall: "W", tall: "PC", sinkBase: "SB", corner: "BBC",
  };
  const out: ModuleSpec[] = [];
  for (const m of catalog.modules) {
    const prefix = codePrefix[m.type];
    if (!prefix) continue;
    for (const width of m.widthOptions) {
      // 用行业惯用命名，好让脸型规则匹配直接命中
      const code = m.type === "wall"
        ? `${prefix}${String(width).padStart(2, "0")}${m.heightOptions[0] ?? 30}`
        : `${prefix}${String(width).padStart(2, "0")}`;
      if (!matchFaceTemplate(code)) continue;
      out.push({
        id: `generic_${m.type}_${width}`,
        specVersionId: "generic",
        companyId: "",          // ★ 不属于任何公司
        code,
        type: m.type,
        widthOptions: [width],
        heightOptions: m.heightOptions,
        depthOptions: m.depthOptions,
        faceTemplateId: matchFaceTemplate(code)!.templateId,
        assemblyOptions: ["RTA"],
      });
    }
  }
  return out;
}

export interface IllustratedEstimate {
  draft: EstimateDraft;
  /** 每段墙的四视图示意——与 Quote 复用同一套脸型模板渲染逻辑（场景 B 第 4 点）。 */
  viewsByRun: { runLabel: string; views: FourViews }[];
  /** 示意图的免责说明——它画的是通用尺寸，不是任何公司的真实型号。 */
  viewsDisclaimer: string;
}

/**
 * 含四视图的通用预估（MVP-2 升级，场景 B 第 4 点）。
 *
 * 复用跟 `Quote` 完全一样的排布 + 脸型模板渲染，只是数据源换成 `GenericCatalog`。
 * 视图另加一句免责：画的是行业通用尺寸，不对应任何公司的真实型号。
 */
export function buildIllustratedEstimate(
  catalog: GenericCatalog,
  geometry: ParsedGeometry,
  req: Omit<EstimateRequest, "moduleCounts"> & { moduleCounts?: EstimateRequest["moduleCounts"] },
  opts: EstimateOptions & { viewStyle?: ViewStyle } = {},
): IllustratedEstimate {
  const pseudoModules = catalogToPseudoModules(catalog);
  const layout = generateLayout(geometry, pseudoModules, {
    ...(geometry.ceilingHeight !== undefined ? { ceilingHeight: geometry.ceilingHeight } : {}),
  });

  // 数量优先取排布结果（比从文本粗估准得多）
  const counts: Partial<Record<ModuleType, number>> = { ...req.moduleCounts };
  if (layout.moduleCounts.length > 0) {
    for (const key of Object.keys(counts) as ModuleType[]) delete counts[key];
    for (const m of layout.moduleCounts) {
      const mod = pseudoModules.find((p) => p.id === m.moduleId);
      if (!mod) continue;
      counts[mod.type] = (counts[mod.type] ?? 0) + m.qty;
    }
  }

  const draft = buildEstimateDraft(catalog, { ...req, moduleCounts: counts }, opts);

  return {
    draft,
    viewsByRun: geometry.wallRuns.map((run) => ({
      runLabel: run.label,
      views: renderFourViews(run, layout.placements, opts.viewStyle),
    })),
    viewsDisclaimer:
      "示意图按行业通用尺寸档位绘制，**不对应任何具体公司的真实型号**。" +
      "选定公司后，系统会用该公司规格库里真实存在的型号重新排布并出图。",
  };
}
