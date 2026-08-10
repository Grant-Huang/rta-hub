/**
 * 户型图AI审查测试 —— 发给客户前的质量闸门。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  reviewSiteDiagramDeterministic,
  type SiteDiagramReviewInput,
} from "../../src/delivery/site-diagram-review.js";
import type { FloorPlan, ParsedGeometry } from "../../src/floorplan/types.js";
import type { Conversation } from "../../src/domain/types.js";
import type { SiteQuestion } from "../../src/design/site-questions.js";
import type { SiteDiagramResult } from "../../src/render/site-diagram.js";

const NOW = new Date().toISOString();

function mockGeometry(wallRuns: Array<{ id: string; label: string; length: number }>): ParsedGeometry {
  return {
    wallRuns: wallRuns.map((r) => ({
      id: r.id,
      label: r.label,
      length: r.length,
      features: [],
      kind: "wall" as const,
      startsAtCorner: false,
      endsAtCorner: false,
    })),
    ceilingHeight: 96,
    confidence: 0.9,
  };
}

function mockFloorPlan(geometry: ParsedGeometry): FloorPlan {
  return {
    id: "fp_test",
    conversationId: "conv_test",
    sourceFile: { name: "test.png", mimeType: "image/png", sizeBytes: 1000 },
    parsedGeometry: geometry,
    parseConfidence: 0.9,
    unresolvedItems: [],
    appliances: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function mockConversation(requirements = ""): Conversation {
  return {
    id: "conv_test",
    customerAccountId: "acc_test",
    messages: [],
    designRequirements: requirements,
    perCompanyThreads: [],
    status: "active" as const,
    createdAt: NOW,
    origin: "test" as const,
    runId: "test-run",
  };
}

describe("siteDiagramReview", () => {
  it("should block when walls have no labels", () => {
    const geometry = mockGeometry([
      { id: "w1", label: "", length: 120 },
      { id: "w2", label: "North", length: 96 },
    ]);
    const plan = mockFloorPlan(geometry);
    const diagram: SiteDiagramResult = {
      svg: "<svg></svg>",
      wallLabels: ["North"],
      questionMarks: [],
    };
    const questions: SiteQuestion[] = [];
    const conv = mockConversation();

    const result = reviewSiteDiagramDeterministic({
      diagram,
      floorPlan: plan,
      siteQuestions: questions,
      conversation: conv,
      language: "en",
    });

    assert.equal(result.ok, false);
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0]!.code, "UNLABELED_WALLS");
  });

  it("should block when wall label in questions not in diagram", () => {
    const geometry = mockGeometry([
      { id: "w1", label: "South", length: 120 },
      { id: "w2", label: "North", length: 96 },
    ]);
    const plan = mockFloorPlan(geometry);
    const diagram: SiteDiagramResult = {
      svg: "<svg></svg>",
      wallLabels: ["North"], // Missing "South"
      questionMarks: [],
    };
    const questions: SiteQuestion[] = [
      {
        q: 1,
        id: "sq_wall_w1",
        kind: "wall_confirm",
        wallRunId: "w1",
        wallLabel: "South",
        prompt: "Q1: Confirm South wall length?",
        mark: "South?",
      },
    ];
    const conv = mockConversation();

    const result = reviewSiteDiagramDeterministic({
      diagram,
      floorPlan: plan,
      siteQuestions: questions,
      conversation: conv,
      language: "en",
    });

    assert.equal(result.ok, false);
    const mismatch = result.blockers.find((b) => b.code === "WALL_LABEL_MISMATCH");
    assert.ok(mismatch);
    assert.ok(mismatch.detail.includes("South"));
  });

  it("should warn when Q# in questions but not in diagram", () => {
    const geometry = mockGeometry([
      { id: "w1", label: "North", length: 120 },
    ]);
    const plan = mockFloorPlan(geometry);
    const diagram: SiteDiagramResult = {
      svg: "<svg></svg>",
      wallLabels: ["North"],
      questionMarks: [], // Missing Q1
    };
    const questions: SiteQuestion[] = [
      {
        q: 1,
        id: "sq_ceiling",
        kind: "ceiling",
        prompt: "Q1: What is ceiling height?",
        mark: "Ceiling?",
      },
    ];
    const conv = mockConversation();

    const result = reviewSiteDiagramDeterministic({
      diagram,
      floorPlan: plan,
      siteQuestions: questions,
      conversation: conv,
      language: "en",
    });

    // Warning, not blocking
    assert.equal(result.ok, true);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]!.code, "Q_NUMBER_MISMATCH");
  });

  it("should block when no wall lengths available", () => {
    const geometry = mockGeometry([
      { id: "w1", label: "North", length: 0 },
      { id: "w2", label: "South", length: 0 },
    ]);
    const plan = mockFloorPlan(geometry);
    const diagram: SiteDiagramResult = {
      svg: "<svg></svg>",
      wallLabels: ["North", "South"],
      questionMarks: [],
    };
    const questions: SiteQuestion[] = [];
    const conv = mockConversation();

    const result = reviewSiteDiagramDeterministic({
      diagram,
      floorPlan: plan,
      siteQuestions: questions,
      conversation: conv,
      language: "en",
    });

    assert.equal(result.ok, false);
    const missing = result.blockers.find((b) => b.code === "MISSING_DIMENSIONS");
    assert.ok(missing);
  });

  it("should pass when all checks are satisfied", () => {
    const geometry = mockGeometry([
      { id: "w1", label: "North", length: 120 },
      { id: "w2", label: "South", length: 96 },
    ]);
    const plan = mockFloorPlan(geometry);
    const diagram: SiteDiagramResult = {
      svg: "<svg></svg>",
      wallLabels: ["North", "South"],
      questionMarks: ["Q1"],
    };
    const questions: SiteQuestion[] = [
      {
        q: 1,
        id: "sq_ceiling",
        kind: "ceiling",
        prompt: "Q1: What is ceiling height?",
        mark: "Ceiling?",
      },
    ];
    const conv = mockConversation("North wall 120 inches, South wall 96 inches");

    const result = reviewSiteDiagramDeterministic({
      diagram,
      floorPlan: plan,
      siteQuestions: questions,
      conversation: conv,
      language: "en",
    });

    assert.equal(result.ok, true);
    assert.equal(result.blockers.length, 0);
  });

  it("should warn when requirements mention wall not in diagram", () => {
    const geometry = mockGeometry([
      { id: "w1", label: "North", length: 120 },
      { id: "w2", label: "East", length: 96 },
    ]);
    const plan = mockFloorPlan(geometry);
    const diagram: SiteDiagramResult = {
      svg: "<svg></svg>",
      wallLabels: ["North"], // Missing "East"
      questionMarks: [],
    };
    const questions: SiteQuestion[] = [];
    const conv = mockConversation("The East wall has a window");

    const result = reviewSiteDiagramDeterministic({
      diagram,
      floorPlan: plan,
      siteQuestions: questions,
      conversation: conv,
      language: "en",
    });

    assert.equal(result.ok, true); // Warning, not blocking
    const warn = result.warnings.find((w) => w.code === "CONFIRMED_VS_DIAGRAM");
    assert.ok(warn);
    assert.ok(warn.detail.includes("East"));
  });
});
