/**
 * 15 个正视图脸型模板 + SKU → 脸型的规则匹配 —— docs/RENDERING.md 第 3、5 节。
 *
 * 数据全部来自 rta-generic-spec/ 的尺寸与编码规范，核实结果见 RENDERING.md 附录 A。
 * 已知的规范文档缺陷（4DB 抽屉高度合计 29" ≠ 30"）在此处按可用脸高均分修正，
 * 见 `FACE_TEMPLATES.F6_DRAWER_STACK` 的注释。
 */
import type { FaceSpec } from "./face-grammar.js";

/** 地柜可用脸高 = 柜体 34.5" − 踢脚 4.5"（规范文档 A5，已核实自洽）。 */
export const BASE_FACE_HEIGHT = 30;
/** 地柜顶部抽屉的行业标准高度。 */
export const BASE_TOP_DRAWER_HEIGHT = 6;

export type FaceTemplateId =
  | "F1_SINGLE_DOOR" | "F2_DOUBLE_DOOR" | "F3_DRAWER_OVER_DOOR"
  | "F4_DRAWER_OVER_DOUBLE" | "F5_TWO_DRAWERS_OVER_DOUBLE" | "F6_DRAWER_STACK"
  | "F7_FALSE_FRONT_DOUBLE" | "F8_APRON_SINK" | "F9_DIAGONAL_CORNER"
  | "F10_BLIND_CORNER" | "F11_OPEN_SHELF" | "F12_WINE_GRID"
  | "F13_TALL_TWO_DOOR" | "F14_APPLIANCE" | "F15_PLAIN_PANEL";

/** 部分模板需要参数（抽屉数、盲板宽度等）。 */
export interface FaceParams {
  /** F6：抽屉数量。 */
  drawerCount?: number;
  /** F6：各抽屉高度；不给则按可用脸高均分。 */
  drawerHeights?: number[];
  /** F10：盲板宽度，规范文档给的是 6"。 */
  blindWidth?: number;
  /** F14：电器开孔高度。 */
  openingHeight?: number;
  /** F8：围裙水槽开槽高度，规范给 9"-10"。 */
  apronHeight?: number;
}

