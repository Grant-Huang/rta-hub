/**
 * 标注规则 —— 图上写什么字（RENDERING.md §8.3、APPLIANCES.md §4）。
 *
 * ## 为什么这也要抽出来
 *
 * 审查时发现：**四视图和全局俯视图上都没有标出水槽和家电的位置。**
 * 排布器内部一直知道（`Placement.applianceKind`、`label === "sink"`），
 * 但两个渲染器都只写了 `p.moduleCode`——而家电位没有 `moduleCode`，
 * 于是它们在图上是几个没有任何文字的灰色方块。
 *
 * 客户看图第一个找的就是"我的冰箱在哪、水槽在哪"。这两样标不出来，
 * 图纸就没法评审。
 *
 * 规则放在这里而不是各画各的，理由与配色一样：同一个东西在两组图里
 * 必须是同一种标注方式。
 */
import type { Placement } from "../../layout/generate.js";
import { applianceLabelForDrawing } from "../../floorplan/appliances.js";
import { formatInches } from "./primitives.js";

export interface Annotation {
  /** 主标注：型号码，或家电名。 */
  primary: string;
  /** 次标注：尺寸、或"assumed"这类注脚。窄的地方会被省掉。 */
  secondary?: string;
}

/**
 * 一个构件在图上该写什么。
 *
 * 图纸文字固定英文，无视客户语言偏好。
 *
 * 返回 `undefined` 表示不写——填缝条只有 3/4" 宽，写上去也看不清，
 * 它在图例里说明就够了。
 */
export function annotationFor(p: Placement): Annotation | undefined {
  if (p.kind === "appliance" && p.applianceKind) {
    const name = applianceLabelForDrawing(p.applianceKind);
    const spec = p.applianceSpec;
    return {
      primary: name,
      // Assumed sizes must be visible on the drawing itself.
      secondary: spec
        ? `${formatInches(spec.width)}${spec.provenance === "assumed" ? " (assumed)" : ""}`
        : formatInches(p.width),
    };
  }
  if (p.label === "sink") {
    return { primary: "Sink", ...(p.moduleCode ? { secondary: p.moduleCode } : {}) };
  }
  if (p.applianceKind !== undefined && p.moduleCode) {
    // Appliance cabinet: name what it serves; SKU is secondary.
    const englishCabinet =
      p.label && !/[\u4e00-\u9fff]/.test(p.label)
        ? p.label
        : `${applianceLabelForDrawing(p.applianceKind)} cabinet`;
    return {
      primary: englishCabinet,
      secondary: p.moduleCode,
    };
  }
  if (p.moduleCode) return { primary: p.moduleCode };
  if (p.kind === "filler") return undefined;
  // Drop Chinese placement labels from the drawing — use English fallbacks.
  if (p.label) {
    if (/填缝/.test(p.label)) return undefined;
    if (/[\u4e00-\u9fff]/.test(p.label)) {
      if (p.applianceKind) {
        return { primary: applianceLabelForDrawing(p.applianceKind) };
      }
      return undefined;
    }
    return { primary: p.label };
  }
  return undefined;
}

/**
 * 宽度不足这个值就不写字。
 *
 * 与"要写几行"有关：写两行需要的宽度更多。这条判断也统一在这里，
 * 否则一张图上 12" 的柜子有字、另一张上没有。
 */
export function fitsText(widthInches: number, lines: number): boolean {
  return widthInches >= (lines >= 2 ? 15 : 9);
}
