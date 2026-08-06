/**
 * 多公司价格对比 —— FR-6、场景 E 第 2 点。
 *
 * **只做价格层面的横向对比，不做图纸/视图并排对比**（v0.2 已关闭的问题 5）。
 *
 * 关键点（REQUIREMENTS FR-6 最后一句）：必须注明各家报价的**含税口径是否一致**，
 * 避免拿含税价和未税价直接比——这是同类平台上真实发生过的误导来源。
 */
import { add, format, sub, type Money } from "../domain/money.js";
import type { Quote } from "../domain/types.js";

export interface ComparisonRow {
  companyId: string;
  companyName: string;
  quoteId: string;
  status: Quote["status"];
  /** 未税小计（已扣折扣）。 */
  netBeforeTax: Money;
  shipping: Money;
  taxTotal: Money;
  total: Money;
  currency: string;
  /** 该报价用的门板与价格组——差价往往来自这里，不标出来就没法比。 */
  doorStyleId: string;
  priceGroupId: string;
  lineCount: number;
  validUntil: string;
  /** 与最低价的差额（正数表示更贵）。 */
  deltaFromLowest: Money;
}

export interface ComparisonWarning {
  code: "MIXED_TAX_BASIS" | "MIXED_CURRENCY" | "DIFFERENT_SCOPE" | "EXPIRED_QUOTE" | "DIFFERENT_PRICE_GROUP";
  message: string;
}

export interface QuoteComparison {
  conversationId: string;
  rows: ComparisonRow[];
  /** 全部报价是否口径一致（同币种、同含税口径、同型号范围）。 */
  comparable: boolean;
  warnings: ComparisonWarning[];
  lowestTotal?: Money;
  highestTotal?: Money;
  spread?: Money;
  generatedAt: string;
}

export interface CompanyNameLookup {
  (companyId: string): string | undefined;
}

/**
 * 生成对比表。
 *
 * 允许对 `draft` 状态的报价做对比——开放问题 3 倾向「随时可拉草稿对比」，
 * 等所有公司都确认完才给对比表会卡住客户最想做的那个动作。
 */
export function buildComparison(
  conversationId: string,
  quotes: readonly Quote[],
  nameOf: CompanyNameLookup,
  at: string,
): QuoteComparison {
  const warnings: ComparisonWarning[] = [];
  const usable = quotes.filter((q) => q.conversationId === conversationId);

  if (usable.length === 0) {
    return { conversationId, rows: [], comparable: true, warnings, generatedAt: at };
  }

  // ── 口径一致性检查 ──
  const currencies = new Set(usable.map((q) => q.currency));
  if (currencies.size > 1) {
    warnings.push({
      code: "MIXED_CURRENCY",
      message: `这几份报价的币种不一致（${[...currencies].join("、")}），总价不能直接比较。`,
    });
  }

  // 含税口径：全部含税或全部未税才算一致
  const withTax = usable.filter((q) => q.taxes.length > 0).length;
  if (withTax > 0 && withTax < usable.length) {
    warnings.push({
      code: "MIXED_TAX_BASIS",
      message: `有 ${withTax} 份报价含税、${usable.length - withTax} 份未税。` +
        "下表的「总计」列口径不一致，请以「未税小计」列做横向比较。",
    });
  }

  // 型号范围差异：行数差得多说明不是同一套方案
  const lineCounts = usable.map((q) => q.lineItems.reduce((s, l) => s + l.qty, 0));
  const minCount = Math.min(...lineCounts);
  const maxCount = Math.max(...lineCounts);
  if (minCount > 0 && maxCount > minCount * 1.25) {
    warnings.push({
      code: "DIFFERENT_SCOPE",
      message: `各家方案的柜体数量差异较大（${minCount}–${maxCount} 件），可能不是同一套配置，` +
        "总价差异未必反映单价差异。",
    });
  }

  const priceGroups = new Set(usable.map((q) => q.priceGroupId));
  if (priceGroups.size > 1) {
    warnings.push({
      code: "DIFFERENT_PRICE_GROUP",
      message: "各家选的门板落在不同价格组，价差有一部分来自门板档次而非公司本身。",
    });
  }

  for (const q of usable) {
    if (Date.parse(at) >= Date.parse(q.validUntil)) {
      warnings.push({
        code: "EXPIRED_QUOTE",
        message: `${nameOf(q.companyId) ?? q.companyId} 的报价已于 ${q.validUntil.slice(0, 10)} 过期，需重新生成。`,
      });
    }
  }

  const totals = usable.map((q) => q.total);
  const lowest = totals.reduce((a, b) => (b < a ? b : a));
  const highest = totals.reduce((a, b) => (b > a ? b : a));

  const rows: ComparisonRow[] = usable
    .map((q) => {
      const discountTotal = q.discounts.reduce((s, d) => s + d.amount, 0);
      const taxTotal = q.taxes.reduce((s, t) => s + t.amount, 0) as Money;
      return {
        companyId: q.companyId,
        companyName: nameOf(q.companyId) ?? q.companyId,
        quoteId: q.id,
        status: q.status,
        netBeforeTax: sub(q.subtotal, discountTotal as Money),
        shipping: q.shipping.amount,
        taxTotal,
        total: q.total,
        currency: q.currency,
        doorStyleId: q.doorStyleId,
        priceGroupId: q.priceGroupId,
        lineCount: q.lineItems.reduce((s, l) => s + l.qty, 0),
        validUntil: q.validUntil,
        deltaFromLowest: sub(q.total, lowest),
      };
    })
    .sort((a, b) => a.total - b.total);

  return {
    conversationId,
    rows,
    comparable: warnings.every((w) => w.code === "EXPIRED_QUOTE"),
    warnings,
    lowestTotal: lowest,
    highestTotal: highest,
    spread: sub(highest, lowest),
    generatedAt: at,
  };
}

