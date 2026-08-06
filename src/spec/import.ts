/**
 * 结构化模板导入 —— FR-2 的降级兜底路径（REQUIREMENTS FR-2「降级兜底方案」）。
 *
 * 这条路径同时是**会话式抽取的验收基线**：把价目表导进来所需要的字段，
 * 就是会话必须问出来的字段。先把它做出来，MVP-1 的其余环节就不会被规格录入卡死。
 *
 * 四张表：
 *   modules      型号表：code, type, widths, heights, depths, [faceTemplate]
 *   priceGroups  价格组表：code, displayName, [rank]
 *   doorStyles   门板表：name, priceGroup, [material], [color]
 *   priceMatrix  价格矩阵：moduleCode, priceGroup, listPrice, [tradePrice], [assembledUpcharge]
 *
 * **零静默失败**（FR-2）：任何拿不准的字段都会进 `unresolved` 队列并标注原因，
 * 系统不会自己猜一个值填上去。
 */
import { fromDollars, type Money } from "../domain/money.js";
import type {
  DoorStyle, ModuleSpec, ModuleType, PriceGroup, PriceMatrixEntry,
} from "../domain/types.js";
import { parseCsvRows, parseNumberList, type CsvRow } from "./csv.js";
import { matchWithOverrides, type CompanyOverrides } from "../render/templates.js";
import { emptyBundle, type SpecBundle } from "./bundle.js";

export interface ImportSources {
  modules: string;
  priceGroups: string;
  doorStyles: string;
  priceMatrix: string;
}

/** 待确认项 —— 必须由人处理后才能发布。 */
export interface UnresolvedItem {
  sheet: keyof ImportSources;
  rowNumber: number;
  field: string;
  reason: string;
  /** 原始单元格内容，便于人工核对。 */
  raw?: string;
}

export interface ImportResult {
  bundle: SpecBundle;
  unresolved: UnresolvedItem[];
  stats: {
    moduleRows: number;
    modulesImported: number;
    priceMatrixRows: number;
    priceMatrixImported: number;
    doorStyles: number;
    priceGroups: number;
    /** 脸型由命名规则自动判定的型号数（不含人工指定的）。 */
    faceTemplateRuleHits: number;
  };
}

const MODULE_TYPES: readonly string[] = [
  "base", "wall", "tall", "corner", "sinkBase", "filler", "panel", "toeKick", "crown",
];

function parseMoney(raw: string): Money | undefined {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return undefined;
  try {
    return fromDollars(cleaned);
  } catch {
    return undefined;
  }
}

function pick(row: CsvRow, ...names: string[]): string {
  for (const n of names) {
    const hit = Object.keys(row).find((k) => k.toLowerCase() === n.toLowerCase());
    if (hit && row[hit]) return row[hit]!;
  }
  return "";
}

/**
 * 导入四张表，产出一个**草稿**规格整包。
 *
 * 注意返回的 bundle 只有在 `unresolved` 为空时才应被允许发布——
 * 这个约束由 `assertPublishable` 强制，不靠调用方自觉。
 */
