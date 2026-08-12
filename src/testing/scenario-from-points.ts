/**
 * 由测试点合成「私有世界 + 测试意图」——不是对话剧本。
 * 用户 agent 只拿意图/人设/私有事实，在系统引导下即兴发挥。
 */
import type {
  CustomerFacts, TestMissionIntent, UserPersona,
} from "./user-agent.js";
import { personaForCaseIndex } from "./user-agent.js";
import type { TestPoint } from "./types.js";

export interface TestWall {
  label: string;
  length: number;
  kind?: "wall" | "island";
  depth?: number;
  features?: { kind: "window" | "plumbing" | "door"; offset: number; width: number }[];
}

export interface TestScenarioBlueprint {
  pointIds: string[];
  /** 列表标题前缀用 */
  titleTag: string;
  persona: UserPersona;
  mission: TestMissionIntent;
  accountType: "consumer" | "trade";
  companyMention: string;
  companyId: string;
  ceilingHeight: number;
  /** 合成用户 agent 私有世界用；harness 上传时不直写库 */
  walls: TestWall[];
  facts: CustomerFacts;
  appliances?: {
    kind: "refrigerator" | "range" | "cooktop" | "wallOven" | "dishwasher";
    width?: number;
  }[];
  prefs: {
    budgetBand?: "economy" | "standard" | "premium" | "unsure";
    doorStyleId?: string;
    storage?: "drawers" | "doors" | "balanced";
    assembly?: "RTA" | "assembled";
  };
  /** 观察用软目标（非强制逐步脚本） */
  observe: {
    mentionCompany: boolean;
    planView: boolean;
    fourViews: boolean;
    quote: boolean;
    revision: boolean;
    /** 小厨房等：期望 early-fit 阻断出图（成功=拦住，而非强行出图） */
    earlyFitBlock?: boolean;
  };
}

function mergeNeeds(points: TestPoint[]) {
  const n = {
    mentionCompany: false,
    floorPlan: true,
    island: false,
    appliances: false,
    tradeAccount: false,
    planView: false,
    fourViews: false,
    quote: false,
    revision: false,
  };
  for (const p of points) {
    for (const [k, v] of Object.entries(p.needs)) {
      if (v) (n as Record<string, boolean>)[k] = true;
    }
  }
  if (n.quote) { n.fourViews = true; n.planView = true; n.mentionCompany = true; }
  if (n.fourViews) n.planView = true;
  // 出图前家电尺寸必填——凡要出俯视图的用例都带明确宽度
  if (n.planView) n.appliances = true;
  return n;
}

function missionFromPoints(
  points: TestPoint[],
  needs: ReturnType<typeof mergeNeeds>,
  companyMention: string,
): TestMissionIntent {
  const softGoals: string[] = [
    "Follow the assistant's guidance to share what you know about the kitchen.",
  ];
  if (needs.mentionCompany) {
    softGoals.push(
      `When product-specific questions come up, you may ask ${companyMention} via @ if the assistant explains how (or you already know).`,
    );
  } else {
    softGoals.push("Do not assume a default seller; stay with the general assistant until guided otherwise.");
  }
  if (needs.floorPlan || needs.planView) {
    softGoals.push(
      "If guided to share sizes or upload a floor plan, cooperate in-character. "
        + "After upload, if they could not read the sketch, type wall lengths and ceiling from what you know.",
    );
  }
  if (needs.planView) {
    softGoals.push("If they offer to generate a design drawing, agree when it feels right.");
  }
  if (needs.fourViews) {
    softGoals.push("If a plan overview looks ok, you may ask for full drawings.");
  }
  if (needs.quote) {
    softGoals.push("You eventually want a quote / BOM once drawings exist.");
  }
  if (needs.revision) {
    softGoals.push("After seeing a plan, you may ask for a vague aesthetic tweak (e.g. look grander).");
  }
  if (needs.appliances) {
    softGoals.push("You know appliance widths; give each with inches when asked — never say appliances later.");
  }

  const titles = points.map((p) => p.title).join("；");
  return {
    brief: `You are shopping for kitchen cabinets. Soft mission themes for this chat: ${titles}. `
      + "Pursue them naturally under the assistant's guidance — do not recite a checklist or test IDs.",
    softGoals,
  };
}

