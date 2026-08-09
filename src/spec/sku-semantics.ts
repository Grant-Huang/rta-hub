/**
 * L0 SKU 售卖单元解析 —— FR-16 / docs/product-codes.md。
 *
 * 解析顺序（必须遵守）：
 *   1. 规格声明 sellUnit → 以声明为准
 *   2. ModuleType ∈ trim 类 → standalone
 *   3. 码匹配 -BOX / -DOOR → box / door
 *   4. 同时识别到材质段 + 花色段 → combo
 *   5. 否则默认 combo（主流「型号 × 门板组」）
 *
 * 厂商 CodingRules 只提供 token 词典与是否启用后缀启发式；
 * **柜型前缀含义不在这里解析**（那是 L1，按公司隔离）。
 */
import type {
  CompanyCodingRules, ModuleSpec, ModuleType, SellUnit,
} from "../domain/types.js";

/** 系统默认材质 token（厂商可覆盖 / 增补）。 */
export const DEFAULT_MATERIAL_TOKENS: Record<string, string> = {
  PLY: "Plywood",
  PB: "Particle Board",
};

/** 系统默认花色 token（厂商可覆盖 / 增补）。 */
export const DEFAULT_FINISH_TOKENS: Record<string, string> = {
  MNW: "Melamine Natural Wood",
  PGW: "PET Glossy White",
  WSS: "White Shaker",
  SSW: "Slim Shaker White",
};

const TRIM_TYPES: ReadonlySet<ModuleType> = new Set([
  "filler", "panel", "toeKick", "crown", "leg",
]);

export interface SellUnitResolution {
  sellUnit: SellUnit;
  /** 是否由启发式推断（非规格声明）——导入校验可标待确认。 */
  inferred: boolean;
  /** 判定依据，便于审计 / 测试。 */
  reason: string;
}

export interface ResolveSellUnitInput {
  code: string;
  type?: ModuleType;
  /** 规格声明；有则直接采用（除非与 trim 类型自相矛盾，由校验层拒绝）。 */
  declared?: SellUnit;
  codingRules?: CompanyCodingRules;
}

/**
 * 解析一个型号的售卖单元。
 */
export function resolveSellUnit(input: ResolveSellUnitInput): SellUnitResolution {
  if (input.declared) {
    return {
      sellUnit: input.declared,
      inferred: false,
      reason: "declared on ModuleSpec",
    };
  }

  if (input.type && TRIM_TYPES.has(input.type)) {
    return {
      sellUnit: "standalone",
      inferred: true,
      reason: `ModuleType ${input.type} is trim/standalone`,
    };
  }

  const usesSuffix = input.codingRules?.usesBoxDoorSuffixes !== false;
  const upper = input.code.toUpperCase();

  if (usesSuffix) {
    if (/(?:^|-)BOX$/i.test(input.code) || upper.endsWith("-BOX")) {
      return { sellUnit: "box", inferred: true, reason: "code suffix -BOX" };
    }
    if (/(?:^|-)DOOR$/i.test(input.code) || upper.endsWith("-DOOR")) {
      return { sellUnit: "door", inferred: true, reason: "code suffix -DOOR" };
    }
  }

  const materials = {
    ...DEFAULT_MATERIAL_TOKENS,
    ...(input.codingRules?.materialTokens ?? {}),
  };
  const finishes = {
    ...DEFAULT_FINISH_TOKENS,
    ...(input.codingRules?.finishTokens ?? {}),
  };
  const tokens = splitCodeTokens(input.code);
  const hasMaterial = tokens.some((t) => t in materials);
  const hasFinish = tokens.some((t) => t in finishes);
  if (hasMaterial && hasFinish) {
    return {
      sellUnit: "combo",
      inferred: true,
      reason: "material + finish tokens without split suffix",
    };
  }

  return {
    sellUnit: "combo",
    inferred: true,
    reason: "default combo (logical SKU × door price group)",
  };
}

/** 从 ModuleSpec（+ 可选公司规则）解析。 */
export function resolveModuleSellUnit(
  mod: Pick<ModuleSpec, "code" | "type" | "sellUnit">,
  codingRules?: CompanyCodingRules,
): SellUnitResolution {
  return resolveSellUnit({
    code: mod.code,
    type: mod.type,
    declared: mod.sellUnit,
    codingRules,
  });
}

/** 独立件 / trim —— 不得进门板从属明细。 */
export function isStandaloneSellUnit(unit: SellUnit): boolean {
  return unit === "standalone";
}

/**
 * PriceGroup.code 是否在冒充 BOX/DOOR 后缀（FR-16 禁止）。
 * 例：`PLY-BOX`、`MNW-DOOR`。
 */
export function priceGroupLooksLikeBoxDoorSuffix(code: string): boolean {
  const u = code.trim().toUpperCase();
  return /(?:^|-)BOX$/.test(u) || /(?:^|-)DOOR$/.test(u);
}

/** 把 `B12-PLY-MNW` / `B12-PLY-BOX` 拆成大写 token。 */
export function splitCodeTokens(code: string): string[] {
  return code
    .toUpperCase()
    .split(/[-_/]/)
    .map((t) => t.trim())
    .filter(Boolean);
}
