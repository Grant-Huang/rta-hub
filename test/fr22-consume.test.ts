/**
 * FR-22：overlay 消费 —— preferNoCooktopBase / handbook 注入。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  confirmCard,
  createDraftCard,
  publishCard,
  renderHandbookForPrompt,
  buildOverlaysFromCards,
  layoutOptsFromOverlays,
} from "../src/knowledge/index.js";
import { resolveLayoutAppliances } from "../src/layout/generate.js";
import { applianceFrom } from "../src/floorplan/appliances.js";
import { optionsFor, orchestratorReply } from "../src/agents/orchestrator.js";

test("preferNoCooktopBase filters assumed cooktop from layout appliances", () => {
  const withAssumedCooktop = resolveLayoutAppliances({
    appliances: [
      applianceFrom({ kind: "refrigerator" }),
      applianceFrom({ kind: "cooktop" }), // assumed
    ],
    layoutHeuristic: { preferNoCooktopBase: true },
  });
  assert.equal(withAssumedCooktop.some((a) => a.kind === "cooktop"), false);

  const customerCooktop = applianceFrom({ kind: "cooktop", width: 30 });
  assert.equal(customerCooktop.provenance, "customer");
  const kept = resolveLayoutAppliances({
    appliances: [customerCooktop],
    layoutHeuristic: { preferNoCooktopBase: true },
  });
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.kind, "cooktop");
});

test("layoutOptsFromOverlays maps published config cards", () => {
  let c = createDraftCard({
    kind: "design_heuristic",
    scope: ["layout"],
    settleTarget: "config.layoutHeuristic",
    title: "No cooktop base",
    body: { en: "Prefer freestanding range openings." },
    structured: { layoutHeuristic: { preferNoCooktopBase: true } },
    provenance: {
      trainerConversationId: "t",
      taughtBy: "admin",
      taughtAt: new Date().toISOString(),
    },
  });
  c = publishCard(confirmCard(c), "admin");
  const opts = layoutOptsFromOverlays(buildOverlaysFromCards([c]));
  assert.equal(opts.layoutHeuristic?.preferNoCooktopBase, true);
});

test("orchestrator gets handbook only when provided", async () => {
  const card = publishCard(
    confirmCard(
      createDraftCard({
        kind: "domain_fact",
        scope: ["orchestrator"],
        settleTarget: "handbook",
        title: "Range tip",
        body: { en: "NA stove is usually freestanding range." },
        provenance: {
          trainerConversationId: "t",
          taughtBy: "admin",
          taughtAt: new Date().toISOString(),
        },
      }),
    ),
    "admin",
  );
  const handbook = renderHandbookForPrompt([card], "en");
  assert.match(handbook, /freestanding range/);

  let capturedSystem = "";
  const client = {
    async complete(req: { system: string }) {
      capturedSystem = req.system;
      return "ok";
    },
  };
  await orchestratorReply(
    client,
    { conversationId: "c", requirements: "", history: [] },
    "hi",
    { ...optionsFor("consumer"), platformHandbook: handbook },
  );
  assert.match(capturedSystem, /Platform handbook/);
  assert.match(capturedSystem, /freestanding range/);
});
