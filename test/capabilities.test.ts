/**
 * 能力标签 —— CATALOG_MODEL.md 第 2 节。
 *
 * 这一组的核心断言只有一条：**换一套型号命名，行为不能变。**
 * 改造前 `generate.ts` 里散着 `/^(\d)DB/i.test(m.code)` 这样的判断，
 * 换一家用别的前缀命名的公司就全部落空——而且是**静默**落空：
 * 排布照样出，只是"高频区优先抽屉柜"这条偏好不再起作用。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capabilitiesFor, capabilityQuestions, hasRole, inferCapabilities, modulesWithRole,
} from "../src/spec/capabilities.js";
import { generateLayout } from "../src/layout/generate.js";
import { pilotModules } from "../src/app/seed.js";
import type { ModuleSpec } from "../src/domain/types.js";
import type { ParsedGeometry, WallRun } from "../src/floorplan/types.js";

const AT = "2026-06-01T00:00:00.000Z";

const base = {
  specVersionId: "sv_1", companyId: "co_x",
  assemblyOptions: ["RTA"] as const,
};

function mod(over: Partial<ModuleSpec> & Pick<ModuleSpec, "code" | "type">): ModuleSpec {
  return {
    ...base, id: `m_${over.code.toLowerCase()}`,
    widthOptions: [30], heightOptions: [34.5], depthOptions: [24],
    assemblyOptions: ["RTA"],
    ...over,
  } as ModuleSpec;
}

// ── 推断 ──────────────────────────────────────────────────────────────────

test("配件类一律是 trim，不承载储物功能", () => {
  for (const type of ["filler", "panel", "toeKick", "crown", "leg"] as const) {
    const r = inferCapabilities(mod({ code: "X1", type }));
    assert.deepEqual(r.capabilities.roles, ["trim"], type);
    assert.equal(r.confidence, "high");
  }
});

test("纯抽屉柜推成 drawerStorage，且不是 doorStorage", () => {
  const m = mod({ code: "3DB30", type: "base", faceTemplateId: "F6_DRAWER_STACK" });
  assert.ok(hasRole(m, "drawerStorage"));
  assert.equal(hasRole(m, "doorStorage"), false, "纯抽屉柜没有门");
});

test("一抽一门这类是两种角色都有——它既不是纯抽屉柜也不是纯门板柜", () => {
  const m = mod({ code: "B18", type: "base", faceTemplateId: "F3_DRAWER_OVER_DOOR" });
  assert.ok(hasRole(m, "doorStorage"));
  assert.ok(hasRole(m, "drawerStorage"));
});

test("水槽柜从脸型就能认出来，不靠型号码", () => {
  // 故意用一个谁也猜不到的码
  const m = mod({ code: "ZZ-9977", type: "base", faceTemplateId: "F7_FALSE_FRONT_DOUBLE" });
  assert.ok(hasRole(m, "sinkBase"), "假抽面 + 双门只可能是水槽柜");
});

test("商家把水槽柜归在 base 类里也能认出来", () => {
  // 只看 type === "sinkBase" 会漏掉这种
  const m = mod({ code: "NW-SK36", type: "base", faceTemplateId: "F8_APRON_SINK" });
  assert.ok(hasRole(m, "sinkBase"));
});

test("type 比脸型更权威：商家说是水槽柜就是水槽柜", () => {
  const m = mod({ code: "X", type: "sinkBase", faceTemplateId: "F2_DOUBLE_DOOR" });
  assert.ok(hasRole(m, "sinkBase"));
});

test("匹配不到脸型的柜体标为低可信，走待确认队列", () => {
  const m = mod({ code: "完全看不懂的码", type: "base" });
  const r = capabilitiesFor(m);
  assert.equal(r.confidence, "low");
  assert.ok(r.reason.includes("matched no face template"), r.reason);

  const qs = capabilityQuestions([m]);
  assert.equal(qs.length, 1, "低可信的推断必须进待确认队列");
  assert.equal(qs[0]!.moduleCode, "完全看不懂的码");
  assert.ok(qs[0]!.proposed.roles.length > 0, "要给商家一版可以直接确认的提案");
});

test("家电柜推不出配哪种家电，要问一次", () => {
  // 脸型只能告诉我们"中间开了个洞"，开洞高度取决于是烤箱塔还是微波柜。
  // 按 OC 前缀猜"oven cabinet"正是这层要消除的做法
  const m = mod({ code: "OC3084", type: "tall", faceTemplateId: "F14_APPLIANCE" });
  const r = capabilitiesFor(m);
  assert.equal(r.confidence, "low");
  assert.ok(r.reason.includes("which appliance"), r.reason);
  assert.deepEqual(r.capabilities.roles, ["applianceHousing"]);
});

test("商家声明了 servesAppliance 就不再追问", () => {
  const m = mod({
    code: "OC3084", type: "tall", faceTemplateId: "F14_APPLIANCE",
    capabilities: { roles: ["applianceHousing"], servesAppliance: "wallOven" },
  });
  assert.equal(capabilitiesFor(m).confidence, "declared");
  assert.deepEqual(capabilityQuestions([m]), []);
});

test("试点公司的规格没有悬而未决的能力——家电柜是显式声明的", () => {
  // seed 里 OC3084 显式声明了 servesAppliance: wallOven（PILOT_CAPABILITIES）。
  // 队列淹在噪音里就没人看了，所以推得准的与已声明的都不该出现在这里
  assert.deepEqual(capabilityQuestions(pilotModules), []);
});

test("商家直接声明的优先于推断", () => {
  const m = mod({
    code: "B30", type: "base", faceTemplateId: "F5_TWO_DRAWERS_OVER_DOUBLE",
    capabilities: { roles: ["applianceHousing"], servesAppliance: "wallOven" },
  });
  const r = capabilitiesFor(m);
  assert.equal(r.confidence, "declared");
  assert.deepEqual(r.capabilities.roles, ["applianceHousing"]);
  assert.equal(r.capabilities.servesAppliance, "wallOven");
});

test("吊柜默认可叠装；地柜与高柜推不出来就不给", () => {
  const w = inferCapabilities(mod({ code: "W3030", type: "wall", faceTemplateId: "F2_DOUBLE_DOOR" }));
  assert.deepEqual(w.capabilities.stacking, { asLower: true, asUpper: true });

  const b = inferCapabilities(mod({ code: "B30", type: "base", faceTemplateId: "F2_DOUBLE_DOOR" }));
  assert.equal(b.capabilities.stacking, undefined, "「不知道」和「明确不支持」是两回事");
});

test("通高高柜标为连体——拆开就不是这家的产品了", () => {
  const m = mod({
    code: "PC1884", type: "tall", heightOptions: [84],
    faceTemplateId: "F13_TALL_TWO_DOOR",
  });
  assert.equal(inferCapabilities(m).capabilities.monolithic, true);
});

test("modulesWithRole 能从一整套规格里挑出某类", () => {
  const sinks = modulesWithRole(pilotModules, "sinkBase");
  assert.ok(sinks.length > 0);
  for (const s of sinks) assert.ok(hasRole(s, "sinkBase"));
});

// ── 换一套命名，行为不变 ──────────────────────────────────────────────────

/** 把一套规格整体改名，别的什么都不动。 */
function renamed(modules: readonly ModuleSpec[], prefix: string): ModuleSpec[] {
  return modules.map((m) => ({ ...m, id: `${prefix}${m.id}`, code: `${prefix}${m.code}` }));
}

