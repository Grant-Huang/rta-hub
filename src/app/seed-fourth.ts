/**
 * 第四家试点公司 —— Oppein Canada（欧派海外渠道）
 * 
 * 产品数据来源：
 * - OCCW SPEC BOOK 2026-02.pdf
 * - OCCW-MSRP-2026.xlsx
 * - 欧派编码字典.xlsx
 * 
 * 编码规则：
 * - 柜体：B12-PLY-BOX (夹板), B12-PB-BOX (刨花板)
 * - 门板：B12-MNW-DOOR (胭脂木), B12-PGW-DOOR (高光白), B12-WSS-DOOR (白Shaker), B12-SSW-DOOR (窄边Shaker)
 * - 组合件：B12-PLY-MNW (夹板柜体+胭脂木门板)
 */
import type { CabinetCompany, ProductSpecVersion, ModuleSpec, DoorStyle, PriceGroup, PriceMatrixEntry } from "../domain/types.js";
import { fromDollars } from "../domain/money.js";

export const OPPEIN_COMPANY_ID = "co_oppein";
export const OPPEIN_SPEC_VERSION_ID = "spec_oppein_v1";
const NOW = "2026-01-01T00:00:00.000Z";

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
  effectiveFrom: NOW,
  publishedAt: NOW,
  publishedBy: "ops@oppein.ca",
  changeNote: "Oppein Canada 初始版本 - 欧派海外渠道 RTA 橱柜",
};

const base = { specVersionId: OPPEIN_SPEC_VERSION_ID, companyId: OPPEIN_COMPANY_ID };

/** 柜体材质分组 */
export const oppeinPriceGroups: PriceGroup[] = [
  // 柜体材质
  { ...base, id: "pg_ply_box", code: "PLY-BOX", displayName: "夹板柜体 (Plywood)", rank: 1 },
  { ...base, id: "pg_pb_box", code: "PB-BOX", displayName: "刨花板柜体 (Particle Board)", rank: 2 },
  // 门板花色
  { ...base, id: "pg_mnw_door", code: "MNW-DOOR", displayName: "胭脂木门板 (Melamine Natural Wood)", rank: 3 },
  { ...base, id: "pg_pgw_door", code: "PGW-DOOR", displayName: "高光白门板 (PET Glossy White)", rank: 4 },
  { ...base, id: "pg_wss_door", code: "WSS-DOOR", displayName: "白Shaker门板 (White Shaker)", rank: 5 },
  { ...base, id: "pg_ssw_door", code: "SSW-DOOR", displayName: "窄边Shaker门板 (Slim Shaker White)", rank: 6 },
  // 组合件（柜体+门板）
  { ...base, id: "pg_ply_mnw", code: "PLY-MNW", displayName: "夹板+胭脂木组合件", rank: 7 },
  { ...base, id: "pg_ply_pgw", code: "PLY-PGW", displayName: "夹板+高光白组合件", rank: 8 },
  { ...base, id: "pg_ply_wss", code: "PLY-WSS", displayName: "夹板+白Shaker组合件", rank: 9 },
  { ...base, id: "pg_ply_ssw", code: "PLY-SSW", displayName: "夹板+窄边Shaker组合件", rank: 10 },
];

/** 门板花色定义 */
export const oppeinDoorStyles: DoorStyle[] = [
  { ...base, id: "ds_mnw", name: "胭脂木 (Melamine Natural Wood)", priceGroupId: "pg_mnw_door", material: "Melamine", color: "Natural Wood" },
  { ...base, id: "ds_pgw", name: "高光白 (PET Glossy White)", priceGroupId: "pg_pgw_door", material: "PET", color: "Glossy White" },
  { ...base, id: "ds_wss", name: "白Shaker (White Shaker)", priceGroupId: "pg_wss_door", material: "MDF", color: "White" },
  { ...base, id: "ds_ssw", name: "窄边Shaker (Slim Shaker White)", priceGroupId: "pg_ssw_door", material: "MDF", color: "White" },
];