export function buildFace(id: FaceTemplateId, params: FaceParams = {}): FaceSpec {
  switch (id) {
    case "F1_SINGLE_DOOR":
      return { kind: "door", hinge: "L" };

    case "F2_DOUBLE_DOOR":
      return {
        dir: "cols",
        children: [
          { size: "*", node: { kind: "door", hinge: "L" } },
          { size: "*", node: { kind: "door", hinge: "R" } },
        ],
      };

    // B09~B21：上部 1 抽（6"）+ 下部单开门（24"）
    case "F3_DRAWER_OVER_DOOR":
      return {
        dir: "rows",
        children: [
          { size: BASE_TOP_DRAWER_HEIGHT, node: { kind: "drawer" } },
          { size: "*", node: { kind: "door", hinge: "L" } },
        ],
      };

    // B24、B27：上部 1 抽 + 下部对开门
    case "F4_DRAWER_OVER_DOUBLE":
      return {
        dir: "rows",
        children: [
          { size: BASE_TOP_DRAWER_HEIGHT, node: { kind: "drawer" } },
          { size: "*", node: buildFace("F2_DOUBLE_DOOR") },
        ],
      };

    // B30~B36：上部 2 个独立抽屉（**横向并排**）+ 下部对开门
    case "F5_TWO_DRAWERS_OVER_DOUBLE":
      return {
        dir: "rows",
        children: [
          {
            size: BASE_TOP_DRAWER_HEIGHT,
            node: {
              dir: "cols",
              children: [
                { size: "*", node: { kind: "drawer" } },
                { size: "*", node: { kind: "drawer" } },
              ],
            },
          },
          { size: "*", node: buildFace("F2_DOUBLE_DOOR") },
        ],
      };

    /**
     * F6 —— N 抽屉栈。一个模板覆盖 2DB / 3DB / 4DB / VDB 四类。
     *
     * 规范文档给的高度：3DB = 6+12+12 = 30 ✓；2DB = 15+15 = 30 ✓；
     * **4DB = 4×7.25 = 29 ✗**（差 1"，见 RENDERING.md 附录 A9）。
     * 因此不给 drawerHeights 时一律按可用脸高均分，而不是照抄文档里的近似值。
     */
    case "F6_DRAWER_STACK": {
      const n = params.drawerCount ?? 3;
      const heights = params.drawerHeights;
      return {
        dir: "rows",
        children: Array.from({ length: n }, (_, i) => ({
          size: heights?.[i] ?? ("*" as const),
          node: { kind: "drawer" as const },
        })),
      };
    }

    // SB30~SB42：假抽屉面板 + 对开门
    case "F7_FALSE_FRONT_DOUBLE":
      return {
        dir: "rows",
        children: [
          { size: BASE_TOP_DRAWER_HEIGHT, node: { kind: "falseFront" } },
          { size: "*", node: buildFace("F2_DOUBLE_DOOR") },
        ],
      };

    // FSB36 / APR36：上部围裙开槽 9"-10"
    case "F8_APRON_SINK":
      return {
        dir: "rows",
        children: [
          { size: params.apronHeight ?? 9, node: { kind: "panel", label: "apron" } },
          { size: "*", node: buildFace("F2_DOUBLE_DOOR") },
        ],
      };

    // LSB（地柜）/ CW、WDC（吊柜）：斜面单门
    case "F9_DIAGONAL_CORNER":
      return { kind: "door", hinge: "L", label: "diagonal" };

    // BBC / WBC：靠墙侧盲板 + 可用门
    case "F10_BLIND_CORNER":
      return {
        dir: "cols",
        children: [
          { size: params.blindWidth ?? 6, node: { kind: "blind" } },
          {
            size: "*",
            node: {
              dir: "rows",
              children: [
                { size: BASE_TOP_DRAWER_HEIGHT, node: { kind: "drawer" } },
                { size: "*", node: { kind: "door", hinge: "R" } },
              ],
            },
          },
        ],
      };

    case "F11_OPEN_SHELF":
      return { kind: "open" };

    case "F12_WINE_GRID":
      return { kind: "open", label: "wine-grid" };

    // PC / U：上下对开门
    case "F13_TALL_TWO_DOOR":
      return {
        dir: "rows",
        children: [
          { size: "*", node: buildFace("F2_DOUBLE_DOOR") },
          { size: "*", node: buildFace("F2_DOUBLE_DOOR") },
        ],
      };

    // OC / BOC：中间电器开孔，上下门
    case "F14_APPLIANCE":
      return {
        dir: "rows",
        children: [
          { size: "*", node: buildFace("F2_DOUBLE_DOOR") },
          { size: params.openingHeight ?? 30, node: { kind: "applianceOpening" } },
          { size: "*", node: { kind: "drawer" } },
        ],
      };

    case "F15_PLAIN_PANEL":
      return { kind: "panel" };
  }
}

// ── SKU → 脸型的规则匹配（RENDERING.md 第 5 节）──────────────────────────

export interface MatchResult {
  templateId: FaceTemplateId;
  params: FaceParams;
  /** 命中的规则说明，用于 FR-2 会话里向运营解释「为什么判成这个脸型」。 */
  rule: string;
}

/**
 * 按通用 RTA 命名规则推断脸型。
 *
 * ⚠️ **规则的键是 (前缀, 宽度) 而不只是前缀**：`B12`（一抽一门）与 `B30`
 * （双抽双门）前缀相同、脸型不同。而且宽度分界点**因公司而异**——
 * 有的厂 B24 做单门、有的做双门，因此该表只是默认值，必须允许按公司覆盖。
 *
 * 匹配不到返回 undefined —— 交给 FR-2 对话确认，**不猜**
 * （FR-2 的「零静默失败」要求）。
 */
