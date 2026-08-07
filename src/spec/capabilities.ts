/**
 * 型号能力标签 —— 排布算法真正需要知道的那一层（CATALOG_MODEL.md 第 2 节）。
 *
 * ## 为什么不是「通用码 ↔ 商家码」映射表
 *
 * 每家商家的编码不同，但**差的不只是编码，设计本身就不一样**：有的 pantry 上下柜
 * 连体，有的分体需要叠装；有的吊柜最高 42"，有的只到 39"。
 *
 * 一张 `PANTRY84 → ?` 的映射，在连体商家那里是**一个** SKU、一扇通高门；
 * 在分体商家那里是**两个** SKU、中间一条看得见的横缝、外加一包连接件。
 * 映射表能存「A 的 X 对应 B 的 Y」，存不下「A 的一个变成 B 的两个 + 一条缝 +
 * 一包五金」。硬塞进去的结果是表里出现组合规则，只是被写成了映射表的样子。
 *
 * 所以：**编码不映射，能力才映射。**
 *
 * 排布算法不该问「这是不是 B30」，而该问「给我一个 18" 宽、能当抽屉柜用的地柜」。
 * 能力可以跨商家对齐，编码不能。
 *
 * ## 这解决了一个已经存在的 bug 类
 *
 * 改造前 `generate.ts` 里散着 `/^(\d)DB/i.test(m.code)` 这样的判断——第二家试点
 * 公司用 `NW-` 前缀命名，这些正则一个也命不中，于是「优先用抽屉柜」这条偏好
 * 在那家公司上**静默失效**。这与「@ 路由不靠 LLM 猜公司名」是同一条原则：
 * 靠字符串猜语义，换一家就崩。
 */
import type { ModuleSpec, ModuleType } from "../domain/types.js";
import { matchFaceTemplate, type FaceTemplateId } from "../render/templates.js";

/**
 * 型号承载的功能。一个型号可以有多项（水槽柜同时是「水槽位」和「门板储物」）。
 *
 * 粒度刻意保守：**加一个枚举值比拆一个语义混乱的值容易得多**。
 * 现在够用就先这些，第三家商家入驻时再看要不要加。
 */
export type ModuleRole =
  /** 门板储物柜。 */
  | "doorStorage"
  /** 抽屉柜——高频取放区优先用它。 */
  | "drawerStorage"
  /** 水槽柜：台面开孔、门后不能有抽屉、要过下水。 */
  | "sinkBase"
  /** 灶台下柜：台面开孔，上层抽屉要避让。 */
  | "cooktopBase"
  /** 家电柜（烤箱塔 / 微波柜）：中间开洞。 */
  | "applianceHousing"
  /** 转角柜（斜切 / 盲角）。 */
  | "cornerAccess"
  /** 开放格 / 酒格：没有门。 */
  | "openDisplay"
  /** 填缝、收口、踢脚、顶线、地脚——服务于整套，不属于任何一个柜体。 */
  | "trim";

/** 配套的家电种类。非配套柜为空。 */
export type ApplianceKind =
  | "refrigerator" | "range" | "cooktop" | "wallOven"
  | "rangeHood" | "microwave" | "dishwasher";

export interface ModuleCapabilities {
  roles: ModuleRole[];
  /** 这个型号是给哪种家电配套的（冰箱上柜、烟机上柜、烤箱高柜…）。 */
  servesAppliance?: ApplianceKind;
  /** 能否作为叠装的下段 / 上段。两者都为 false 表示不支持叠装。 */
  stacking?: { asLower: boolean; asUpper: boolean };
  /**
   * 上下连体（如通高 pantry）。
   *
   * 连体的**不需要**叠装，也**不该被拆开**——拆开会变成两个 SKU、多一条缝、
   * 多一包连接件，而这家根本不卖那两个 SKU。
   */
  monolithic?: boolean;
}

/**
 * 推断的可信度。
 *
 * 与 FR-2 的「零静默失败」配套：`low` 的推断**不允许直接进规格库**，
 * 要走待确认队列。一个把水槽柜误判成普通地柜的规格库，会让**每一版**方案的
 * 水槽都排错位置——这种错不报警，只是安静地一直错。
 */
export type CapabilityConfidence = "declared" | "high" | "low";

export interface CapabilityResolution {
  capabilities: ModuleCapabilities;
  confidence: CapabilityConfidence;
  /** 是怎么得出来的，写给人看（待确认队列里要展示）。 */
  reason: string;
}

// ── 由脸型模板反推（次可信）────────────────────────────────────────────────

