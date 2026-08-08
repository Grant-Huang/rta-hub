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
  BoxMaterialCode, DoorStyle, ModuleSpec, ModuleType, Modifier,
  PriceGroup, PriceMatrixEntry,
} from "../domain/types.js";
import { sortBoxMaterials } from "./carcass.js";
import { parseCsvRows, parseNumberList, type CsvRow } from "./csv.js";
import { matchWithOverrides, type CompanyOverrides } from "../render/templates.js";
import { emptyBundle, type SpecBundle } from "./bundle.js";

export interface ImportSources {
  modules: string;
  priceGroups: string;
  doorStyles: string;
  priceMatrix: string;
  /**
   * 箱体板材档位（可选表）。
   *
   * **可选，但必须能从这个口子进来**：接不进来，真实商家就没有任何办法声明
   * 「我家的柜体可以升级全夹板」——而那是 RTA 市场上最常见的一个升级项。
   * 不给这张表的商家照旧只有一档，报价与从前逐分一致。
   */
  boxMaterials?: string;
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
    /** 从上一版继承过来的型号数（脸型/能力）。改价时这个数应该等于型号总数。 */
    inheritedFromPrevious: number;
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
export interface ImportOptions {
  faceOverrides?: CompanyOverrides;
  /**
   * 这家商家**上一版已经确认过**的型号。
   *
   * 按型号码继承脸型与能力标签。商家改一次价（同样的型号、新的标价）不该
   * 被要求把"NS-B12 是单门"再答一遍——那是型号的固有属性，不是这一版的属性。
   * 要求重答的代价不只是麻烦：答二十遍之后，人会开始随手点，
   * 而这套队列存在的全部意义就是让人**认真看一眼**。
   *
   * 表里显式写了 `faceTemplate` 的行**优先于继承**——商家改了做法，以新的为准。
   */
  knownModules?: readonly ModuleSpec[];
}

export function importSpecTemplates(
  specVersionId: string,
  companyId: string,
  sources: ImportSources,
  faceOverridesOrOptions: CompanyOverrides | ImportOptions = {},
): ImportResult {
  // 第四个参数原来就是 `faceOverrides`。保留那种写法，种子文件与测试不必跟着改。
  const opts: ImportOptions = "faceOverrides" in faceOverridesOrOptions
      || "knownModules" in faceOverridesOrOptions
    ? faceOverridesOrOptions as ImportOptions
    : { faceOverrides: faceOverridesOrOptions as CompanyOverrides };
  const faceOverrides = opts.faceOverrides ?? {};
  const known = new Map(
    (opts.knownModules ?? []).map((m) => [m.code.toUpperCase(), m]));
  let inherited = 0;
  const bundle = emptyBundle(specVersionId, companyId);
  const unresolved: UnresolvedItem[] = [];
  const base = { specVersionId, companyId };

  // ── 价格组 ──────────────────────────────────────────────────────────────
  const pgRows = parseCsvRows(sources.priceGroups);
  const pgByCode = new Map<string, PriceGroup>();
  pgRows.forEach((row, i) => {
    const code = pick(row, "code", "priceGroup", "group");
    if (!code) {
      unresolved.push({ sheet: "priceGroups", rowNumber: i + 2, field: "code", reason: "Missing price group code" });
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
      unresolved.push({ sheet: "doorStyles", rowNumber: i + 2, field: "name", reason: "Missing door style name" });
      return;
    }
    const pg = pgByCode.get(groupCode.toUpperCase());
    if (!pg) {
      unresolved.push({
        sheet: "doorStyles", rowNumber: i + 2, field: "priceGroup",
        reason: `Price group "${groupCode}" is not defined in the price groups sheet`, raw: groupCode,
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

  // ── 箱体板材 ────────────────────────────────────────────────────────────
  //
  // 与门板是两个独立的维度：门板决定价格组，箱体是作用在标价上的修饰项。
  // 商家给的价目表本来就是这么组织的——一张门板价目表 + 一句「全夹板 +20%」。
  const bmRows = parseCsvRows(sources.boxMaterials ?? "");
  bmRows.forEach((row, i) => {
    const rowNumber = i + 2;
    const name = pick(row, "name", "boxMaterial", "material");
    const codeRaw = pick(row, "code", "kind", "type");
    const code = BOX_MATERIAL_CODES.find((c) => c.toLowerCase() === codeRaw.toLowerCase().replace(/[\s_-]/g, ""));
    if (!name) {
      unresolved.push({ sheet: "boxMaterials", rowNumber, field: "name", reason: "Missing box material name" });
      return;
    }
    if (!code) {
      // **不猜**。猜错的后果是排序反了、英文 PDF 上印错类别，
      // 而这两处客户都会拿去跟别家比。
      unresolved.push({
        sheet: "boxMaterials", rowNumber, field: "code",
        reason: codeRaw
          ? `Unrecognized box material kind "${codeRaw}" (expected particleBoard / plywood / solidWood)`
          : "Missing box material kind", raw: codeRaw,
      });
      return;
    }
    const upcharge = parseModifier(pick(row, "upcharge", "priceModifier", "premium"));
    if (!upcharge) {
      unresolved.push({
        sheet: "boxMaterials", rowNumber, field: "upcharge",
        reason: "Could not parse upcharge (use 18% or 120.00)", raw: pick(row, "upcharge"),
      });
      return;
    }
    bundle.boxMaterialOptions.push({
      ...base, id: `bm_${slug(name)}`, code, name, priceModifier: upcharge,
      ...(truthy(pick(row, "default", "isDefault")) ? { isDefault: true } : {}),
      ...(pick(row, "note") ? { note: pick(row, "note") } : {}),
    });
  });
  // 一档都没标默认时，最便宜的那一档当默认——标价本来就是针对它给的
  if (bundle.boxMaterialOptions.length > 0
      && !bundle.boxMaterialOptions.some((m) => m.isDefault)) {
    sortBoxMaterials(bundle.boxMaterialOptions)[0]!.isDefault = true;
  }

  // ── 型号 ────────────────────────────────────────────────────────────────
  const modRows = parseCsvRows(sources.modules);
  const modByCode = new Map<string, ModuleSpec>();
  let ruleHits = 0;

  modRows.forEach((row, i) => {
    const rowNumber = i + 2;
    const code = pick(row, "code", "sku", "model");
    if (!code) {
      unresolved.push({ sheet: "modules", rowNumber, field: "code", reason: "Missing module code" });
      return;
    }

    const typeRaw = pick(row, "type", "category");
    const type = MODULE_TYPES.find((t) => t.toLowerCase() === typeRaw.toLowerCase()) as ModuleType | undefined;
    if (!type) {
      unresolved.push({
        sheet: "modules", rowNumber, field: "type",
        reason: typeRaw ? `Unrecognized cabinet type "${typeRaw}"` : "Missing cabinet type", raw: typeRaw,
      });
      return;
    }

    const widths = parseNumberList(pick(row, "widths", "width", "widthOptions"));
    const heights = parseNumberList(pick(row, "heights", "height", "heightOptions"));
    const depths = parseNumberList(pick(row, "depths", "depth", "depthOptions"));
    for (const [field, list] of [["widths", widths], ["heights", heights], ["depths", depths]] as const) {
      if (list.length === 0) {
        unresolved.push({ sheet: "modules", rowNumber, field, reason: `${field} is empty or could not be parsed` });
      }
    }
    if (widths.length === 0 || heights.length === 0 || depths.length === 0) return;

    // 脸型：优先用表里显式指定的，其次按命名规则；都没有就进待确认队列，**不猜**。
    //
    // **但型号本身照样收下。** 之前这里是 `return`，整行丢掉——代价是一连串
    // 假问题：价格矩阵里那个型号的每一行都会报「型号未在型号表中定义」，
    // 而商家明明定义了。一家命名规律与我们的规则对不上的商家（这是常态，
    // 每家的命名体系都不一样）会看到几十条互相矛盾的提示，根本不知道
    // 真正要改的只有"告诉我们这个柜子正面长什么样"这一件事。
    //
    // 拦住发布的是**待确认队列本身**（`assertPublishable`），不是丢掉这一行。
    // 尺寸是商家给的真实数据，没有理由因为不知道它长什么样就扔掉。
    const explicit = pick(row, "faceTemplate", "face", "faceTemplateId");
    const previous = known.get(code.toUpperCase());
    let faceTemplateId = explicit;
    if (!faceTemplateId) {
      const match = matchWithOverrides(code, faceOverrides);
      if (match) {
        faceTemplateId = match.templateId;
        ruleHits++;
      } else if (previous?.faceTemplateId) {
        // 上一版商家已经答过这个型号长什么样，不再问第二遍
        faceTemplateId = previous.faceTemplateId;
        inherited++;
      } else {
        unresolved.push({
          sheet: "modules", rowNumber, field: "faceTemplate",
          reason: `Module ${code} could not be matched to a face template by naming rules; specify manually`, raw: code,
        });
      }
    }

    const assemblyRaw = pick(row, "assembly", "assemblyOptions");
    const assemblyOptions = assemblyRaw
      ? (assemblyRaw.split(/[|;,]/).map((s) => s.trim()).filter((s) => s === "RTA" || s === "assembled") as ModuleSpec["assemblyOptions"])
      : (["RTA"] as ModuleSpec["assemblyOptions"]);

    const mod: ModuleSpec = {
      ...base, id: `m_${slug(code)}`, code: code.toUpperCase(), type,
      widthOptions: widths, heightOptions: heights, depthOptions: depths,
      // 判不出来就留空，别塞一个占位值——空是"还不知道"，占位值是"我们猜了一个"，
      // 而占位值会一路画到正视图上，谁也看不出那是猜的
      ...(faceTemplateId ? { faceTemplateId } : {}),
      // 能力标签同理：上一版确认过就带过来，别再问一遍
      ...(previous?.capabilities ? { capabilities: previous.capabilities } : {}),
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
        reason: `Module "${code}" is not defined in the modules sheet`, raw: code,
      });
      return;
    }
    const pg = pgByCode.get(groupCode.toUpperCase());
    if (!pg) {
      unresolved.push({
        sheet: "priceMatrix", rowNumber, field: "priceGroup",
        reason: `Price group "${groupCode}" is not defined in the price groups sheet`, raw: groupCode,
      });
      return;
    }
    const listPrice = parseMoney(priceRaw);
    if (listPrice === undefined) {
      unresolved.push({
        sheet: "priceMatrix", rowNumber, field: "listPrice",
        reason: priceRaw ? `Could not parse price "${priceRaw}"` : "Missing price", raw: priceRaw,
      });
      return;
    }

    const tradeRaw = pick(row, "tradePrice");
    const tradePrice = tradeRaw ? parseMoney(tradeRaw) : undefined;
    if (tradeRaw && tradePrice === undefined) {
      unresolved.push({
        sheet: "priceMatrix", rowNumber, field: "tradePrice",
        reason: `Could not parse trade price "${tradeRaw}"`, raw: tradeRaw,
      });
      return;
    }

    const upchargeRaw = pick(row, "assembledUpcharge", "assemblyUpcharge");
    const assembledUpcharge: PriceMatrixEntry["assembledUpcharge"] = parseModifier(upchargeRaw);
    if (upchargeRaw && !assembledUpcharge) {
      unresolved.push({
        sheet: "priceMatrix", rowNumber, field: "assembledUpcharge",
        reason: `Could not parse assembled upcharge "${upchargeRaw}"`, raw: upchargeRaw,
      });
      return;
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
      inheritedFromPrevious: inherited,
    },
  };
}

const BOX_MATERIAL_CODES: BoxMaterialCode[] = ["particleBoard", "plywood", "solidWood"];

/**
 * 「18%」或「120.00」→ 修饰项。
 *
 * 组装加价与箱体加价用的是**同一种写法**，所以也共用同一个解析器——
 * 两处各写一遍，迟早出现"这张表接受 18%，那张表不接受"。
 */
function parseModifier(raw: string): Modifier | undefined {
  if (!raw) return undefined;
  if (raw.endsWith("%")) {
    const pct = Number(raw.slice(0, -1));
    return Number.isFinite(pct) ? { kind: "percent", value: pct } : undefined;
  }
  const flat = parseMoney(raw);
  return flat === undefined ? undefined : { kind: "flat", value: flat };
}

/** CSV 里的"是"。空白视为否。 */
function truthy(raw: string): boolean {
  return /^(y|yes|true|1|是|默认)$/i.test(raw.trim());
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
    boxMaterials: "code,name,upcharge,default,note\n" +
      "particleBoard,Particle board box,0%,yes,List prices assume this tier\n" +
      "plywood,All-plywood box,18%,,1/2\" plywood box\n",
  };
}
