import { buildKitchenPlan } from "./src/layout/plan-model.js";
import { generateLayout } from "./src/layout/generate.js";
import { auditDeliverable } from "./src/delivery/audit.js";
import { pilotModules } from "./src/app/seed.js";
import { applianceFrom } from "./src/floorplan/appliances.js";
import type { ParsedGeometry, WallRun } from "./src/floorplan/types.js";
const appliances = [applianceFrom({ kind: "refrigerator", width: 33 }), applianceFrom({ kind: "range", width: 30 })];
function wall(id: string, label: string, length: number, opts: Partial<WallRun> = {}): WallRun {
  return { id, label, length, startsAtCorner: false, endsAtCorner: false, features: [], ...opts };
}
const g: ParsedGeometry = {
  wallRuns: [
    wall("w1","南墙",120,{ startsAtCorner:true, endsAtCorner:true, features:[{id:"d",kind:"door",offset:40,width:32}] }),
    wall("w2","东墙",120,{ startsAtCorner:true, endsAtCorner:true, features:[{id:"p",kind:"plumbing",offset:50,width:24}] }),
    wall("w3","北墙",120,{ startsAtCorner:true, endsAtCorner:true }),
    wall("w4","西墙",120,{ startsAtCorner:true, endsAtCorner:true }),
  ], ceilingHeight: 96, confidence: 1,
};
const plan = buildKitchenPlan(g);
console.log("corners", plan.corners.map(c=>`${c.ownerRunId}/${c.ownerEnd} yields ${c.yieldingRunId}/${c.yieldingEnd}`));
for (const r of plan.runs) console.log(r.run.id, r.origin, r.heading, "setback", r.setbackStart.base, r.setbackEnd.base);
const layout = generateLayout(g, pilotModules, { ceilingHeight: 96, appliances });
console.log("acceptable", layout.acceptable);
const rep = auditDeliverable({ deliverable:"planView", stage:"planReview", layout, wallRuns: g.wallRuns } as any);
console.log("ok", rep.ok);
console.log("blockers", rep.blockers.map((b:any)=>b.code+" | "+b.message));
