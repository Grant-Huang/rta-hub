/**
 * 报价清单 —— 逐项列出「买什么、几个、多少钱」，并分组分类汇总。
 *
 * ## 为什么不能只给总价
 *
 * 一个总价没法让客户判断贵在哪、也没法跟另一家比。他要看的是：
 * **产品代码、产品名称、数量、单价、总价**，逐行。
 *
 * ## 柜体与门板放在一起
 *
 * RTA 的柜体 SKU **本身就含门板**——价格由「型号 × 门板价格组」决定，
 * 门不是单独一行商品。所以这里的做法是：柜体行带价格，门板作为**从属明细**
 * 挂在它下面，写清是哪款门、几扇门/几个抽屉面，并标明「已含在柜体价内」。
 *
 * 这比编一个门板单价诚实：我们没有拆分依据，编出来的拆分会被拿去跟别家比，
 * 而那个数字是假的。
 *
 * ## 附件单独列
 *
 * 填缝条、踢脚板/塑料地脚、收口板不属于任何一个柜体，它们服务于整套，
 * 所以单独成区。分类汇总让客户一眼看到钱花在哪一类上。
 */
import { format, type Money } from "../domain/money.js";
import type {
  BoxMaterialOption, DoorStyle, ModuleSpec, Quote, QuoteLineItem,
} from "../domain/types.js";
import type { BomCategory, BomLine } from "../layout/bom.js";
import { matchFaceTemplate } from "../render/templates.js";
import { DEFAULT_LANGUAGE, msg, type UiLanguage } from "../i18n/language.js";
import { isStandaloneSellUnit, resolveModuleSellUnit } from "../spec/sku-semantics.js";
import type { CompanyCodingRules } from "../domain/types.js";

export type QuoteCategory = "cabinet" | "door" | "hardware" | "accessory" | "trim";

/** @deprecated 用 `categoryLabel(cat, lang)`；保留英文默认以兼容旧引用。 */
export const CATEGORY_LABEL: Record<QuoteCategory, string> = {
  cabinet: "Cabinets",
  door: "Doors & drawer fronts",
  hardware: "Hardware",
  accessory: "Functional accessories",
  trim: "Fillers & trim",
};

export function categoryLabel(
  cat: QuoteCategory,
  lang: UiLanguage = DEFAULT_LANGUAGE,
): string {
  const en = CATEGORY_LABEL[cat];
  const zh: Record<QuoteCategory, string> = {
    cabinet: "柜体",
    door: "门板与抽屉面",
    hardware: "五金",
    accessory: "功能配件",
    trim: "填缝与收口件",
  };
  return msg(lang, en, zh[cat]);
}

/** 一行商品。字段就是客户要看的那五项。 */
export interface QuoteListRow {
  code: string;
  name: string;
  qty: number;
  unitPrice: Money;
  lineTotal: Money;
  /** 规格描述，如 30" × 34-1/2" × 24"。 */
  spec?: string;
  /** 为什么会有这一行（附件用）。 */
  note?: string;
}

/**
 * 柜体分组：柜体行 + 挂在它下面的门板明细与加价项。
 */
export interface CabinetGroup {
  cabinet: QuoteListRow;
  /** 门板明细。**不单独计价**——RTA 的柜体 SKU 本身含门。 */
  door: {
    styleName: string;
    /** 这个型号有几扇门、几个抽屉面。 */
    doors: number;
    drawerFronts: number;
    description: string;
    includedNote: string;
  };
  /** 五金/配件加价，逐项列出金额（这些是真的额外收费）。 */
  modifiers: QuoteListRow[];
  /** 该柜体连同其加价的合计。 */
  groupTotal: Money;
}

export interface CategorySubtotal {
  category: QuoteCategory;
  label: string;
  /** 件数（门板不计件——它不是单独商品）。 */
  itemCount: number;
  amount: Money;
  /** 门板这类"含在别处"的分类要说明，不能显示成 $0 让人以为免费。 */
  includedIn?: string;
}