/**
 * 脸型模板 → 角色。
 *
 * 脸型是**渲染那边已经定好的一套语义**，不是我另起的一套规则。
 * `F7_FALSE_FRONT_DOUBLE`（假抽面 + 双门）只可能是水槽柜；
 * `F6_DRAWER_STACK` 一定是抽屉柜。复用它比重新猜可靠得多。
 */
const ROLES_BY_FACE: Record<FaceTemplateId, ModuleRole[]> = {
  F1_SINGLE_DOOR: ["doorStorage"],
  F2_DOUBLE_DOOR: ["doorStorage"],
  F3_DRAWER_OVER_DOOR: ["doorStorage", "drawerStorage"],
  F4_DRAWER_OVER_DOUBLE: ["doorStorage", "drawerStorage"],
  F5_TWO_DRAWERS_OVER_DOUBLE: ["doorStorage", "drawerStorage"],
  F6_DRAWER_STACK: ["drawerStorage"],
  // 假抽面 + 双门 = 顶部开放的箱体。这正是**嵌入式灶台**要的构造：灶体从台面
  // 沉下来时不会撞到抽屉。同一个箱体既能当水槽柜也能当灶下柜，不是巧合——
  // 两者需要的都是"上面那一格是空的"。
  F7_FALSE_FRONT_DOUBLE: ["sinkBase", "cooktopBase", "doorStorage"],
  F8_APRON_SINK: ["sinkBase", "doorStorage"],
  F9_DIAGONAL_CORNER: ["cornerAccess", "doorStorage"],
  F10_BLIND_CORNER: ["cornerAccess", "doorStorage"],
  F11_OPEN_SHELF: ["openDisplay"],
  F12_WINE_GRID: ["openDisplay"],
  F13_TALL_TWO_DOOR: ["doorStorage"],
  F14_APPLIANCE: ["applianceHousing"],
  F15_PLAIN_PANEL: ["trim"],
};

/** 本来就没有「脸」的类别——它们一律是配件。 */
const TRIM_TYPES: ReadonlySet<ModuleType> = new Set(
  ["filler", "panel", "toeKick", "crown", "leg"]);

/**
 * 纯抽屉柜的高度门槛。
 *
 * `F6_DRAWER_STACK` 覆盖了「一柜全是抽屉」这一类；但一个 34.5" 高的三抽地柜与
 * 一个 12" 高的单抽吊柜，在排布上不是一回事。这里只是不把后者当成"高频区可用的
 * 抽屉柜"，不影响它的脸型。
 */
const DRAWER_BASE_MIN_HEIGHT = 24;

/**
 * 从型号本身推断能力。
 *
 * 顺序：`type` 定大类 → 脸型模板细化 → 尺寸做常识性修正。
 * **不看型号码**——那正是这层要消除的东西。
 */
export function inferCapabilities(spec: ModuleSpec): CapabilityResolution {
  if (TRIM_TYPES.has(spec.type)) {
    return {
      capabilities: { roles: ["trim"] },
      confidence: "high",
      reason: `type=${spec.type} 属于配件类，不承载储物功能`,
    };
  }

  // faceTemplateId 在领域模型里是 string（公司可以用覆盖表指向自定义模板），
  // 这里按已知模板表查；查不到就当没有脸型，走保守分支
  const face = (spec.faceTemplateId ?? matchFaceTemplate(spec.code)?.templateId) as
    FaceTemplateId | undefined;
  if (!face || !(face in ROLES_BY_FACE)) {
    // 匹配不到脸型的柜体：按 type 给一个最保守的角色，并标为低可信
    return {
      capabilities: { roles: spec.type === "sinkBase" ? ["sinkBase"] : ["doorStorage"] },
      confidence: "low",
      reason: `型号 ${spec.code} 匹配不到脸型模板，只能按 type=${spec.type} 给最保守的角色`,
    };
  }

  const roles = new Set<ModuleRole>(ROLES_BY_FACE[face] ?? ["doorStorage"]);

  // type 是商家自己声明的，比从脸型反推更权威——它说是水槽柜就是水槽柜
  if (spec.type === "sinkBase") roles.add("sinkBase");
  if (spec.type === "corner") roles.add("cornerAccess");

  // 很矮的抽屉件（吊柜下的单抽、假抽面）不算高频区可用的抽屉柜
  const tallEnough = (spec.heightOptions[0] ?? 0) >= DRAWER_BASE_MIN_HEIGHT;
  if (roles.has("drawerStorage") && spec.type !== "base" && !tallEnough) {
    roles.delete("drawerStorage");
  }

  const stacking = inferStacking(spec, roles);
  const capabilities: ModuleCapabilities = {
    roles: [...roles],
    ...(stacking ? { stacking } : {}),
    ...(isMonolithic(spec) ? { monolithic: true } : {}),
  };

  // 家电柜推得出"是个家电柜"，推不出"配哪种家电"——而后者决定开洞高度、
  // 周围要不要配收口板、吊柜层要不要让位。`OC` 按行业惯例是烤箱柜，但那正是
  // 这层要消除的"从码前缀猜"。所以标为低可信，请商家确认一次。
  if (roles.has("applianceHousing")) {
    return {
      capabilities,
      confidence: "low",
      reason: `型号 ${spec.code} 是家电柜，但配哪种家电推不出来` +
        `（烤箱塔与微波柜的开洞高度、周边配件都不同）`,
    };
  }

  return {
    capabilities,
    confidence: "high",
    reason: `由脸型模板 ${face} 与 type=${spec.type} 推出`,
  };
}

