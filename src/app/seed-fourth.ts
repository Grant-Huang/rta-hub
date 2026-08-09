/**
 * 第四家试点公司 —— Oppein Canada（欧派海外渠道）
 *
 * 产品数据来源：OCCW SPEC BOOK / MSRP / 编码字典。
 *
 * FR-16：售卖单元用**真实模块行**表达，禁止 PriceGroup 冒充 -BOX/-DOOR：
 * - 逻辑柜型 `B12` → sellUnit=combo（型号 × 门板价格组）
 * - 拆卖 SKU `B12-PLY-BOX` / `B12-MNW-DOOR` / `B12-PLY-MNW` → 独立模块行
 * - 价格组只表示门板花色档（MNW/PGW/…），箱体板材走 BoxMaterialOption
 */
import type {
  BoxMaterialOption, CabinetCompany, CompanyCodingRules, DoorStyle, ModuleSpec,
  PriceGroup, PriceMatrixEntry, ProductSpecVersion,
} from "../domain/types.js";
import { fromDollars } from "../domain/money.js";

export const OPPEIN_COMPANY_ID = "co_oppein";
export const OPPEIN_SPEC_VERSION_ID = "spec_oppein_v1";
const NOW = "2026-01-01T00:00:00.000Z";

export const oppeinCodingRules: CompanyCodingRules = {
  usesBoxDoorSuffixes: true,
  prefixGuide: [
    { pattern: "^B\\d", meaning: "base, typically 1 drawer over door", mapsToRoles: ["doorStorage", "drawerStorage"] },
    { pattern: "^3DB", meaning: "3-drawer base", mapsToRoles: ["drawerStorage"] },
    { pattern: "^2DB", meaning: "2-drawer base", mapsToRoles: ["drawerStorage"] },
    { pattern: "^SB", meaning: "sink base", mapsToRoles: ["sinkBase"] },
    { pattern: "^W\\d", meaning: "wall cabinet", mapsToRoles: ["doorStorage"] },
    { pattern: "^PC", meaning: "pantry / tall", mapsToRoles: ["doorStorage"] },
    { pattern: "^BBC|^BLS", meaning: "blind / lazy-susan corner", mapsToRoles: ["cornerAccess"] },
    { pattern: "^WF|^TK", meaning: "filler / toe kick", mapsToRoles: ["trim"] },
  ],
  materialTokens: { PLY: "Plywood", PB: "Particle Board" },
  finishTokens: {
    MNW: "Melamine Natural Wood",
    PGW: "PET Glossy White",
    WSS: "White Shaker",
    SSW: "Slim Shaker White",
  },
};

export const oppeinCompany: CabinetCompany = {
  id: OPPEIN_COMPANY_ID,
  name: "Oppein Canada",
  aliases: ["欧派加拿大", "Oppein", "欧派", "OCCW"],
  quoteEmail: "quotes@oppein.ca",
  website: "https://oppein.ca",
  contactName: "Oppein Sales",
  province: "ON",
  serviceAreas: ["ON", "BC", "AB", "QC"],
  billingPlan: { leadFeeEnabled: true, personalizationSubscription: "active" },
  currentPublishedSpecVersionId: OPPEIN_SPEC_VERSION_ID,
  createdAt: NOW,
};

export const oppeinSpecVersion: ProductSpecVersion = {
  id: OPPEIN_SPEC_VERSION_ID,
  companyId: OPPEIN_COMPANY_ID,
  versionNo: 1,
  status: "published",
  currency: "CAD",
  construction: "frameless",
  overlay: "full",
  codingRules: oppeinCodingRules,
  effectiveFrom: NOW,
  publishedAt: NOW,
  publishedBy: "ops@oppein.ca",
  changeNote: "Oppein Canada 初始版本 — FR-16 真实 BOX/DOOR/combo 模块行",
};

const base = { specVersionId: OPPEIN_SPEC_VERSION_ID, companyId: OPPEIN_COMPANY_ID };

/** 门板花色价格组——不再用 PLY-BOX / MNW-DOOR 冒充售卖单元。 */
export const oppeinPriceGroups: PriceGroup[] = [
  { ...base, id: "pg_mnw", code: "MNW", displayName: "Melamine Natural Wood", rank: 1 },
  { ...base, id: "pg_pgw", code: "PGW", displayName: "PET Glossy White", rank: 2 },
  { ...base, id: "pg_wss", code: "WSS", displayName: "White Shaker", rank: 3 },
  { ...base, id: "pg_ssw", code: "SSW", displayName: "Slim Shaker White", rank: 4 },
];