export function importSpecTemplates(
  specVersionId: string,
  companyId: string,
  sources: ImportSources,
  faceOverrides: CompanyOverrides = {},
): ImportResult {
  const bundle = emptyBundle(specVersionId, companyId);
  const unresolved: UnresolvedItem[] = [];
  const base = { specVersionId, companyId };

  // ── 价格组 ──────────────────────────────────────────────────────────────
  const pgRows = parseCsvRows(sources.priceGroups);
  const pgByCode = new Map<string, PriceGroup>();
  pgRows.forEach((row, i) => {
    const code = pick(row, "code", "priceGroup", "group");
    if (!code) {
      unresolved.push({ sheet: "priceGroups", rowNumber: i + 2, field: "code", reason: "缺少价格组代码" });
      return;
    }
    const pg: PriceGroup = {
      ...base,
      id: `pg_${slug(code)}`,
      code,
      displayName: pick(row, "displayName", "name") || code,
      rank: Number(pick(row, "rank")) || pgByCode.size + 1,
    };
    pgByCode.set(code.toUpperCase(), pg);
    bundle.priceGroups.push(pg);
  });

  // ── 门板 ────────────────────────────────────────────────────────────────
  const dsRows = parseCsvRows(sources.doorStyles);
  dsRows.forEach((row, i) => {
    const name = pick(row, "name", "doorStyle", "style");
    const groupCode = pick(row, "priceGroup", "group", "code");
    if (!name) {
      unresolved.push({ sheet: "doorStyles", rowNumber: i + 2, field: "name", reason: "缺少门板名称" });
      return;
    }
    const pg = pgByCode.get(groupCode.toUpperCase());
    if (!pg) {
      unresolved.push({
        sheet: "doorStyles", rowNumber: i + 2, field: "priceGroup",
        reason: `价格组 "${groupCode}" 未在价格组表中定义`, raw: groupCode,
      });
      return;
    }
    const ds: DoorStyle = {
      ...base, id: `ds_${slug(name)}`, name, priceGroupId: pg.id,
      ...(pick(row, "material") ? { material: pick(row, "material") } : {}),
      ...(pick(row, "color") ? { color: pick(row, "color") } : {}),
    };
    bundle.doorStyles.push(ds);
  });

  // ── 型号 ────────────────────────────────────────────────────────────────
  const modRows = parseCsvRows(sources.modules);
  const modByCode = new Map<string, ModuleSpec>();
  let ruleHits = 0;

  modRows.forEach((row, i) => {
    const rowNumber = i + 2;
    const code = pick(row, "code", "sku", "model");
    if (!code) {
      unresolved.push({ sheet: "modules", rowNumber, field: "code", reason: "缺少型号码" });
      return;
    }

    const typeRaw = pick(row, "type", "category");
    const type = MODULE_TYPES.find((t) => t.toLowerCase() === typeRaw.toLowerCase()) as ModuleType | undefined;
    if (!type) {
      unresolved.push({
        sheet: "modules", rowNumber, field: "type",
        reason: typeRaw ? `无法识别的柜体类型 "${typeRaw}"` : "缺少柜体类型", raw: typeRaw,
      });
      return;
    }

    const widths = parseNumberList(pick(row, "widths", "width", "widthOptions"));
    const heights = parseNumberList(pick(row, "heights", "height", "heightOptions"));
    const depths = parseNumberList(pick(row, "depths", "depth", "depthOptions"));
    for (const [field, list] of [["widths", widths], ["heights", heights], ["depths", depths]] as const) {
      if (list.length === 0) {
        unresolved.push({ sheet: "modules", rowNumber, field, reason: `${field} 为空或无法解析` });
      }
    }
    if (widths.length === 0 || heights.length === 0 || depths.length === 0) return;

    // 脸型：优先用表里显式指定的，其次按命名规则；都没有就进待确认队列，**不猜**
    const explicit = pick(row, "faceTemplate", "face", "faceTemplateId");
    let faceTemplateId = explicit;
    if (!faceTemplateId) {
      const match = matchWithOverrides(code, faceOverrides);
      if (match) {
        faceTemplateId = match.templateId;
        ruleHits++;
      } else {
        unresolved.push({
          sheet: "modules", rowNumber, field: "faceTemplate",
          reason: `型号 ${code} 未能按命名规则判定脸型，需人工指定`, raw: code,
        });
        return;
      }
    }

    const assemblyRaw = pick(row, "assembly", "assemblyOptions");
    const assemblyOptions = assemblyRaw
      ? (assemblyRaw.split(/[|;,]/).map((s) => s.trim()).filter((s) => s === "RTA" || s === "assembled") as ModuleSpec["assemblyOptions"])
      : (["RTA"] as ModuleSpec["assemblyOptions"]);

    const mod: ModuleSpec = {
      ...base, id: `m_${slug(code)}`, code: code.toUpperCase(), type,
      widthOptions: widths, heightOptions: heights, depthOptions: depths,
      faceTemplateId,
      assemblyOptions: assemblyOptions.length ? assemblyOptions : ["RTA"],
    };
    modByCode.set(mod.code, mod);
    bundle.modules.push(mod);
  });

  // ── 价格矩阵 ────────────────────────────────────────────────────────────
  const pmRows = parseCsvRows(sources.priceMatrix);
  pmRows.forEach((row, i) => {
    const rowNumber = i + 2;
    const code = pick(row, "moduleCode", "code", "sku").toUpperCase();
    const groupCode = pick(row, "priceGroup", "group");
    const priceRaw = pick(row, "listPrice", "price");

    const mod = modByCode.get(code);
    if (!mod) {
      unresolved.push({
        sheet: "priceMatrix", rowNumber, field: "moduleCode",
        reason: `型号 "${code}" 未在型号表中定义`, raw: code,
      });
      return;
    }
    const pg = pgByCode.get(groupCode.toUpperCase());
    if (!pg) {
      unresolved.push({
        sheet: "priceMatrix", rowNumber, field: "priceGroup",
        reason: `价格组 "${groupCode}" 未在价格组表中定义`, raw: groupCode,
      });
      return;
    }
    const listPrice = parseMoney(priceRaw);
    if (listPrice === undefined) {
      unresolved.push({
        sheet: "priceMatrix", rowNumber, field: "listPrice",
        reason: priceRaw ? `无法解析价格 "${priceRaw}"` : "缺少价格", raw: priceRaw,
      });
      return;
    }

    const tradeRaw = pick(row, "tradePrice");
    const tradePrice = tradeRaw ? parseMoney(tradeRaw) : undefined;
    if (tradeRaw && tradePrice === undefined) {
      unresolved.push({
        sheet: "priceMatrix", rowNumber, field: "tradePrice",
        reason: `无法解析贸易价 "${tradeRaw}"`, raw: tradeRaw,
      });
      return;
    }

    const upchargeRaw = pick(row, "assembledUpcharge", "assemblyUpcharge");
    let assembledUpcharge: PriceMatrixEntry["assembledUpcharge"];
    if (upchargeRaw) {
      if (upchargeRaw.endsWith("%")) {
        const pct = Number(upchargeRaw.slice(0, -1));
        if (!Number.isFinite(pct)) {
          unresolved.push({
            sheet: "priceMatrix", rowNumber, field: "assembledUpcharge",
            reason: `无法解析组装加价 "${upchargeRaw}"`, raw: upchargeRaw,
          });
          return;
        }
        assembledUpcharge = { kind: "percent", value: pct };
      } else {
        const flat = parseMoney(upchargeRaw);
        if (flat === undefined) {
          unresolved.push({
            sheet: "priceMatrix", rowNumber, field: "assembledUpcharge",
            reason: `无法解析组装加价 "${upchargeRaw}"`, raw: upchargeRaw,
          });
          return;
        }
        assembledUpcharge = { kind: "flat", value: flat };
      }
    }

    bundle.priceMatrix.push({
      ...base, moduleId: mod.id, priceGroupId: pg.id, listPrice,
      ...(tradePrice !== undefined ? { tradePrice } : {}),
      ...(assembledUpcharge ? { assembledUpcharge } : {}),
    });
  });

  return {
    bundle,
    unresolved,
    stats: {
      moduleRows: modRows.length,
      modulesImported: bundle.modules.length,
      priceMatrixRows: pmRows.length,
      priceMatrixImported: bundle.priceMatrix.length,
      doorStyles: bundle.doorStyles.length,
      priceGroups: bundle.priceGroups.length,
      faceTemplateRuleHits: ruleHits,
    },
  };
}

function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** 生成给公司填写的空白模板（表头 + 一行示例）。 */
export function blankTemplates(): ImportSources {
  return {
    priceGroups: "code,displayName,rank\nA,Standard,1\nB,Premium,2\n",
    doorStyles: "name,priceGroup,material,color\nShaker White,A,Maple,White\nMaple Glaze,B,Maple,Antique Glaze\n",
    modules: "code,type,widths,heights,depths,assembly,faceTemplate\nB30,base,30,34-1/2,24,RTA|assembled,\nW3030,wall,30,30|36|42,12,RTA,\n",
    priceMatrix: "moduleCode,priceGroup,listPrice,tradePrice,assembledUpcharge\nB30,A,245.50,,15%\nB30,B,398.75,,15%\n",
  };
}