/** 纯文本呈现，用于对话里直接回给客户。 */
export function renderComparisonText(cmp: QuoteComparison): string {
  if (cmp.rows.length === 0) return "还没有可对比的报价。";

  const header = "  公司".padEnd(24) + "未税小计".padStart(12) + "税".padStart(11) + "总计".padStart(13) + "差额".padStart(12);
  const lines = cmp.rows.map((r, i) => {
    const marker = i === 0 ? "★" : " ";
    return `${marker} ${r.companyName.slice(0, 20).padEnd(22)}` +
      format(r.netBeforeTax).padStart(12) +
      format(r.taxTotal).padStart(11) +
      format(r.total).padStart(13) +
      (r.deltaFromLowest === 0 ? "最低".padStart(12) : `+${format(r.deltaFromLowest)}`.padStart(12));
  });

  const out = [
    "多家报价对比",
    "─".repeat(72),
    header,
    "─".repeat(72),
    ...lines,
    "─".repeat(72),
  ];
  if (cmp.spread !== undefined) {
    out.push(`  最高与最低相差 ${format(cmp.spread)}`);
  }
  if (cmp.warnings.length > 0) {
    out.push("", "⚠️ 比较前请注意：");
    out.push(...cmp.warnings.map((w) => `  · ${w.message}`));
  }
  out.push("", "注：本表只比价格，不做图纸对比。各家的设计方案请分别查看。");
  return out.join("\n");
}

/** HTML 呈现，用于前端与邮件。 */
export function renderComparisonHtml(cmp: QuoteComparison): string {
  if (cmp.rows.length === 0) return "<p>还没有可对比的报价。</p>";

  const rows = cmp.rows.map((r, i) => `
    <tr${i === 0 ? ' style="font-weight:600"' : ""}>
      <td>${escapeHtml(r.companyName)}${i === 0 ? " ★" : ""}</td>
      <td style="text-align:right">${format(r.netBeforeTax)}</td>
      <td style="text-align:right">${format(r.shipping)}</td>
      <td style="text-align:right">${format(r.taxTotal)}</td>
      <td style="text-align:right">${format(r.total)}</td>
      <td style="text-align:right">${r.deltaFromLowest === 0 ? "最低" : "+" + format(r.deltaFromLowest)}</td>
    </tr>`).join("");

  const warnings = cmp.warnings.length
    ? `<div style="margin-top:12px;padding:10px;background:#fff8e1;border-left:3px solid #f0b429;font-size:13px">
         <strong>比较前请注意</strong><ul style="margin:6px 0 0;padding-left:18px">
         ${cmp.warnings.map((w) => `<li>${escapeHtml(w.message)}</li>`).join("")}</ul></div>`
    : "";

  return `
<table style="width:100%;border-collapse:collapse;font-size:13px">
  <thead><tr style="border-bottom:2px solid #ddd">
    <th style="text-align:left;padding:6px">公司</th>
    <th style="text-align:right;padding:6px">未税小计</th>
    <th style="text-align:right;padding:6px">运费</th>
    <th style="text-align:right;padding:6px">税</th>
    <th style="text-align:right;padding:6px">总计</th>
    <th style="text-align:right;padding:6px">差额</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>${warnings}
<p style="font-size:12px;color:#777;margin-top:10px">本表只比价格，不做图纸对比。</p>`.trim();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