export const oppeinDoorStyles: DoorStyle[] = [
  { ...base, id: "ds_mnw", name: "Melamine Natural Wood", priceGroupId: "pg_mnw", material: "Melamine", color: "Natural Wood" },
  { ...base, id: "ds_pgw", name: "PET Glossy White", priceGroupId: "pg_pgw", material: "PET", color: "Glossy White" },
  { ...base, id: "ds_wss", name: "White Shaker", priceGroupId: "pg_wss", material: "MDF", color: "White" },
  { ...base, id: "ds_ssw", name: "Slim Shaker White", priceGroupId: "pg_ssw", material: "MDF", color: "White" },
];

/** 箱体板材——与门板花色正交；PB 相对 PLY 的差价作修饰。 */
export const oppeinBoxMaterials: BoxMaterialOption[] = [
  {
    ...base, id: "bm_oppein_ply", code: "plywood", name: "Plywood box",
    isDefault: true, priceModifier: { kind: "flat", value: fromDollars(0) },
  },
  {
    ...base, id: "bm_oppein_pb", code: "particleBoard", name: "Particle board box",
    isDefault: false, priceModifier: { kind: "percent", value: -30 },
    note: "Particle board carcass discount vs plywood list",
  },
];

type LogicDef = {
  code: string;
  type: ModuleSpec["type"];
  width: number;
  height: number;
  depth: number;
  sellUnit?: ModuleSpec["sellUnit"];
  finishDependent?: boolean;
};

const LOGIC: LogicDef[] = [
  // 地柜 B
  ...[12, 15, 18, 21, 24, 30, 36, 42].map((w) => ({ code: `B${w}`, type: "base" as const, width: w, height: 30, depth: 23.875 })),
  // FH
  ...[12, 15, 18, 24, 30, 36].map((w) => ({ code: `B${w}FH`, type: "base" as const, width: w, height: 30, depth: 23.875 })),
  // 3DB / 2DB
  ...[12, 15, 18, 21, 24, 30, 36].map((w) => ({ code: `3DB${w}`, type: "base" as const, width: w, height: 30, depth: 23.875 })),
  { code: "2DB30", type: "base", width: 30, height: 30, depth: 23.875 },
  { code: "2DB36", type: "base", width: 36, height: 30, depth: 23.875 },
  // SB
  ...[30, 33, 36, 42].map((w) => ({ code: `SB${w}`, type: "sinkBase" as const, width: w, height: 30, depth: 23.875 })),
  // W
  { code: "W1230", type: "wall", width: 12, height: 30, depth: 12 },
  { code: "W1530", type: "wall", width: 15, height: 30, depth: 12 },
  { code: "W1830", type: "wall", width: 18, height: 30, depth: 12 },
  { code: "W2430", type: "wall", width: 24, height: 30, depth: 12 },
  { code: "W3030", type: "wall", width: 30, height: 30, depth: 12 },
  { code: "W3630", type: "wall", width: 36, height: 30, depth: 12 },
  { code: "W2436", type: "wall", width: 24, height: 36, depth: 12 },
  { code: "W3036", type: "wall", width: 30, height: 36, depth: 12 },
  { code: "W3636", type: "wall", width: 36, height: 36, depth: 12 },
  { code: "W2442", type: "wall", width: 24, height: 42, depth: 12 },
  { code: "W3042", type: "wall", width: 30, height: 42, depth: 12 },
  { code: "W3642", type: "wall", width: 36, height: 42, depth: 12 },
  // PC
  ...([18, 24, 30] as const).flatMap((w) =>
    ([84, 90, 96] as const).map((h) => ({ code: `PC${w}${h}`, type: "tall" as const, width: w, height: h, depth: 24 }))),
  // corner / special
  { code: "BBC42", type: "corner", width: 42, height: 30, depth: 23.875 },
  { code: "BLS36", type: "corner", width: 36, height: 30, depth: 23.875 },
  { code: "BTC18", type: "base", width: 18, height: 30, depth: 23.875 },
  // trim
  { code: "WF3", type: "filler", width: 3, height: 30, depth: 0.75, sellUnit: "standalone" },
  { code: "TK", type: "toeKick", width: 96, height: 4.5, depth: 0.25, sellUnit: "standalone", finishDependent: false },
];