export function matchFaceTemplate(code: string): MatchResult | undefined {
  const sku = code.trim().toUpperCase();

  // 抽屉柜：2DB / 3DB / 4DB / VDB —— 前缀里的数字就是抽屉数
  const drawerBase = /^(\d)DB(\d+)/.exec(sku);
  if (drawerBase) {
    return {
      templateId: "F6_DRAWER_STACK",
      params: { drawerCount: Number(drawerBase[1]) },
      rule: `${drawerBase[1]}DB 前缀 → N 抽屉栈（N=${drawerBase[1]}）`,
    };
  }
  if (/^VDB/.test(sku)) {
    return { templateId: "F6_DRAWER_STACK", params: { drawerCount: 3 }, rule: "VDB → 浴室抽屉柜，默认 3 抽" };
  }

  // 水槽类
  if (/^(FSB|APR)/.test(sku)) return { templateId: "F8_APRON_SINK", params: {}, rule: "FSB/APR → 围裙水槽" };
  if (/^SB/.test(sku)) return { templateId: "F7_FALSE_FRONT_DOUBLE", params: {}, rule: "SB → 水槽柜（假抽面 + 双门）" };

  // 转角类
  if (/^(LSB)/.test(sku)) return { templateId: "F9_DIAGONAL_CORNER", params: {}, rule: "LSB → 旋转盘转角地柜" };
  if (/^(CW|WDC|EWC|LWC)/.test(sku)) return { templateId: "F9_DIAGONAL_CORNER", params: {}, rule: "CW/WDC/EWC/LWC → 转角吊柜" };
  if (/^(BBC)/.test(sku)) return { templateId: "F10_BLIND_CORNER", params: { blindWidth: 6 }, rule: "BBC → 盲角地柜" };
  if (/^(WBBC|WBC)/.test(sku)) return { templateId: "F10_BLIND_CORNER", params: { blindWidth: 6 }, rule: "WBC/WBBC → 盲角吊柜" };

  // 内部结构不影响正视图的拉篮/垃圾柜，外观就是单门
  if (/^(BPO|TDC|BWB)/.test(sku)) {
    return { templateId: "F1_SINGLE_DOOR", params: {}, rule: "BPO/TDC/BWB → 抽拉柜，正视图为单门" };
  }

  // 酒架 / 开放柜
  if (/^WWR/.test(sku)) return { templateId: "F12_WINE_GRID", params: {}, rule: "WWR → 红酒架" };
  if (/^(MW|WOC|MOC)/.test(sku)) return { templateId: "F11_OPEN_SHELF", params: {}, rule: "MW/WOC → 开放式微波炉柜" };

  // 电器高柜
  if (/^(OC|BOC|MIC)/.test(sku)) return { templateId: "F14_APPLIANCE", params: {}, rule: "OC/BOC/MIC → 电器高柜" };
  // 食品高柜
  if (/^(PC|U)\d/.test(sku)) return { templateId: "F13_TALL_TWO_DOOR", params: {}, rule: "PC/U → 食品储藏高柜" };

  // 线条、填缝条、饰面板 —— 全是素板
  if (/^(WF|BF|TF|BEP|BAP|WEP|WAP|REP|DREP|TK|CM|SCM|LRM|BM|OCM)/.test(sku)) {
    return { templateId: "F15_PLAIN_PANEL", params: {}, rule: "线条/填缝/饰面板 → 素板" };
  }

  // ── 依赖宽度的两类：地柜 B、吊柜 W ──
  const base = /^B(\d{2})/.exec(sku);
  if (base) {
    const width = Number(base[1]);
    if (width <= 21) return { templateId: "F3_DRAWER_OVER_DOOR", params: {}, rule: `B${width} 宽 ≤ 21" → 一抽一门` };
    if (width <= 27) return { templateId: "F4_DRAWER_OVER_DOUBLE", params: {}, rule: `B${width} 宽 24"-27" → 一抽双门` };
    return { templateId: "F5_TWO_DRAWERS_OVER_DOUBLE", params: {}, rule: `B${width} 宽 ≥ 30" → 双抽双门` };
  }

  const wall = /^W(\d{2})/.exec(sku);
  if (wall) {
    const width = Number(wall[1]);
    return width <= 21
      ? { templateId: "F1_SINGLE_DOOR", params: {}, rule: `W${width} 宽 ≤ 21" → 单门吊柜` }
      : { templateId: "F2_DOUBLE_DOOR", params: {}, rule: `W${width} 宽 ≥ 24" → 双门吊柜` };
  }

  // 浴室柜
  if (/^VB/.test(sku)) return { templateId: "F7_FALSE_FRONT_DOUBLE", params: {}, rule: "VB → 浴室柜（假抽面 + 双门）" };

  return undefined; // 交给 FR-2 对话确认，不猜
}

/** 公司自有命名体系的覆盖表：SKU 前缀 → 脸型。 */
export type CompanyOverrides = Record<string, { templateId: FaceTemplateId; params?: FaceParams }>;

/** 先查公司覆盖表，未命中再走通用规则。 */
export function matchWithOverrides(
  code: string,
  overrides: CompanyOverrides = {},
): MatchResult | undefined {
  const sku = code.trim().toUpperCase();
  for (const [prefix, target] of Object.entries(overrides)) {
    if (sku.startsWith(prefix.toUpperCase())) {
      return {
        templateId: target.templateId,
        params: target.params ?? {},
        rule: `公司覆盖规则：${prefix} → ${target.templateId}`,
      };
    }
  }
  return matchFaceTemplate(sku);
}