export interface QuoteList {
  /**
   * 这份价按的是哪一档箱体板材。
   *
   * **必须写出来。** 客户拿这张单子去跟另一家比，那一家报的可能是颗粒板箱体，
   * 这一家是全夹板——不写，两个数看起来就是同一件东西的两个价。
   * 客户没主动选时这里是商家的默认档，文字里会点明"按基础档算的"。
   */
  boxMaterial?: { name: string; chosen: boolean; note?: string };
  cabinets: CabinetGroup[];
  /** 填缝条、踢脚/地脚、收口板。 */
  trim: QuoteListRow[];
  subtotals: CategorySubtotal[];
  /** 逐行合计，应当等于 `quote.subtotal`。对不上就是有行漏了。 */
  itemsTotal: Money;
  /** 与报价单小计的差额；非 0 说明清单不完整，必须报出来。 */
  reconciliationDelta: Money;
}

export interface BuildListInput {
  quote: Quote;
  modules: readonly ModuleSpec[];
  doorStyles: readonly DoorStyle[];
  /** BOM 提供分类与来由；缺省时按型号 type 归类。 */
  bomLines?: readonly BomLine[];
  /** 该公司的箱体板材档位，用来把 `quote.boxMaterialId` 翻成客户看得懂的名字。 */
  boxMaterials?: readonly BoxMaterialOption[];
  /** 客户可见文案语言；默认英文。 */
  language?: UiLanguage;
  /** FR-16：本公司编码规则，影响 sellUnit 启发式。 */
  codingRules?: CompanyCodingRules;
}

const BOM_TO_QUOTE: Record<BomCategory, QuoteCategory> = {
  cabinet: "cabinet", filler: "trim", toeKick: "trim", leg: "trim", panel: "trim",
};

export function buildQuoteList(input: BuildListInput): QuoteList {
  const lang = input.language ?? DEFAULT_LANGUAGE;
  const { quote } = input;
  const doorStyle = input.doorStyles.find((d) => d.id === quote.doorStyleId);
  const byModule = new Map(input.modules.map((m) => [m.id, m]));
  const bomBy = new Map((input.bomLines ?? []).map((b) => [b.moduleId, b]));

  const cabinets: CabinetGroup[] = [];
  const trim: QuoteListRow[] = [];
  /** FR-16：真实 box / door SKU 单独成行（不做门板从属）。 */
  const splitSkus: QuoteListRow[] = [];

  for (const line of quote.lineItems) {
    const spec = byModule.get(line.moduleId);
    const bom = bomBy.get(line.moduleId);
    const sell = spec
      ? resolveModuleSellUnit(spec, input.codingRules)
      : undefined;
    const category = bom
      ? BOM_TO_QUOTE[bom.category]
      : sell && isStandaloneSellUnit(sell.sellUnit)
        ? "trim"
        : spec && ["filler", "toeKick", "leg", "panel", "crown"].includes(spec.type)
          ? "trim" : "cabinet";

    const row: QuoteListRow = {
      code: line.moduleCode,
      name: moduleName(line.moduleCode, spec, lang),
      qty: line.qty,
      unitPrice: line.unitNetPrice,
      lineTotal: line.lineSubtotal,
      spec: dimensionText(line),
      ...(bom?.reason ? { note: bom.reason } : {}),
    };

    if (category === "trim" || (sell && isStandaloneSellUnit(sell.sellUnit))) {
      trim.push(row);
      continue;
    }

    // 真实 BOX / DOOR SKU：独立可售行，不挂「含在柜体价内」的门板从属
    if (sell?.sellUnit === "box" || sell?.sellUnit === "door") {
      splitSkus.push({
        ...row,
        note: sell.sellUnit === "box"
          ? msg(lang, "Cabinet box only (no door)", "仅柜体（不含门）")
          : msg(lang, "Door / drawer front only", "仅门板/抽屉面"),
      });
      continue;
    }

    const face = countFaces(line.moduleCode);
    cabinets.push({
      cabinet: row,
      door: {
        styleName: doorStyle?.name ?? quote.doorStyleId,
        doors: face.doors,
        drawerFronts: face.drawerFronts,
        description: faceDescription(face, doorStyle?.name ?? quote.doorStyleId, line.qty, lang),
        includedNote: msg(lang,
          "Included in cabinet price (RTA cabinets are priced as SKU × door price group; doors are not priced separately)",
          "已含在柜体价内（RTA 柜体按「型号 × 门板价格组」定价，门板不单独计价）"),
      },
      modifiers: line.modifiers.map((m) => ({
        code: m.refId,
        name: m.name,
        qty: line.qty,
        unitPrice: m.amount,
        lineTotal: (m.amount * line.qty) as Money,
      })),
      groupTotal: line.lineSubtotal,
    });
  }

  // 拆卖 SKU 暂挂在 trim 区之后以独立行呈现——计入 itemsTotal，分类归 cabinet
  const subtotals = buildSubtotals(cabinets, trim, doorStyle?.name, lang, splitSkus);
  const itemsTotal = (cabinets.reduce((s, g) => s + g.groupTotal, 0)
    + trim.reduce((s, r) => s + r.lineTotal, 0)
    + splitSkus.reduce((s, r) => s + r.lineTotal, 0)) as Money;

  const box = (input.boxMaterials ?? []).find((m) => m.id === quote.boxMaterialId);

  return {
    ...(box ? {
      boxMaterial: {
        name: box.name,
        // 客户主动选过，还是我们按商家的基础档替他定的——这两件事在解释上不一样，
        // 后者要说明"你没选，按基础档算的"，否则客户会以为自己选过全夹板
        chosen: !box.isDefault,
        ...(box.note ? { note: box.note } : {}),
      },
    } : {}),
    cabinets,
    trim: [...trim, ...splitSkus],
    subtotals, itemsTotal,
    reconciliationDelta: (itemsTotal - quote.subtotal) as Money,
  };
}

