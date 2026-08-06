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
  EstimateDraft, EstimateDraftLine, GenericCatalog, ModuleType, Province,
} from "../domain/types.js";
import { resolveTaxRule } from "../pricing/tax.js";
import type { TaxRule } from "../domain/types.js";

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