/**
 * 叠装能力。
 *
 * 只对吊柜推断——地柜与高柜不叠装。**推不出来就不给**（返回 undefined 而不是
 * 一对 false），因为「不知道」和「明确不支持」是两回事：前者该由商家确认，
 * 后者可以直接据以决策。
 */
function inferStacking(
  spec: ModuleSpec,
  roles: ReadonlySet<ModuleRole>,
): { asLower: boolean; asUpper: boolean } | undefined {
  if (roles.has("trim")) return undefined;
  // 明显矮于通高的 tall 型号是**分体 pantry 的一段**（CATALOG_MODEL §1.2）：
  // 第三家的 `BL-PC1842` 是两段 42" 叠成 84"，不是一个通高箱体。
  // 只认 `type === "wall"` 的话，分体做法的商家一接进来，
  // 它的 pantry 就既不是连体、又不能叠装——两头不靠。
  if (spec.type === "tall") {
    return isMonolithic(spec) ? undefined : { asLower: true, asUpper: true };
  }
  if (spec.type !== "wall") return undefined;
  // 吊柜默认可上可下：厂家给的吊柜通常上下同构（都是一个箱体加门）。
  // 这是个乐观默认，所以叠装方案要在解释里说明并可被商家覆盖。
  return { asLower: true, asUpper: true };
}

/** 通高高柜视为连体——它本来就是一个箱体，拆开就不是这家的产品了。 */
function isMonolithic(spec: ModuleSpec): boolean {
  return spec.type === "tall" && (spec.heightOptions[0] ?? 0) >= 72;
}

// ── 对外入口 ──────────────────────────────────────────────────────────────

/**
 * 取一个型号的能力：**商家声明的优先，推断的兜底**。
 *
 * 可信度排序（CATALOG_MODEL.md §2.2）：商家导入时直接声明 > 从脸型模板反推 >
 * 从码前缀猜。第三条这里根本不做——它是这层要消除的东西。
 */
export function capabilitiesFor(spec: ModuleSpec): CapabilityResolution {
  if (spec.capabilities) {
    return {
      capabilities: spec.capabilities,
      confidence: "declared",
      reason: "商家在规格里直接声明",
    };
  }
  return inferCapabilities(spec);
}

/** 这个型号有没有某项能力。排布算法应当只通过它来判断，不看 code。 */
export function hasRole(spec: ModuleSpec, role: ModuleRole): boolean {
  return capabilitiesFor(spec).capabilities.roles.includes(role);
}

/** 挑出具备某项能力的型号。 */
export function modulesWithRole(
  modules: readonly ModuleSpec[],
  role: ModuleRole,
): ModuleSpec[] {
  return modules.filter((m) => hasRole(m, role));
}

/**
 * 需要人工确认的推断。
 *
 * 与 FR-2 的待确认队列同源：**猜出来的能力不能直接进规格库**。
 * 返回的每一条都要在入驻会话里展示给商家确认。
 */
export interface CapabilityQuestion {
  moduleId: string;
  moduleCode: string;
  reason: string;
  /** 推断出来的那一版，供商家「确认」或「改」。 */
  proposed: ModuleCapabilities;
}

export function capabilityQuestions(modules: readonly ModuleSpec[]): CapabilityQuestion[] {
  const out: CapabilityQuestion[] = [];
  for (const m of modules) {
    const r = capabilitiesFor(m);
    if (r.confidence !== "low") continue;
    out.push({
      moduleId: m.id, moduleCode: m.code,
      reason: r.reason, proposed: r.capabilities,
    });
  }
  return out;
}