/**
 * 分类汇总。
 *
 * 门板一类金额为 0，但**不能显示成 $0**——那会让客户以为门是送的。
 * 用 `includedIn` 说明它含在柜体价里。
 */
function buildSubtotals(
  cabinets: readonly CabinetGroup[],
  trim: readonly QuoteListRow[],
  doorStyleName: string | undefined,
  lang: UiLanguage,
  splitSkus: readonly QuoteListRow[] = [],
): CategorySubtotal[] {
  const cabinetBase = cabinets.reduce(
    (s, g) => s + g.cabinet.lineTotal - g.modifiers.reduce((t, m) => t + m.lineTotal, 0), 0)
    + splitSkus.reduce((s, r) => s + r.lineTotal, 0);

  const hardware = cabinets.flatMap((g) => g.modifiers.filter((m) => isHardware(m.code)));
  const accessory = cabinets.flatMap((g) => g.modifiers.filter((m) => !isHardware(m.code)));

  const style = doorStyleName ?? msg(lang, "Selected doors", "所选门板");
  const out: CategorySubtotal[] = [
    {
      category: "cabinet", label: categoryLabel("cabinet", lang),
      itemCount: cabinets.reduce((n, g) => n + g.cabinet.qty, 0)
        + splitSkus.reduce((n, r) => n + r.qty, 0),
      amount: cabinetBase as Money,
    },
    {
      category: "door", label: categoryLabel("door", lang),
      itemCount: cabinets.reduce((n, g) => n + (g.door.doors + g.door.drawerFronts) * g.cabinet.qty, 0),
      amount: 0 as Money,
      includedIn: msg(lang,
        `${style} included in cabinet price — not priced separately`,
        `${style}已含在柜体价内，不单独计价`),
    },
  ];

  if (hardware.length > 0) {
    out.push({
      category: "hardware", label: categoryLabel("hardware", lang),
      itemCount: hardware.reduce((n, m) => n + m.qty, 0),
      amount: hardware.reduce((s, m) => s + m.lineTotal, 0) as Money,
    });
  }
  if (accessory.length > 0) {
    out.push({
      category: "accessory", label: categoryLabel("accessory", lang),
      itemCount: accessory.reduce((n, m) => n + m.qty, 0),
      amount: accessory.reduce((s, m) => s + m.lineTotal, 0) as Money,
    });
  }
  if (trim.length > 0) {
    out.push({
      category: "trim", label: categoryLabel("trim", lang),
      itemCount: trim.reduce((n, r) => n + r.qty, 0),
      amount: trim.reduce((s, r) => s + r.lineTotal, 0) as Money,
    });
  }
  return out;
}

