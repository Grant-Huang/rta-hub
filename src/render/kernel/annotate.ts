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
import { APPLIANCE_LABEL } from "../../floorplan/appliances.js";
import { formatInches } from "./primitives.js";

export interface Annotation {
  /** 主标注：型号码，或家电名。 */
  primary: string;
  /** 次标注：尺寸、或"推定"这类注脚。窄的地方会被省掉。 */
  secondary?: string;
}

/**
 * 一个构件在图上该写什么。
 *
 * 返回 `undefined` 表示不写——填缝条只有 3/4" 宽，写上去也看不清，
 * 它在图例里说明就够了。
 */
export function annotationFor(p: Placement): Annotation | undefined {
  if (p.kind === "appliance" && p.applianceKind) {
    const name = APPLIANCE_LABEL[p.applianceKind];
    const spec = p.applianceSpec;
    return {
      primary: name,
      // **推定值要在图上就看得出来**：客户以为我们知道他的冰箱多宽，
      // 而其实是按常见款猜的。等到装不进去才发现就晚了。
      secondary: spec
        ? `${formatInches(spec.width)}${spec.provenance === "assumed" ? "（推定）" : ""}`
        : formatInches(p.width),
    };
  }
  if (p.label === "sink") {
    return { primary: "水槽", ...(p.moduleCode ? { secondary: p.moduleCode } : {}) };
  }
  if (p.applianceKind !== undefined && p.moduleCode) {
    // 配套柜：写它服务的是哪台家电，型号码退到次位——客户认得"冰箱上柜"，
    // 认不得 RFW3615
    return {
      primary: p.label ?? `${APPLIANCE_LABEL[p.applianceKind]}配套柜`,
      secondary: p.moduleCode,
    };
  }
  if (p.moduleCode) return { primary: p.moduleCode };
  if (p.kind === "filler") return undefined;
  return p.label ? { primary: p.label } : undefined;
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