export function blueprintFromPoints(points: TestPoint[], caseIndex: number): TestScenarioBlueprint {
  const needs = mergeNeeds(points);
  const ids = points.map((p) => p.id);
  const persona = personaForCaseIndex(caseIndex);
  const titleTag = `test-${persona.slice(0, 3)}-${ids.map((id) => id.replace(/^tp_/, "").slice(0, 10)).join("+")}`.slice(0, 48);

  let walls: TestWall[];
  let ceilingHeight = 96;

  if (needs.island) {
    walls = [
      { label: "North", length: 144, features: [{ kind: "window", offset: 48, width: 36 }] },
      { label: "East", length: 120, features: [{ kind: "plumbing", offset: 36, width: 24 }] },
      { label: "Island", length: 72, kind: "island", depth: 36 },
    ];
  } else if (points.some((p) => p.id === "tp_small_galley")) {
    walls = [{
      label: "North", length: 84,
      features: [
        { kind: "window", offset: 6, width: 30 },
        { kind: "plumbing", offset: 54, width: 24 },
      ],
    }];
  } else if (points.some((p) => p.id === "tp_long_wall_door")) {
    walls = [{
      label: "South", length: 216,
      features: [{ kind: "door", offset: 12, width: 32 }],
    }];
  } else if (points.some((p) => p.id.includes("u_shape"))) {
    walls = [
      { label: "North", length: 120, features: [{ kind: "window", offset: 40, width: 36 }] },
      { label: "East", length: 108, features: [{ kind: "plumbing", offset: 48, width: 24 }] },
      { label: "South", length: 120 },
    ];
  } else {
    walls = [
      { label: "North", length: 168, features: [{ kind: "window", offset: 48, width: 36 }] },
      { label: "East", length: 120, features: [{ kind: "plumbing", offset: 36, width: 24 }] },
    ];
    ceilingHeight = points.some((p) => p.id === "tp_l_shape_corner") ? 108 : 96;
  }

  const tightGalley = points.some((p) => p.id === "tp_small_galley");
  const maxWall = Math.max(0, ...walls.map((w) => w.length));
  // 出图用例：墙够长时给可装下的家电；小一字型（≤96"）故意给偏大的冰箱+灶，验证 early-fit
  const appliances = needs.appliances
    ? (tightGalley || maxWall <= 96
      ? [
          { kind: "refrigerator" as const, width: 36 },
          { kind: "range" as const, width: 30 },
        ]
      : [
          { kind: "refrigerator" as const, width: 33 },
          { kind: "range" as const, width: 30 },
        ])
    : undefined;

  const companyMention = "枫岭橱柜";
  const kitchenTalk = needs.island
    ? "L-shape with an island"
    : walls.length === 1 ? "one wall galley" : walls.length === 3 ? "U-shape" : "L-shape kitchen";

  const openingLines = walls.flatMap((w) =>
    (w.features ?? []).map((f) => {
      if (f.kind === "window") {
        return `Window on ${w.label}, ${f.width}" wide, about ${f.offset}" from a corner`;
      }
      if (f.kind === "plumbing") {
        return `Sink plumbing on ${w.label}, about ${f.offset}" from a corner (${f.width}" zone)`;
      }
      if (f.kind === "door") {
        return `Door opening on ${w.label}, ${f.width}" wide, about ${f.offset}" from a corner`;
      }
      return "";
    }).filter(Boolean),
  );

  const facts: CustomerFacts = {
    intent: persona === "beginner"
      ? "Want nicer kitchen cabinets someday, overwhelmed by choices."
      : "Want new kitchen cabinets for a remodel.",
    kitchenTalk,
    walls: walls.filter((w) => w.kind !== "island").map((w) => ({ label: w.label, length: w.length })),
    ceilingHeight,
    style: caseIndex % 2 === 0 ? "Modern shaker" : "质感一点的灰调",
    budget: persona === "trade_pro" ? "Budget CAD $18–28k trade" : "Budget CAD $12–18k",
    province: "Ontario ON",
    mentionCompany: companyMention,
    appliances: appliances
      ? (tightGalley || maxWall <= 96
        ? "Fridge 36\", range 30\""
        : "Fridge 33\", range 30\"")
      : undefined,
    windows: openingLines.filter((l) => /window/i.test(l)).join(". ")
      || (points.some((p) => p.id === "tp_long_wall_door")
        ? "No windows on that long wall"
        : undefined),
    plumbing: openingLines.filter((l) => /plumbing|sink/i.test(l)).join(". ")
      || "Sink on the wall with plumbing",
    notes: openingLines.filter((l) => /door/i.test(l)).join(". ") || undefined,
  };

  const accountType = needs.tradeAccount || persona === "trade_pro" ? "trade" : "consumer";

  return {
    pointIds: ids,
    titleTag,
    persona,
    mission: missionFromPoints(points, needs, companyMention),
    accountType,
    companyMention,
    companyId: "co_pilot",
    ceilingHeight,
    walls,
    facts,
    ...(appliances ? { appliances } : {}),
    prefs: {
      budgetBand: accountType === "trade" ? "premium" : "standard",
      doorStyleId: "ds_shaker_white",
      storage: "balanced",
      assembly: accountType === "trade" ? "assembled" : "RTA",
    },
    observe: {
      mentionCompany: needs.mentionCompany,
      // 小一字型边界：成功标准是 early-fit 拦住，不要求出图/报价
      planView: needs.planView && !tightGalley,
      fourViews: needs.fourViews && !tightGalley,
      quote: needs.quote && !tightGalley,
      revision: needs.revision && !tightGalley,
      ...(tightGalley ? { earlyFitBlock: true } : {}),
    },
  };
}