/** 五金 id 约定以 `hw_` 开头；配件是 `ac_`。分不出来时归入配件，宁可保守。 */
function isHardware(refId: string): boolean {
  return /^hw[_-]/i.test(refId);
}

/**
 * 从脸型模板推出门与抽屉面的数量。
 *
 * 用的是渲染那套已经定好的脸型文法——不另起一套规则，
 * 免得报价单上写 2 扇门、图纸上画 1 扇。
 */
export function countFaces(code: string): { doors: number; drawerFronts: number } {
  const match = matchFaceTemplate(code);
  if (!match) return { doors: 0, drawerFronts: 0 };
  const id = match.templateId;
  const p = match.params as Record<string, unknown>;

  switch (id) {
    // 纯抽屉柜：抽屉数由模板参数给（3DB / 4DB 等）
    case "F6_DRAWER_STACK":
      return { doors: 0, drawerFronts: Number(p["drawers"] ?? 3) };
    // 上抽屉 + 下门
    case "F3_DRAWER_OVER_DOOR":
      return { doors: 1, drawerFronts: 1 };
    case "F4_DRAWER_OVER_DOUBLE":
      return { doors: 2, drawerFronts: 1 };
    case "F5_TWO_DRAWERS_OVER_DOUBLE":
      return { doors: 2, drawerFronts: 2 };
    // 水槽柜：假抽屉面板不是抽屉，但它是一块要计入门板套数的面板
    case "F7_FALSE_FRONT_DOUBLE":
      return { doors: 2, drawerFronts: 1 };
    case "F2_DOUBLE_DOOR":
    case "F8_APRON_SINK":
    case "F13_TALL_TWO_DOOR":
      return { doors: 2, drawerFronts: 0 };
    case "F1_SINGLE_DOOR":
    case "F9_DIAGONAL_CORNER":
    case "F10_BLIND_CORNER":
      return { doors: 1, drawerFronts: 0 };
    // 开放格、酒格、家电位、素板：没有门板
    case "F11_OPEN_SHELF":
    case "F12_WINE_GRID":
    case "F14_APPLIANCE":
    case "F15_PLAIN_PANEL":
      return { doors: 0, drawerFronts: 0 };
  }
}

function faceDescription(
  face: { doors: number; drawerFronts: number },
  styleName: string,
  qty: number,
  lang: UiLanguage,
): string {
  const parts: string[] = [];
  if (face.doors > 0) {
    parts.push(msg(lang,
      `${face.doors * qty} door${face.doors * qty === 1 ? "" : "s"}`,
      `${face.doors * qty} 扇门`));
  }
  if (face.drawerFronts > 0) {
    parts.push(msg(lang,
      `${face.drawerFronts * qty} drawer front${face.drawerFronts * qty === 1 ? "" : "s"}`,
      `${face.drawerFronts * qty} 个抽屉面`));
  }
  if (parts.length === 0) {
    return msg(lang,
      `${styleName} (this SKU has no doors)`,
      `${styleName}（此型号无门板）`);
  }
  return msg(lang,
    `${styleName} — ${parts.join(" + ")}`,
    `${styleName}　${parts.join(" + ")}`);
}