function geometry(): ParsedGeometry {
  const wall: WallRun = {
    id: "wr_1", label: "北墙", length: 144,
    startsAtCorner: false, endsAtCorner: false,
    features: [
      { id: "f_w", kind: "window", offset: 60, width: 36 },
      { id: "f_p", kind: "plumbing", offset: 66, width: 24 },
    ],
  };
  return { wallRuns: [wall], ceilingHeight: 96, confidence: 0.9 };
}

test("换一套型号命名，排出来的柜型构成完全一样", () => {
  // 这是这整层存在的理由。改名之前，/^(\d)DB/ 之类的判断会全部落空，
  // 而且是**静默**落空——排布照样出，只是偏好不再起作用
  const shape = (modules: readonly ModuleSpec[]) =>
    generateLayout(geometry(), modules, { ceilingHeight: 96, drawerBias: "always" })
      .placements
      .filter((p) => p.kind === "cabinet")
      .map((p) => `${p.layer}:${p.x}:${p.width}`)
      .join(" ");

  assert.equal(shape(renamed(pilotModules, "NW-")), shape(pilotModules));
});

test("「优先抽屉柜」在改名后的规格上依然生效", () => {
  const drawerCount = (modules: readonly ModuleSpec[], bias: "always" | "never") =>
    generateLayout(geometry(), modules, { ceilingHeight: 96, drawerBias: bias })
      .placements.filter((p) => p.moduleId && hasRole(
        modules.find((m) => m.id === p.moduleId)!, "drawerStorage")
        && !hasRole(modules.find((m) => m.id === p.moduleId)!, "doorStorage")).length;

  const renamedModules = renamed(pilotModules, "NW-");
  assert.ok(
    drawerCount(renamedModules, "always") > drawerCount(renamedModules, "never"),
    "换个前缀就认不出抽屉柜，正是能力标签要消除的失效方式",
  );
});

