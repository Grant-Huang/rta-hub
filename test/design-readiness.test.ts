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
  assert.match(applSection!.body, /33"|Refrigerator/i);
  assert.ok(r.confirmedFacts.some((f) => f.key.startsWith("appliance:") && f.status === "assumed"));
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

test("Tab1 sections 未谈及时写 Not discussed，而不是铺满 TBD 字段", () => {
  const r = evaluateDesignReadiness({ conversation: conv(), plan: undefined, language: "en" });
  const site = r.sections.find((s) => s.id === "site");
  assert.ok(site);
  assert.match(site!.body, /Not discussed/i);
});

test("组内一项已确认、另一项还缺时，徽标不能标成整组「未讨论」", () => {
  // 上下水已确认（有 plumbing feature），窗还没谈——不是"整组没聊"，
  // 是"聊了一半"，body 里也确实带出了上下水的真实数据。
  const plan = readyPlan();
  const r = evaluateDesignReadiness({ conversation: conv(), plan, language: "en" });
  const site = r.sections.find((s) => s.id === "site");
  assert.ok(site);
  assert.notEqual(site!.status, "untouched", "上下水已确认，不该说整组还没讨论过");
  assert.equal(site!.status, "clarify");
  assert.match(site!.body, /Plumbing/i, "body 应该带出已确认的上下水数据，不能被 untouched 掩盖");
  assert.doesNotMatch(site!.body, /Not discussed/i);
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

test("账号已有省份（注册必填）时，不必在聊天里重复说一遍才算已确认", () => {
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
  assert.equal(province1?.status, "ok", "账号上已有省份，不该继续追问");
  assert.match(province1!.brief, /Ontario|ON/);
  assert.equal(withAccount.readyToAskDesign, true);
});