function moduleName(code: string, spec: ModuleSpec | undefined, lang: UiLanguage): string {
  const typeName: Partial<Record<ModuleSpec["type"], string>> = lang === "zh"
    ? {
      base: "地柜", wall: "吊柜", tall: "高柜", corner: "转角柜", sinkBase: "水槽柜",
      filler: "填缝条", panel: "收口板", toeKick: "踢脚板", crown: "顶线", leg: "可调地脚",
    }
    : {
      base: "Base", wall: "Wall", tall: "Tall", corner: "Corner", sinkBase: "Sink base",
      filler: "Filler", panel: "Panel", toeKick: "Toe kick", crown: "Crown", leg: "Adjustable leg",
    };
  const t = spec ? typeName[spec.type] : undefined;
  return t ? `${t} ${code}` : code;
}

function dimensionText(l: QuoteLineItem): string {
  return `${fmt(l.width)}" × ${fmt(l.height)}" × ${fmt(l.depth)}"`;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}

// ── 呈现 ──────────────────────────────────────────────────────────────────

export function renderQuoteListText(
  list: QuoteList,
  language: UiLanguage = DEFAULT_LANGUAGE,
): string {
  const lang = language;
  const out: string[] = [];
  const W = { code: 10, name: 22, qty: 5, unit: 11, total: 12 };
  const head = msg(lang, "Code", "代码").padEnd(W.code)
    + msg(lang, "Name", "名称").padEnd(W.name)
    + msg(lang, "Qty", "数量").padStart(W.qty)
    + msg(lang, "Unit", "单价").padStart(W.unit)
    + msg(lang, "Total", "总价").padStart(W.total);

  if (list.boxMaterial) {
    // 摆在最前面，跟门板样式一样是"这份价对的是什么产品"的一部分
    out.push(msg(lang,
      `[Box material] ${list.boxMaterial.name}`
        + (list.boxMaterial.chosen
          ? " (your choice)"
          : " (you didn't choose — priced at this seller's base grade)"),
      `【箱体板材】${list.boxMaterial.name}`
        + (list.boxMaterial.chosen ? "（你选的）" : "（你没选，按该商家的基础档算的）")));
    if (list.boxMaterial.note) out.push(`  ${list.boxMaterial.note}`);
    out.push("");
  }
  out.push(msg(lang, "[Cabinets (doors included)]", "【柜体（含门板）】"), head, "─".repeat(62));
  for (const g of list.cabinets) {
    out.push(row(g.cabinet, W));
    out.push(msg(lang,
      `  └ Doors: ${g.door.description}  ${g.door.includedNote}`,
      `  └ 门板：${g.door.description}　${g.door.includedNote}`));
    for (const m of g.modifiers) out.push("  " + row(m, W));
  }

  if (list.trim.length > 0) {
    out.push("", msg(lang, "[Fillers & trim]", "【填缝与收口件】"), head, "─".repeat(62));
    for (const r of list.trim) {
      out.push(row(r, W));
      if (r.note) out.push(`  └ ${r.note}`);
    }
  }

  out.push("", msg(lang, "[Category subtotals]", "【分类汇总】"));
  for (const s of list.subtotals) {
    out.push(`  ${s.label.padEnd(14)}${String(s.itemCount).padStart(4)} `
      + msg(lang, "pcs  ", " 件  ")
      + (s.includedIn ? `—  ${s.includedIn}` : format(s.amount).padStart(12)));
  }
  out.push("  " + "─".repeat(44));
  out.push(`  ${msg(lang, "Line-item total", "逐行合计").padEnd(14)}${" ".repeat(9)}${format(list.itemsTotal).padStart(12)}`);
  if (list.reconciliationDelta !== 0) {
    out.push(msg(lang,
      `  ⚠ Differs from quote subtotal by ${format(list.reconciliationDelta)} — the list may be missing items`,
      `  ⚠ 与报价单小计差 ${format(list.reconciliationDelta)} —— 清单可能有遗漏项`));
  }
  return out.join("\n");
}