function logicModule(d: LogicDef): ModuleSpec {
  return {
    ...base,
    id: `oppein_${d.code}`,
    code: d.code,
    type: d.type,
    sellUnit: d.sellUnit ?? (d.type === "filler" || d.type === "toeKick" || d.type === "panel" || d.type === "crown" || d.type === "leg"
      ? "standalone" : "combo"),
    widthOptions: [d.width],
    heightOptions: d.code === "WF3" ? [30, 36, 42] : [d.height],
    depthOptions: [d.depth],
    assemblyOptions: ["RTA"],
    ...(d.finishDependent === false ? { finishDependent: false } : {}),
  };
}

/** 代表性拆卖 SKU（真实 BOX / DOOR / combo 行）——布局器会跳过 box/door。 */
const SPLIT_SAMPLES = ["B12", "B24", "SB36", "W2430"] as const;
const FINISHES = ["MNW", "PGW", "WSS", "SSW"] as const;

function splitModules(): ModuleSpec[] {
  const out: ModuleSpec[] = [];
  for (const code of SPLIT_SAMPLES) {
    const logic = LOGIC.find((d) => d.code === code)!;
    for (const mat of ["PLY", "PB"] as const) {
      out.push({
        ...base,
        id: `oppein_${code}-${mat}-BOX`,
        code: `${code}-${mat}-BOX`,
        type: logic.type,
        sellUnit: "box",
        finishDependent: false,
        widthOptions: [logic.width],
        heightOptions: [logic.height],
        depthOptions: [logic.depth],
        assemblyOptions: ["RTA"],
      });
    }
    for (const fin of FINISHES) {
      out.push({
        ...base,
        id: `oppein_${code}-${fin}-DOOR`,
        code: `${code}-${fin}-DOOR`,
        type: logic.type,
        sellUnit: "door",
        widthOptions: [logic.width],
        heightOptions: [logic.height],
        depthOptions: [0.75],
        assemblyOptions: ["RTA"],
      });
    }
    for (const fin of FINISHES) {
      out.push({
        ...base,
        id: `oppein_${code}-PLY-${fin}`,
        code: `${code}-PLY-${fin}`,
        type: logic.type,
        sellUnit: "combo",
        widthOptions: [logic.width],
        heightOptions: [logic.height],
        depthOptions: [logic.depth],
        assemblyOptions: ["RTA"],
      });
    }
  }
  return out;
}

export const oppeinModuleSpecs: ModuleSpec[] = [
  ...LOGIC.map(logicModule),
  ...splitModules(),
];

const boxPrices: Record<string, { ply: number; pb: number }> = {
  "B12": { ply: 235, pb: 161 },
  "B15": { ply: 262, pb: 175 },
  "B18": { ply: 289, pb: 189 },
  "B21": { ply: 316, pb: 203 },
  "B24": { ply: 356, pb: 235 },
  "B30": { ply: 411, pb: 264 },
  "B36": { ply: 468, pb: 297 },
  "B42": { ply: 522, pb: 326 },
  "B12FH": { ply: 229, pb: 162 },
  "B15FH": { ply: 250, pb: 175 },
  "B18FH": { ply: 270, pb: 189 },
  "B24FH": { ply: 324, pb: 231 },
  "B30FH": { ply: 364, pb: 258 },
  "B36FH": { ply: 408, pb: 290 },
  "3DB12": { ply: 213, pb: 122 },
  "3DB15": { ply: 246, pb: 143 },
  "3DB18": { ply: 280, pb: 165 },
  "3DB21": { ply: 313, pb: 186 },
  "3DB24": { ply: 346, pb: 207 },
  "3DB30": { ply: 414, pb: 250 },
  "3DB36": { ply: 484, pb: 295 },
  "2DB30": { ply: 376, pb: 0 },
  "2DB36": { ply: 434, pb: 0 },
  "SB30": { ply: 288, pb: 203 },
  "SB33": { ply: 309, pb: 218 },
  "SB36": { ply: 330, pb: 234 },
  "SB42": { ply: 363, pb: 258 },
  "W1230": { ply: 154, pb: 108 },
  "W1530": { ply: 173, pb: 121 },
  "W1830": { ply: 192, pb: 133 },
  "W2430": { ply: 243, pb: 172 },
  "W3030": { ply: 281, pb: 196 },
  "W3630": { ply: 318, pb: 221 },
  "W2436": { ply: 277, pb: 200 },
  "W3036": { ply: 317, pb: 226 },
  "W3636": { ply: 356, pb: 251 },
  "W2442": { ply: 326, pb: 232 },
  "W3042": { ply: 375, pb: 264 },
  "W3642": { ply: 424, pb: 296 },
  "PC1884": { ply: 702, pb: 477 },
  "PC1890": { ply: 738, pb: 500 },
  "PC1896": { ply: 770, pb: 522 },
  "PC2484": { ply: 861, pb: 594 },
  "PC2490": { ply: 895, pb: 617 },
  "PC2496": { ply: 929, pb: 639 },
  "PC3084": { ply: 973, pb: 668 },
  "PC3090": { ply: 1008, pb: 691 },
  "PC3096": { ply: 1044, pb: 715 },
  "BBC42": { ply: 403, pb: 324 },
  "BLS36": { ply: 711, pb: 484 },
  "BTC18": { ply: 254, pb: 166 },
};

