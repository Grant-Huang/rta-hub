/**
 * 建议测试点目录 —— 从内置场景 covers + SANITY_RULES + FR-17/18/20 提炼。
 * 运营可勾选；用户 agent 按点挑选场景植入。
 */
import type { TestPoint } from "./types.js";

/** 全量建议点（suggested=true 的默认勾选）。 */
export const SUGGESTED_TEST_POINTS: TestPoint[] = [
  {
    id: "tp_fr18_no_default_seller",
    title: "无默认厂商（FR-18）",
    category: "fr",
    refs: ["FR-18"],
    description: "未 @ 时不默认第一家；通用层引导。",
    needs: { floorPlan: false },
    weight: 10,
    suggested: true,
  },
  {
    id: "tp_mention_company",
    title: "@ 厂商进入公司会话",
    category: "routing",
    refs: ["FR-1", "场景 F"],
    description: "客户 @枫岭橱柜 后路由到公司 Agent，继续规格问答。",
    needs: { mentionCompany: true, floorPlan: true, planView: true },
    weight: 10,
    suggested: true,
  },
  {
    id: "tp_guided_intake",
    title: "引导式需求收集（FR-20）",
    category: "dialogue",
    refs: ["FR-20", "FR-15"],
    description: "用户 agent 不主动倾倒全量事实，按助手追问作答。",
    needs: { floorPlan: true },
    weight: 9,
    suggested: true,
  },
  {
    id: "tp_small_galley",
    title: "小一字型厨房边界",
    category: "geometry",
    refs: ["场景 A", "SR-G1"],
    description: "单墙约 84\"；家电偏大时应 early-fit 即时拦住，不得收齐再拒绝后强行出图。",
    needs: { floorPlan: true, appliances: true },
    weight: 8,
    suggested: true,
  },
  {
    id: "tp_l_shape_corner",
    title: "L 型内墙角让位",
    category: "geometry",
    refs: ["场景 B", "SR-G5"],
    description: "两段墙 + 内角；层高可非 96。",
    needs: { floorPlan: true, planView: true, revision: true },
    weight: 8,
    suggested: true,
  },
  {
    id: "tp_u_shape_trade",
    title: "U 型 + trade 账号",
    category: "design",
    refs: ["场景 C", "FR-11"],
    description: "三段墙、premium/assembled 偏好路径。",
    needs: { floorPlan: true, tradeAccount: true, planView: true },
    weight: 6,
    suggested: false,
  },
  {
    id: "tp_long_wall_door",
    title: "长墙 + 门洞无窗",
    category: "geometry",
    refs: ["场景 D", "SR-G4"],
    description: "单墙 216\"、门洞、声明无窗。",
    needs: { floorPlan: true, planView: true },
    weight: 7,
    suggested: false,
  },
  {
    id: "tp_island_aisle",
    title: "岛台过道净空",
    category: "sanity",
    refs: ["场景 E", "SR-E5"],
    description: "岛台四周过道；岛台不生成吊柜。",
    needs: { floorPlan: true, island: true, planView: true },
    weight: 8,
    suggested: true,
  },
  {
    id: "tp_door_near_corner",
    title: "门洞近内角（G4+G5）",
    category: "sanity",
    refs: ["场景 G", "SR-G4", "SR-G5"],
    description: "门洞离内墙角很近，叠让位与外伸。",
    needs: { floorPlan: true, planView: true },
    weight: 7,
    suggested: false,
  },
  {
    id: "tp_appliances_declared",
    title: "声明家电尺寸/推定",
    category: "appliances",
    refs: ["场景 H", "SR-D1", "SR-V3", "FR-3.2"],
    description: "冰箱/灶具给尺寸，烤箱不确定→推定披露。",
    needs: { floorPlan: true, appliances: true, planView: true, fourViews: true },
    weight: 9,
    suggested: true,
  },
  {
    id: "tp_quote_bom",
    title: "出图到报价 BOM",
    category: "quote",
    refs: ["SR-M1", "SR-Q1", "SR-D4"],
    description: "四视图后报价；物料齐全、对账、产品范围披露。",
    needs: {
      mentionCompany: true, floorPlan: true, planView: true, fourViews: true, quote: true,
    },
    weight: 9,
    suggested: true,
  },
  {
    id: "tp_sr_landing_zones",
    title: "水槽/灶台落台区",
    category: "sanity",
    refs: ["SR-E1", "SR-E2"],
    description: "排布后审核落台净空。",
    needs: { floorPlan: true, appliances: true, planView: true },
    weight: 7,
    suggested: false,
  },
  {
    id: "tp_unactionable_revision",
    title: "无法落地的修改如实说明",
    category: "dialogue",
    refs: ["SR-D2", "场景 B"],
    description: "客户说「看着大气一点」→ 系统不得假装已改。",
    needs: { floorPlan: true, planView: true, revision: true },
    weight: 6,
    suggested: false,
  },
];

export function allTestPoints(): TestPoint[] {
  return SUGGESTED_TEST_POINTS;
}

export function suggestedPointIds(): string[] {
  return SUGGESTED_TEST_POINTS.filter((p) => p.suggested).map((p) => p.id);
}

export function pointsByIds(ids: string[]): TestPoint[] {
  const map = new Map(SUGGESTED_TEST_POINTS.map((p) => [p.id, p]));
  return ids.map((id) => map.get(id)).filter((p): p is TestPoint => Boolean(p));
}

/**
 * 为 N 个用例分配测试点：每案 1–2 个点，覆盖尽可能多的 suggested 点。
 */
export function allocatePointsForCases(
  count: number,
  preferredIds?: string[],
): TestPoint[][] {
  const pool = preferredIds?.length
    ? pointsByIds(preferredIds)
    : SUGGESTED_TEST_POINTS.filter((p) => p.suggested);
  const sorted = [...pool].sort((a, b) => b.weight - a.weight);
  if (sorted.length === 0) return Array.from({ length: count }, () => []);

  const out: TestPoint[][] = [];
  let i = 0;
  for (let c = 0; c < count; c++) {
    const primary = sorted[i % sorted.length]!;
    i++;
    const secondary = sorted[i % sorted.length];
    // 第二点尽量互补（不同 category）
    const pair = [primary];
    if (secondary && secondary.id !== primary.id && secondary.category !== primary.category) {
      pair.push(secondary);
      i++;
    }
    out.push(pair);
  }
  return out;
}