function row(r: QuoteListRow, W: { code: number; name: number; qty: number; unit: number; total: number }): string {
  return r.code.padEnd(W.code) +
    (r.spec ? `${r.name}` : r.name).padEnd(W.name) +
    String(r.qty).padStart(W.qty) +
    format(r.unitPrice).padStart(W.unit) +
    format(r.lineTotal).padStart(W.total);
}

export function renderQuoteListHtml(
  list: QuoteList,
  language: UiLanguage = DEFAULT_LANGUAGE,
): string {
  const lang = language;
  const rows = (r: QuoteListRow, cls = "") =>
    `<tr class="${cls}"><td><code>${esc(r.code)}</code></td><td>${esc(r.name)}` +
    (r.spec ? `<span class="ql-spec">${esc(r.spec)}</span>` : "") +
    (r.note ? `<span class="ql-note">${esc(r.note)}</span>` : "") +
    `</td><td class="num">${r.qty}</td><td class="num">${format(r.unitPrice)}</td>` +
    `<td class="num">${format(r.lineTotal)}</td></tr>`;

  const cabinetRows = list.cabinets.map((g) => [
    rows(g.cabinet),
    `<tr class="ql-door"><td></td><td colspan="4">└ ${msg(lang, "Doors: ", "门板：")}${esc(g.door.description)}` +
    `<span class="ql-note">${esc(g.door.includedNote)}</span></td></tr>`,
    ...g.modifiers.map((m) => rows(m, "ql-mod")),
  ].join("")).join("");

  const head = `<thead><tr><th>${msg(lang, "Code", "代码")}</th><th>${msg(lang, "Name", "名称")}</th>`
    + `<th class="num">${msg(lang, "Qty", "数量")}</th>`
    + `<th class="num">${msg(lang, "Unit", "单价")}</th>`
    + `<th class="num">${msg(lang, "Total", "总价")}</th></tr></thead>`;

  const subtotalRows = list.subtotals.map((s) =>
    `<tr><td>${esc(s.label)}</td><td class="num">${s.itemCount} ${msg(lang, "pcs", "件")}</td>` +
    `<td class="num">${s.includedIn ? `<span class="ql-note">${esc(s.includedIn)}</span>` : format(s.amount)}</td></tr>`,
  ).join("");

  const boxLine = list.boxMaterial
    ? `<p class="ql-box"><b>${msg(lang, "Box material: ", "箱体板材：")}</b>${esc(list.boxMaterial.name)}` +
      (list.boxMaterial.chosen
        ? msg(lang, " (your choice)", "（你选的）")
        : msg(lang, " (you didn't choose — priced at this seller's base grade)", "（你没选，按该商家的基础档算的）")) +
      (list.boxMaterial.note ? `<span class="ql-note">${esc(list.boxMaterial.note)}</span>` : "") +
      "</p>"
    : "";

  return `<div class="quote-list">
    ${boxLine}
    <h4>${msg(lang, "Cabinets (doors included)", "柜体（含门板）")}</h4>
    <table class="ql">${head}<tbody>${cabinetRows}</tbody></table>
    ${list.trim.length ? `<h4>${msg(lang, "Fillers & trim", "填缝与收口件")}</h4>
      <table class="ql">${head}<tbody>${list.trim.map((r) => rows(r)).join("")}</tbody></table>` : ""}
    <h4>${msg(lang, "Category subtotals", "分类汇总")}</h4>
    <table class="ql ql-sum"><tbody>${subtotalRows}
      <tr class="ql-total"><td>${msg(lang, "Line-item total", "逐行合计")}</td><td></td><td class="num">${format(list.itemsTotal)}</td></tr>
    </tbody></table>
    ${list.reconciliationDelta !== 0
      ? `<p class="ql-warn">${msg(lang,
        `Differs from quote subtotal by ${format(list.reconciliationDelta)} — the list may be missing items`,
        `与报价单小计差 ${format(list.reconciliationDelta)} —— 清单可能有遗漏项`)}</p>` : ""}
  </div>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