const doorPrices: Record<string, { mnw: number; pgw: number; wss: number; ssw: number }> = {
  "B12": { mnw: 32, pgw: 70, wss: 81, ssw: 88 },
  "B15": { mnw: 39, pgw: 86, wss: 101, ssw: 109 },
  "B18": { mnw: 47, pgw: 104, wss: 121, ssw: 132 },
  "B21": { mnw: 55, pgw: 122, wss: 141, ssw: 153 },
  "B24": { mnw: 63, pgw: 138, wss: 161, ssw: 175 },
  "B30": { mnw: 79, pgw: 172, wss: 202, ssw: 218 },
  "B36": { mnw: 95, pgw: 208, wss: 242, ssw: 262 },
  "B42": { mnw: 111, pgw: 296, wss: 283, ssw: 305 },
  "B12FH": { mnw: 32, pgw: 70, wss: 81, ssw: 88 },
  "B15FH": { mnw: 39, pgw: 86, wss: 101, ssw: 109 },
  "B18FH": { mnw: 47, pgw: 104, wss: 121, ssw: 132 },
  "B24FH": { mnw: 63, pgw: 138, wss: 161, ssw: 175 },
  "B30FH": { mnw: 79, pgw: 172, wss: 202, ssw: 218 },
  "B36FH": { mnw: 95, pgw: 208, wss: 242, ssw: 262 },
  "3DB12": { mnw: 32, pgw: 70, wss: 81, ssw: 88 },
  "3DB15": { mnw: 39, pgw: 86, wss: 101, ssw: 109 },
  "3DB18": { mnw: 47, pgw: 104, wss: 121, ssw: 132 },
  "3DB21": { mnw: 55, pgw: 122, wss: 141, ssw: 153 },
  "3DB24": { mnw: 63, pgw: 138, wss: 161, ssw: 175 },
  "3DB30": { mnw: 79, pgw: 172, wss: 202, ssw: 218 },
  "3DB36": { mnw: 95, pgw: 208, wss: 242, ssw: 262 },
  "2DB30": { mnw: 79, pgw: 172, wss: 202, ssw: 218 },
  "2DB36": { mnw: 95, pgw: 208, wss: 242, ssw: 262 },
  "SB30": { mnw: 79, pgw: 172, wss: 202, ssw: 218 },
  "SB33": { mnw: 87, pgw: 190, wss: 222, ssw: 239 },
  "SB36": { mnw: 95, pgw: 208, wss: 242, ssw: 262 },
  "SB42": { mnw: 111, pgw: 296, wss: 283, ssw: 305 },
  "W1230": { mnw: 32, pgw: 70, wss: 81, ssw: 88 },
  "W1530": { mnw: 39, pgw: 86, wss: 101, ssw: 109 },
  "W1830": { mnw: 47, pgw: 104, wss: 121, ssw: 132 },
  "W2430": { mnw: 63, pgw: 138, wss: 161, ssw: 175 },
  "W3030": { mnw: 79, pgw: 172, wss: 202, ssw: 218 },
  "W3630": { mnw: 95, pgw: 208, wss: 242, ssw: 262 },
  "W2436": { mnw: 76, pgw: 166, wss: 194, ssw: 209 },
  "W3036": { mnw: 91, pgw: 199, wss: 232, ssw: 251 },
  "W3636": { mnw: 107, pgw: 234, wss: 274, ssw: 296 },
  "W2442": { mnw: 89, pgw: 193, wss: 226, ssw: 244 },
  "W3042": { mnw: 102, pgw: 223, wss: 261, ssw: 282 },
  "W3642": { mnw: 118, pgw: 258, wss: 302, ssw: 326 },
  "PC1884": { mnw: 125, pgw: 275, wss: 321, ssw: 346 },
  "PC1890": { mnw: 135, pgw: 295, wss: 345, ssw: 373 },
  "PC1896": { mnw: 144, pgw: 316, wss: 369, ssw: 398 },
  "PC2484": { mnw: 167, pgw: 366, wss: 428, ssw: 462 },
  "PC2490": { mnw: 180, pgw: 393, wss: 460, ssw: 496 },
  "PC2496": { mnw: 192, pgw: 420, wss: 492, ssw: 530 },
  "PC3084": { mnw: 209, pgw: 457, wss: 535, ssw: 576 },
  "PC3090": { mnw: 225, pgw: 491, wss: 575, ssw: 619 },
  "PC3096": { mnw: 240, pgw: 526, wss: 616, ssw: 663 },
  "BBC42": { mnw: 57, pgw: 120, wss: 140, ssw: 157 },
  "BLS36": { mnw: 64, pgw: 140, wss: 164, ssw: 177 },
  "BTC18": { mnw: 47, pgw: 104, wss: 121, ssw: 132 },
};

