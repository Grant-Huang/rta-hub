/**
 * FR-16：售卖单元解析、PriceGroup 不得冒充 BOX/DOOR、报价分行、Agent 注入边界。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  priceGroupLooksLikeBoxDoorSuffix, resolveSellUnit,
} from "../src/spec/sku-semantics.js";
import { validateSpecSemantics } from "../src/spec/validation.js";
import { buildQuoteList } from "../src/quote/line-items.js";
import { buildCompanyAgentSystem } from "../src/agents/orchestrator.js";
import { fromDollars } from "../src/domain/money.js";
import type { ModuleSpec, Quote } from "../src/domain/types.js";
import type { SpecBundle } from "../src/spec/bundle.js";
import { emptyBundle } from "../src/spec/bundle.js";
import { oppeinPriceGroups, oppeinCodingRules } from "../src/app/seed-fourth.js";
import { pilotSpecVersion } from "../src/app/seed.js";

test("L0：声明优先 → type standalone → -BOX/-DOOR → 材质+花色 combo → 默认 combo", () => {
  assert.equal(resolveSellUnit({ code: "B12", declared: "box" }).sellUnit, "box");
  assert.equal(resolveSellUnit({ code: "X", type: "filler" }).sellUnit, "standalone");
  assert.equal(resolveSellUnit({ code: "B12-PLY-BOX" }).sellUnit, "box");
  assert.equal(resolveSellUnit({ code: "B12-MNW-DOOR" }).sellUnit, "door");
  assert.equal(resolveSellUnit({ code: "B12-PLY-MNW" }).sellUnit, "combo");
  const def = resolveSellUnit({ code: "B12" });
  assert.equal(def.sellUnit, "combo");
  assert.match(def.reason, /default combo/);
});

test("PriceGroup 冒充 BOX/DOOR 被识别并阻断", () => {
  assert.equal(priceGroupLooksLikeBoxDoorSuffix("PLY-BOX"), true);
  assert.equal(priceGroupLooksLikeBoxDoorSuffix("MNW-DOOR"), true);
  assert.equal(priceGroupLooksLikeBoxDoorSuffix("MNW"), false);

  const issues = validateSpecSemantics({
    modules: [],
    priceGroups: [{ code: "PLY-BOX" }, { code: "A" }],
  });
  assert.ok(issues.some((i) => i.code === "PRICE_GROUP_MASQUERADES_BOX_DOOR" && i.severity === "blocking"));
});

test("Oppein seed 不再用 PriceGroup 冒充 BOX/DOOR", () => {
  for (const pg of oppeinPriceGroups) {
    assert.equal(priceGroupLooksLikeBoxDoorSuffix(pg.code), false, pg.code);
  }
  assert.equal(oppeinCodingRules.usesBoxDoorSuffixes, true);
});

test("filler 声明为 combo 自相矛盾", () => {
  const issues = validateSpecSemantics({
    modules: [{
      id: "m1", specVersionId: "s", companyId: "c", code: "WF3", type: "filler",
      sellUnit: "combo",
      widthOptions: [3], heightOptions: [30], depthOptions: [0.75], assemblyOptions: ["RTA"],
    }],
    priceGroups: [],
  });
  assert.ok(issues.some((i) => i.code === "SELL_UNIT_CONTRADICTS_TYPE"));
});

test("standalone / box 不进门板从属；combo 保留含门说明", () => {
  const modules: ModuleSpec[] = [
    {
      id: "m_b12", specVersionId: "s", companyId: "c", code: "B12", type: "base",
      sellUnit: "combo", widthOptions: [12], heightOptions: [34.5], depthOptions: [24],
      assemblyOptions: ["RTA"],
    },
    {
      id: "m_box", specVersionId: "s", companyId: "c", code: "B12-PLY-BOX", type: "base",
      sellUnit: "box", widthOptions: [12], heightOptions: [34.5], depthOptions: [24],
      assemblyOptions: ["RTA"], finishDependent: false,
    },
    {
      id: "m_wf", specVersionId: "s", companyId: "c", code: "WF3", type: "filler",
      sellUnit: "standalone", widthOptions: [3], heightOptions: [30], depthOptions: [0.75],
      assemblyOptions: ["RTA"],
    },
  ];
  const quote = {
    id: "q", companyId: "c", conversationId: "cv", specVersionId: "s",
    doorStyleId: "ds", lineItems: [
      {
        moduleId: "m_b12", moduleCode: "B12", qty: 1,
        width: 12, height: 34.5, depth: 24, assembly: "RTA" as const,
        unitListPrice: fromDollars(100), unitNetPrice: fromDollars(100),
        modifiers: [], lineSubtotal: fromDollars(100),
      },
      {
        moduleId: "m_box", moduleCode: "B12-PLY-BOX", qty: 1,
        width: 12, height: 34.5, depth: 24, assembly: "RTA" as const,
        unitListPrice: fromDollars(80), unitNetPrice: fromDollars(80),
        modifiers: [], lineSubtotal: fromDollars(80),
      },
      {
        moduleId: "m_wf", moduleCode: "WF3", qty: 1,
        width: 3, height: 30, depth: 0.75, assembly: "RTA" as const,
        unitListPrice: fromDollars(20), unitNetPrice: fromDollars(20),
        modifiers: [], lineSubtotal: fromDollars(20),
      },
    ],
    subtotal: fromDollars(200),
  } as unknown as Quote;

  const list = buildQuoteList({
    quote, modules,
    doorStyles: [{ id: "ds", name: "White", priceGroupId: "pg", specVersionId: "s", companyId: "c" }],
  });
  assert.equal(list.cabinets.length, 1);
  assert.equal(list.cabinets[0]!.cabinet.code, "B12");
  assert.ok(list.cabinets[0]!.door.includedNote);
  assert.ok(list.trim.some((r) => r.code === "WF3"));
  assert.ok(list.trim.some((r) => r.code === "B12-PLY-BOX"));
});

test("公司 Agent 注入本公司 CodingRules；不含别厂前缀", () => {
  const bundle: SpecBundle = {
    ...emptyBundle("s", "c"),
    modules: [{
      id: "m", specVersionId: "s", companyId: "c", code: "B12", type: "base",
      widthOptions: [12], heightOptions: [34.5], depthOptions: [24], assemblyOptions: ["RTA"],
    }],
  };
  const sys = buildCompanyAgentSystem("Maple Ridge", bundle, "en", pilotSpecVersion.codingRules);
  assert.match(sys, /base cabinet/i);
  assert.match(sys, /ONLY this seller's prefix/i);
  assert.doesNotMatch(sys, /NW-B/);
  assert.doesNotMatch(sys, /Lakeside/);
});