/** Oppein 型号定义 */
export const oppeinModuleSpecs: ModuleSpec[] = [
  // ========== 地柜 B系列 ==========
  { ...base, id: "oppein_B12", code: "B12", type: "base", widthOptions: [12], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_B15", code: "B15", type: "base", widthOptions: [15], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_B18", code: "B18", type: "base", widthOptions: [18], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_B21", code: "B21", type: "base", widthOptions: [21], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_B24", code: "B24", type: "base", widthOptions: [24], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_B30", code: "B30", type: "base", widthOptions: [30], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_B36", code: "B36", type: "base", widthOptions: [36], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_B42", code: "B42", type: "base", widthOptions: [42], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },

  // ========== 全开门地柜 FH系列 ==========
  { ...base, id: "oppein_B12FH", code: "B12FH", type: "base", widthOptions: [12], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_B15FH", code: "B15FH", type: "base", widthOptions: [15], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_B18FH", code: "B18FH", type: "base", widthOptions: [18], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_B24FH", code: "B24FH", type: "base", widthOptions: [24], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_B30FH", code: "B30FH", type: "base", widthOptions: [30], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_B36FH", code: "B36FH", type: "base", widthOptions: [36], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },

  // ========== 抽屉地柜 3DB ==========
  { ...base, id: "oppein_3DB12", code: "3DB12", type: "base", widthOptions: [12], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_3DB15", code: "3DB15", type: "base", widthOptions: [15], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_3DB18", code: "3DB18", type: "base", widthOptions: [18], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_3DB21", code: "3DB21", type: "base", widthOptions: [21], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_3DB24", code: "3DB24", type: "base", widthOptions: [24], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_3DB30", code: "3DB30", type: "base", widthOptions: [30], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_3DB36", code: "3DB36", type: "base", widthOptions: [36], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },

  // ========== 2DB 双抽 ==========
  { ...base, id: "oppein_2DB30", code: "2DB30", type: "base", widthOptions: [30], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_2DB36", code: "2DB36", type: "base", widthOptions: [36], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },

  // ========== 水槽柜 SB ==========
  { ...base, id: "oppein_SB30", code: "SB30", type: "sinkBase", widthOptions: [30], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_SB33", code: "SB33", type: "sinkBase", widthOptions: [33], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_SB36", code: "SB36", type: "sinkBase", widthOptions: [36], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_SB42", code: "SB42", type: "sinkBase", widthOptions: [42], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },

  // ========== 吊柜 W系列 ==========
  { ...base, id: "oppein_W1230", code: "W1230", type: "wall", widthOptions: [12], heightOptions: [30], depthOptions: [12], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_W1530", code: "W1530", type: "wall", widthOptions: [15], heightOptions: [30], depthOptions: [12], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_W1830", code: "W1830", type: "wall", widthOptions: [18], heightOptions: [30], depthOptions: [12], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_W2430", code: "W2430", type: "wall", widthOptions: [24], heightOptions: [30], depthOptions: [12], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_W3030", code: "W3030", type: "wall", widthOptions: [30], heightOptions: [30], depthOptions: [12], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_W3630", code: "W3630", type: "wall", widthOptions: [36], heightOptions: [30], depthOptions: [12], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_W2436", code: "W2436", type: "wall", widthOptions: [24], heightOptions: [36], depthOptions: [12], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_W3036", code: "W3036", type: "wall", widthOptions: [30], heightOptions: [36], depthOptions: [12], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_W3636", code: "W3636", type: "wall", widthOptions: [36], heightOptions: [36], depthOptions: [12], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_W2442", code: "W2442", type: "wall", widthOptions: [24], heightOptions: [42], depthOptions: [12], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_W3042", code: "W3042", type: "wall", widthOptions: [30], heightOptions: [42], depthOptions: [12], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_W3642", code: "W3642", type: "wall", widthOptions: [36], heightOptions: [42], depthOptions: [12], assemblyOptions: ["RTA"] },

  // ========== 高柜 PC系列 ==========
  { ...base, id: "oppein_PC1884", code: "PC1884", type: "tall", widthOptions: [18], heightOptions: [84], depthOptions: [24], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_PC1890", code: "PC1890", type: "tall", widthOptions: [18], heightOptions: [90], depthOptions: [24], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_PC1896", code: "PC1896", type: "tall", widthOptions: [18], heightOptions: [96], depthOptions: [24], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_PC2484", code: "PC2484", type: "tall", widthOptions: [24], heightOptions: [84], depthOptions: [24], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_PC2490", code: "PC2490", type: "tall", widthOptions: [24], heightOptions: [90], depthOptions: [24], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_PC2496", code: "PC2496", type: "tall", widthOptions: [24], heightOptions: [96], depthOptions: [24], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_PC3084", code: "PC3084", type: "tall", widthOptions: [30], heightOptions: [84], depthOptions: [24], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_PC3090", code: "PC3090", type: "tall", widthOptions: [30], heightOptions: [90], depthOptions: [24], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_PC3096", code: "PC3096", type: "tall", widthOptions: [30], heightOptions: [96], depthOptions: [24], assemblyOptions: ["RTA"] },

  // ========== 特殊功能柜 ==========
  { ...base, id: "oppein_BBC42", code: "BBC42", type: "corner", widthOptions: [42], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_BLS36", code: "BLS36", type: "corner", widthOptions: [36], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_BTC18", code: "BTC18", type: "base", widthOptions: [18], heightOptions: [30], depthOptions: [23.875], assemblyOptions: ["RTA"] },

  // ========== 配件（Filler 等独立产品，无门板） ==========
  { ...base, id: "oppein_WF3", code: "WF3", type: "filler", widthOptions: [3], heightOptions: [30, 36, 42], depthOptions: [0.75], assemblyOptions: ["RTA"] },
  { ...base, id: "oppein_TK", code: "TK", type: "toeKick", widthOptions: [96], heightOptions: [4.5], depthOptions: [0.25], assemblyOptions: ["RTA"] },
];

/**
 * Oppein 价格矩阵 (MSRP 2026 CAD)
 * 
 * 包含：
 * 1. 柜体价格 (-BOX)：PLY 和 PB 两种材质
 * 2. 门板价格 (-DOOR)：MNW, PGW, WSS, SSW 四种花色
 * 3. 组合件价格：无后缀，PLY+花色
 * 
 * Filler/TK 等配件无门板变体
 */

// 辅助函数：生成价格矩阵条目
function priceEntry(moduleCode: string, priceGroupId: string, priceCAD: number): PriceMatrixEntry {
  const moduleId = `oppein_${moduleCode}`;
  return { ...base, moduleId, priceGroupId, listPrice: fromDollars(priceCAD) };
}

// 核心型号价格（部分示例）
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
  "2DB30": { ply: 376, pb: 0 },  // 无PB
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

// 生成完整价格矩阵
export const oppeinPriceMatrix: PriceMatrixEntry[] = [];

// 1. 柜体价格 (-BOX)
for (const [code, prices] of Object.entries(boxPrices)) {
  // PLY 柜体
  if (prices.ply > 0) {
    oppeinPriceMatrix.push(priceEntry(code, "pg_ply_box", prices.ply));
  }
  // PB 柜体
  if (prices.pb > 0) {
    oppeinPriceMatrix.push(priceEntry(code, "pg_pb_box", prices.pb));
  }
}

// 2. 门板价格 (-DOOR)
for (const [code, prices] of Object.entries(doorPrices)) {
  oppeinPriceMatrix.push(priceEntry(code, "pg_mnw_door", prices.mnw));
  oppeinPriceMatrix.push(priceEntry(code, "pg_pgw_door", prices.pgw));
  oppeinPriceMatrix.push(priceEntry(code, "pg_wss_door", prices.wss));
  oppeinPriceMatrix.push(priceEntry(code, "pg_ssw_door", prices.ssw));
}

// 3. 组合件价格 (PLY + 门板花色)
for (const [code, boxP] of Object.entries(boxPrices)) {
  if (boxP.ply > 0 && doorPrices[code]) {
    const doorP = doorPrices[code];
    oppeinPriceMatrix.push(priceEntry(code, "pg_ply_mnw", boxP.ply + doorP.mnw));
    oppeinPriceMatrix.push(priceEntry(code, "pg_ply_pgw", boxP.ply + doorP.pgw));
    oppeinPriceMatrix.push(priceEntry(code, "pg_ply_wss", boxP.ply + doorP.wss));
    oppeinPriceMatrix.push(priceEntry(code, "pg_ply_ssw", boxP.ply + doorP.ssw));
  }
}

// 4. 配件（Filler, TK 无门板变体）
oppeinPriceMatrix.push(priceEntry("WF3", "pg_ply_box", 35));
oppeinPriceMatrix.push(priceEntry("TK", "pg_ply_box", 40));

/** 导出完整厂商数据 */
export function buildOppeinCompanyBundle() {
  return {
    company: oppeinCompany,
    specVersion: oppeinSpecVersion,
    priceGroups: oppeinPriceGroups,
    doorStyles: oppeinDoorStyles,
    modules: oppeinModuleSpecs,
    priceMatrix: oppeinPriceMatrix,
    hardwareOptions: [],
    accessoryOptions: [],
    discountRules: [],
    shippingRule: undefined,
  };
}