test("水槽柜在改名后的规格上依然排得出来", () => {
  const layout = generateLayout(geometry(), renamed(pilotModules, "ACME_"), { ceilingHeight: 96 });
  assert.ok(
    layout.placements.some((p) => p.label === "sink"),
    "认不出水槽柜的后果是整套厨房没有水槽，而且不报错",
  );
});

// ── 与入驻流程的接线 ──────────────────────────────────────────────────────

test("能力推不准的型号会进入驻待确认队列，且不允许发布", async () => {
  const { assertPublishable, ingestTemplates, startSession } =
    await import("../src/spec/onboarding.js");

  const { session } = startSession("co_x", AT);
  // 家电柜：脸型认得出"中间开洞"，认不出配哪种家电
  const { session: after, bundle } = ingestTemplates(session, {
    modules: [
      "code,type,widths,heights,depths,assembly",
      "OC3084,tall,30,84,24,RTA",
    ].join("\n"),
    doorStyles: ["id,name,priceGroup", "ds_a,Shaker,A"].join("\n"),
    priceGroups: ["code,displayName,rank", "A,Standard,1"].join("\n"),
    priceMatrix: ["moduleCode,priceGroup,listPrice", "OC3084,A,648.00"].join("\n"),
  }, AT);

  assert.ok(
    after.unresolved.some((u) => u.field === "capabilities"),
    "推不准的能力必须进队列——认错水槽柜会让这家的每一版方案都排错",
  );
  assert.throws(() => assertPublishable(after, bundle), /unresolved item/i);
});

test("推得准的规格不会因为这层新增而卡住发布", async () => {
  const { ingestTemplates, startSession } = await import("../src/spec/onboarding.js");
  const { session } = startSession("co_y", AT);
  const { session: after } = ingestTemplates(session, {
    modules: [
      "code,type,widths,heights,depths,assembly",
      "B30,base,30,34-1/2,24,RTA",
      "SB36,sinkBase,36,34-1/2,24,RTA",
    ].join("\n"),
    doorStyles: ["id,name,priceGroup", "ds_a,Shaker,A"].join("\n"),
    priceGroups: ["code,displayName,rank", "A,Standard,1"].join("\n"),
    priceMatrix: [
      "moduleCode,priceGroup,listPrice", "B30,A,245.50", "SB36,A,310.00",
    ].join("\n"),
  }, AT);

  assert.deepEqual(
    after.unresolved.filter((u) => u.field === "capabilities"), [],
    "常规命名不该产生噪音——队列淹了就没人看了",
  );
});
