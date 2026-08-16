/**
 * FR-15 设计就绪检查表。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateDesignReadiness } from "../src/design/readiness.js";
import type { Conversation } from "../src/domain/types.js";
import type { FloorPlan } from "../src/floorplan/types.js";

const AT = "2026-06-01T00:00:00.000Z";

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "cv_1",
    customerAccountId: "ca_1",
    messages: [],
    designRequirements: "",
    perCompanyThreads: [],
    createdAt: AT,
    ...over,
  };
}

function readyPlan(over: Partial<FloorPlan["parsedGeometry"]> = {}): FloorPlan {
  return {
    id: "fp_1",
    conversationId: "cv_1",
    sourceFile: { name: "k.png", mimeType: "image/png", sizeBytes: 1 },
    parsedGeometry: {
      // 上下水靠一端，另一侧留出冰箱位（中置水槽 78" 软占位会把 36" 冰箱挤没）
      wallRuns: [{
        id: "wr_1", label: "North", length: 168,
        startsAtCorner: false, endsAtCorner: false,
        features: [{ id: "wf_1", kind: "plumbing", offset: 24, width: 24 }],
      }],
      ceilingHeight: 96,
      confidence: 0.9,
      ...over,
    },
    parseConfidence: 0.9,
    unresolvedItems: [],
    createdAt: AT,
    updatedAt: AT,
  };
}

test("墙长未齐时不能问出设计", () => {
  const r = evaluateDesignReadiness({ conversation: conv(), plan: undefined, language: "en" });
  assert.equal(r.readyToAskDesign, false);
  assert.ok(r.items.find((i) => i.id === "walls_ceiling")?.status === "missing");
});

test("几何齐但缺上下水时不能问出设计（不能猜）", () => {
  const plan = readyPlan({
    wallRuns: [{
      id: "wr_1", label: "North", length: 144,
      startsAtCorner: false, endsAtCorner: false, features: [],
    }],
  });
  const r = evaluateDesignReadiness({
    conversation: conv({
      designRequirements: "Modern style\nBudget CAD $10-20k\nOntario ON",
    }),
    plan,
    language: "en",
  });
  assert.equal(r.readyToAskDesign, false);
  assert.equal(r.items.find((i) => i.id === "plumbing")?.status, "missing");
});

test("关键项齐备时 ready，并给出文字确认复述", () => {
  const plan = readyPlan();
  plan.appliances = [{
    kind: "refrigerator", width: 36, clearanceEachSide: 1, provenance: "customer",
  }];
  const r = evaluateDesignReadiness({
    conversation: conv({
      designRequirements:
        "Modern style\nBudget CAD $10-20k\nOntario ON\nNo windows\nFridge 36\"\nNo island",
    }),
    plan,
    companyId: "co_1",
    companyName: "Pilot Co",
    language: "en",
  });
  assert.equal(r.readyToAskDesign, true);
  assert.match(r.confirmationText, /Shall I generate a design/i);
  assert.match(r.confirmationText, /Plumbing/i);
  assert.ok(r.sections.some((s) => s.id === "space" && s.status === "locked"));
});

test("推定家电宽度记为 needs_confirm，且阻断进入出图问句", () => {
  const plan = readyPlan();
  plan.appliances = [{
    kind: "refrigerator", width: 36, clearanceEachSide: 1, provenance: "assumed",
  }];
  const r = evaluateDesignReadiness({
    conversation: conv({
      designRequirements: "Modern style\nBudget CAD $10-20k\nOntario ON\nNo windows",
    }),
    plan,
    language: "en",
  });
  assert.equal(r.readyToAskDesign, false);
  assert.equal(r.items.find((i) => i.id === "appliances_sizes")?.status, "needs_confirm");
  assert.equal(r.items.find((i) => i.id === "appliances_sizes")?.critical, true);
  assert.match(r.confirmationText, /assumed|confirm|宽度|推定/i);
});

test("接受推定后家电区为 assumed 标签且不再阻断出图", () => {
  const plan = readyPlan({
    wallRuns: [{
      id: "wr_1", label: "North", length: 216,
      startsAtCorner: false, endsAtCorner: false,
      features: [{ id: "wf_1", kind: "plumbing", offset: 24, width: 24 }],
    }],
  });
  plan.appliances = [{
    kind: "refrigerator", width: 33, clearanceEachSide: 1, provenance: "assumed",
  }, {
    kind: "range", width: 30, clearanceEachSide: 0, provenance: "assumed",
  }, {
    kind: "dishwasher", width: 24, clearanceEachSide: 0, provenance: "assumed",
  }];
  const r = evaluateDesignReadiness({
    conversation: conv({
      designRequirements:
        "Modern style\nBudget CAD $10-20k\nOntario ON\nNo windows\nassumed widths are fine",
    }),
    plan,
    language: "en",
  });
  assert.equal(r.items.find((i) => i.id === "appliances_sizes")?.status, "assumed");
  assert.equal(r.items.find((i) => i.id === "appliances_fit")?.status, "ok");
  assert.equal(r.readyToAskDesign, true);
  const applSection = r.sections.find((s) => s.id === "appliances");
  assert.equal(applSection?.status, "clarify");
  const assumedFridge = r.confirmedFacts.find(
    (f) => f.key === "appliance:refrigerator" && f.status === "assumed");
  assert.ok(assumedFridge, "推定的冰箱宽度应该出现在原子事实行里");
  assert.match(assumedFridge!.value, /33"/);
  assert.deepEqual(
    assumedFridge!.confirmTarget,
    { kind: "appliance", applianceKind: "refrigerator", width: 33 },
    "推定值应该带一键确认目标，客户不用重新输入宽度",
  );
});

test("墙长与家电宽度冲突时 appliances_fit 立即阻断就绪", () => {
  const plan = readyPlan({
    wallRuns: [{
      id: "wr_1", label: "North", length: 84,
      startsAtCorner: false, endsAtCorner: false,
      features: [{ id: "wf_1", kind: "plumbing", offset: 36, width: 24 }],
    }],
  });
  plan.appliances = [
    { kind: "refrigerator", width: 36, clearanceEachSide: 1, provenance: "customer" },
    { kind: "range", width: 30, clearanceEachSide: 0, provenance: "customer" },
  ];
  const r = evaluateDesignReadiness({
    conversation: conv({
      designRequirements:
        "Modern style\nBudget CAD $10-20k\nOntario ON\nNo windows\nFridge 36\" range 30\"",
    }),
    plan,
    language: "zh",
  });
  assert.equal(r.readyToAskDesign, false);
  const fit = r.items.find((i) => i.id === "appliances_fit");
  assert.equal(fit?.status, "missing");
  assert.equal(fit?.critical, true);
  assert.match(fit!.brief, /放不下|Refrigerator|冰箱|range|灶/i);
});

test("墙长不够时，提示里点名冰箱可以不放在这面墙", () => {
  const plan = readyPlan({
    wallRuns: [{
      id: "wr_1", label: "North", length: 70,
      startsAtCorner: false, endsAtCorner: false, features: [],
    }],
  });
  // range 先落位占住中段，冰箱才是放不下的那一台——顺序决定谁先拿到位置
  plan.appliances = [
    { kind: "range", width: 30, clearanceEachSide: 0, provenance: "customer" },
    { kind: "refrigerator", width: 36, clearanceEachSide: 1, provenance: "customer" },
  ];
  const r = evaluateDesignReadiness({
    conversation: conv({
      designRequirements:
        "Modern style\nBudget CAD $10-20k\nOntario ON\nNo windows\nFridge 36\" range 30\"",
    }),
    plan,
    language: "en",
  });
  const fit = r.items.find((i) => i.id === "appliances_fit");
  assert.equal(fit?.status, "missing");
  assert.match(fit!.brief, /Refrigerator/i, "确认这次放不下的确实是冰箱");
  assert.match(fit!.askHint ?? "", /elsewhere/i, "冰箱本身放不下时该给出这条出路");
});

test("客户已说冰箱放别处后，那面墙不再因为冰箱放不下而卡住", () => {
  const plan = readyPlan({
    wallRuns: [{
      id: "wr_1", label: "North", length: 70,
      startsAtCorner: false, endsAtCorner: false, features: [],
    }],
  });
  plan.appliances = [
    { kind: "refrigerator", width: 36, clearanceEachSide: 1, provenance: "customer", placement: "elsewhere" },
    { kind: "range", width: 30, clearanceEachSide: 0, provenance: "customer" },
  ];
  const r = evaluateDesignReadiness({
    conversation: conv({
      designRequirements:
        "Modern style\nBudget CAD $10-20k\nOntario ON\nNo windows\nFridge 36\" range 30\"",
    }),
    plan,
    language: "en",
  });
  const fit = r.items.find((i) => i.id === "appliances_fit");
  assert.equal(fit?.status, "ok", "冰箱不参与这面墙了，就不该再因为它放不下而卡住");
});

test("家电后定不能冒充就绪", () => {
  const r = evaluateDesignReadiness({
    conversation: conv({
      designRequirements:
        "Modern style\nBudget CAD $10-20k\nOntario ON\nNo windows\nAppliances later",
    }),
    plan: readyPlan(),
    language: "en",
  });
  assert.equal(r.readyToAskDesign, false);
  assert.equal(r.items.find((i) => i.id === "appliances_kinds")?.status, "missing");
  assert.equal(r.items.find((i) => i.id === "appliances_sizes")?.status, "missing");
});

test("Tab1 sections 未谈及时徽标是 untouched，且 confirmedFacts 里有占位行说明还缺什么", () => {
  const r = evaluateDesignReadiness({ conversation: conv(), plan: undefined, language: "en" });
  const site = r.sections.find((s) => s.id === "site");
  assert.ok(site);
  assert.equal(site!.status, "untouched");
  const plumbingPlaceholder = r.confirmedFacts.find((f) => f.key === "plumbing:placeholder");
  assert.ok(plumbingPlaceholder, "上下水还没谈过时也该有一条占位行");
  assert.equal(plumbingPlaceholder!.groupId, "site");
});

test("组内一项已确认、另一项还缺时，徽标不能标成整组「未讨论」", () => {
  // 上下水已确认（有 plumbing feature），窗还没谈——不是"整组没聊"，
  // 是"聊了一半"，confirmedFacts 里也确实能看到上下水已确认、窗仍缺。
  const plan = readyPlan();
  const r = evaluateDesignReadiness({ conversation: conv(), plan, language: "en" });
  const site = r.sections.find((s) => s.id === "site");
  assert.ok(site);
  assert.notEqual(site!.status, "untouched", "上下水已确认，不该说整组还没讨论过");
  assert.equal(site!.status, "clarify");
  const plumbingFact = r.confirmedFacts.find((f) => f.key.startsWith("plumbing:") && f.groupId === "site");
  assert.ok(plumbingFact, "上下水已确认应该带出真实数据，不能被 untouched 掩盖");
  assert.equal(plumbingFact!.status, "ok");
  const windowsPlaceholder = r.confirmedFacts.find((f) => f.key === "windows:placeholder");
  assert.ok(windowsPlaceholder, "窗还没谈过应该有占位行，不是完全不见");
});

test("风格 brief 写出标准术语，禁止「已记在需求里」", () => {
  const plan = readyPlan();
  plan.appliances = [{
    kind: "refrigerator", width: 36, clearanceEachSide: 1, provenance: "customer",
  }];
  const r = evaluateDesignReadiness({
    conversation: conv({
      designRequirements:
        "Modern style\nBudget CAD $10-20k\nOntario ON\nNo windows\nFridge 36\"",
    }),
    plan,
    language: "zh",
  });
  const style = r.items.find((i) => i.id === "style");
  assert.ok(style);
  assert.equal(style!.status, "ok");
  assert.match(style!.brief, /现代|Modern/i);
  assert.doesNotMatch(style!.brief, /已记在需求里/);
  assert.doesNotMatch(r.confirmationText, /noted in your requirements/i);
});

test("账号已有省份（注册必填）时，仅作建议值——needs_confirm，不当已确认；客户明确确认/改口后才算 ok", () => {
  const plan = readyPlan();
  plan.appliances = [{
    kind: "refrigerator", width: 36, clearanceEachSide: 1, provenance: "customer",
  }];
  const withoutAccount = evaluateDesignReadiness({
    conversation: conv({ designRequirements: "Modern style\nBudget CAD $10-20k\nNo windows\nFridge 36\"" }),
    plan,
    language: "en",
  });
  const province0 = withoutAccount.items.find((i) => i.id === "province");
  assert.equal(province0?.status, "missing", "没有账号省份、聊天也没提，仍应视为缺失");
  assert.equal(withoutAccount.readyToAskDesign, false);

  const withAccount = evaluateDesignReadiness({
    conversation: conv({ designRequirements: "Modern style\nBudget CAD $10-20k\nNo windows\nFridge 36\"" }),
    plan,
    language: "en",
    accountProvince: "ON",
  });
  const province1 = withAccount.items.find((i) => i.id === "province");
  assert.equal(province1?.status, "needs_confirm", "账号省份只是建议值，客户没确认过之前不能当已确认");
  assert.match(province1!.brief, /Ontario|ON/);
  assert.equal(withAccount.readyToAskDesign, false, "省份未确认应继续挡住出图，跟风格/预算一样");
  const provinceFact = withAccount.confirmedFacts.find((f) => f.key === "province");
  assert.ok(provinceFact, "建议值也该出现在原子事实行里");
  assert.deepEqual(
    provinceFact!.confirmTarget,
    { kind: "province", code: "ON" },
    "needs_confirm 且有明确建议值时，应该带一键确认目标",
  );

  // 客户在聊天里明确提过省份——算确认
  const confirmedInChat = evaluateDesignReadiness({
    conversation: conv({ designRequirements: "Modern style\nBudget CAD $10-20k\nNo windows\nFridge 36\"\nOntario ON" }),
    plan,
    language: "en",
    accountProvince: "ON",
  });
  const province2 = confirmedInChat.items.find((i) => i.id === "province");
  assert.equal(province2?.status, "ok");
  assert.equal(confirmedInChat.readyToAskDesign, true);

  // 客户用已确认面板的下拉框改过（走 preferences.shared.province，不经聊天正则）
  const confirmedViaDropdown = evaluateDesignReadiness({
    conversation: conv({
      designRequirements: "Modern style\nBudget CAD $10-20k\nNo windows\nFridge 36\"",
      preferences: { shared: { province: "BC" } },
    }),
    plan,
    language: "en",
    accountProvince: "ON",
  });
  const province3 = confirmedViaDropdown.items.find((i) => i.id === "province");
  assert.equal(province3?.status, "ok");
  assert.match(province3!.brief, /British Columbia|BC/, "下拉框改过的省份应覆盖账号建议值");
  assert.equal(confirmedViaDropdown.readyToAskDesign, true);
});

test("岛台长×进深进入已确认事实，未确认时标 needs_confirm", () => {
  const plan = readyPlan({
    wallRuns: [
      {
        id: "wr_1", label: "North", length: 168,
        startsAtCorner: false, endsAtCorner: false,
        features: [{ id: "wf_1", kind: "plumbing", offset: 24, width: 24 }],
      },
      {
        id: "wr_i", label: "Island", length: 72, kind: "island", depth: 36,
        startsAtCorner: false, endsAtCorner: false, features: [],
      },
    ],
  });
  plan.unresolvedItems = [
    { id: "fpu_i", target: { kind: "wallRun", id: "wr_i" }, field: "length", reason: "confirm", resolved: false },
  ];
  const r = evaluateDesignReadiness({ conversation: conv(), plan, language: "zh" });
  const islandItem = r.items.find((i) => i.id === "island");
  assert.ok(islandItem);
  assert.match(islandItem!.brief, /72/);
  assert.match(islandItem!.brief, /36/);
  assert.equal(islandItem!.status, "needs_confirm");
  const fact = r.confirmedFacts.find((f) => f.key === "wall:wr_i");
  assert.ok(fact);
  assert.match(fact!.value, /72/);
  assert.match(fact!.value, /36/);
  assert.equal(fact!.status, "needs_confirm");
});

test("视觉写入但未确认的墙长/层高/上下水在已确认 Tab 标 needs_confirm，不是 ok", () => {
  const plan = readyPlan();
  plan.unresolvedItems = [
    { id: "fpu_1", target: { kind: "wallRun", id: "wr_1" }, field: "length", reason: "confirm", resolved: false },
    { id: "fpu_2", target: { kind: "global" }, field: "ceilingHeight", reason: "confirm", resolved: false },
    { id: "fpu_3", target: { kind: "feature", id: "wf_1" }, field: "plumbing", reason: "confirm", resolved: false },
  ];
  const r = evaluateDesignReadiness({ conversation: conv(), plan, language: "zh" });
  assert.equal(r.confirmedFacts.find((f) => f.key === "wall:wr_1")?.status, "needs_confirm");
  assert.equal(r.confirmedFacts.find((f) => f.key === "ceiling")?.status, "needs_confirm");
  assert.equal(r.confirmedFacts.find((f) => f.key.startsWith("plumbing:"))?.status, "needs_confirm");
});