const PG: Record<(typeof FINISHES)[number], string> = {
  MNW: "pg_mnw", PGW: "pg_pgw", WSS: "pg_wss", SSW: "pg_ssw",
};

function priceEntry(moduleCode: string, priceGroupId: string, priceCAD: number): PriceMatrixEntry {
  return {
    ...base,
    moduleId: `oppein_${moduleCode}`,
    priceGroupId,
    listPrice: fromDollars(priceCAD),
  };
}

export const oppeinPriceMatrix: PriceMatrixEntry[] = [];

// 逻辑柜型 combo：PLY 箱体 + 门板（默认 plywood list；PB 靠 boxMaterial 修饰）
for (const [code, boxP] of Object.entries(boxPrices)) {
  const doorP = doorPrices[code];
  if (!doorP || boxP.ply <= 0) continue;
  oppeinPriceMatrix.push(priceEntry(code, "pg_mnw", boxP.ply + doorP.mnw));
  oppeinPriceMatrix.push(priceEntry(code, "pg_pgw", boxP.ply + doorP.pgw));
  oppeinPriceMatrix.push(priceEntry(code, "pg_wss", boxP.ply + doorP.wss));
  oppeinPriceMatrix.push(priceEntry(code, "pg_ssw", boxP.ply + doorP.ssw));
}

// trim：finishDependent 默认 true 的 filler 每组一行；TK 不随花色
for (const pgId of Object.values(PG)) {
  oppeinPriceMatrix.push(priceEntry("WF3", pgId, 35));
}
oppeinPriceMatrix.push(priceEntry("TK", "pg_mnw", 40));

// 拆卖 SKU 矩阵
for (const code of SPLIT_SAMPLES) {
  const boxP = boxPrices[code];
  const doorP = doorPrices[code];
  if (!boxP || !doorP) continue;
  if (boxP.ply > 0) {
    for (const pgId of Object.values(PG)) {
      oppeinPriceMatrix.push(priceEntry(`${code}-PLY-BOX`, pgId, boxP.ply));
    }
  }
  if (boxP.pb > 0) {
    for (const pgId of Object.values(PG)) {
      oppeinPriceMatrix.push(priceEntry(`${code}-PB-BOX`, pgId, boxP.pb));
    }
  }
  const doorMap = { MNW: doorP.mnw, PGW: doorP.pgw, WSS: doorP.wss, SSW: doorP.ssw } as const;
  for (const fin of FINISHES) {
    oppeinPriceMatrix.push(priceEntry(`${code}-${fin}-DOOR`, PG[fin], doorMap[fin]));
    if (boxP.ply > 0) {
      oppeinPriceMatrix.push(priceEntry(`${code}-PLY-${fin}`, PG[fin], boxP.ply + doorMap[fin]));
    }
  }
}

export function buildOppeinCompanyBundle() {
  return {
    company: oppeinCompany,
    specVersion: oppeinSpecVersion,
    priceGroups: oppeinPriceGroups,
    doorStyles: oppeinDoorStyles,
    modules: oppeinModuleSpecs,
    priceMatrix: oppeinPriceMatrix,
    boxMaterialOptions: oppeinBoxMaterials,
    hardwareOptions: [],
    accessoryOptions: [],
    discountRules: [],
    shippingRule: undefined,
  };
}
