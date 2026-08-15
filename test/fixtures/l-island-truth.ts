/**
 * L 型+岛台样张真值，以及对照视觉 raw 的计分（测试用，不进生产抽取）。
 */
import type { RawExtraction } from "../../src/floorplan/parse.js";

export const L_ISLAND_TRUTH = {
  walls: [
    { slot: "North", length: 144 },
    { slot: "East", length: 120 },
    { slot: "Island", length: 72, depth: 36 },
  ],
  ceiling: 96,
  features: [
    { slot: "North", kind: "window", offset: 48, width: 36 },
    { slot: "East", kind: "plumbing", offset: 36, width: 24 },
    { slot: "East", kind: "door", offset: 88, width: 32 },
  ],
} as const;

export function scoreAgainstTruth(raw: RawExtraction): {
  wallHits: number;
  featureWallHits: number;
  featureOffsetHits: number;
  features: { slot: string; kind: string; wallOk: boolean; offsetOk: boolean; offset?: number }[];
} {
  const runs = raw.wallRuns ?? [];
  const bySlot = new Map(runs.map((r) => [(r.slot ?? r.label ?? "").toLowerCase(), r]));
  const wallHits = L_ISLAND_TRUTH.walls.filter((w) => {
    const got = bySlot.get(w.slot.toLowerCase())
      ?? runs.find((r) => (r.label ?? "").toLowerCase().includes(w.slot.toLowerCase()));
    return got && typeof got.length === "number" && Math.abs(got.length - w.length) <= 3;
  }).length;

  const features = L_ISLAND_TRUTH.features.map((t) => {
    const onTruthWall = runs.find((r) =>
      (r.slot ?? "").toLowerCase() === t.slot.toLowerCase()
      || (r.label ?? "").toLowerCase().includes(t.slot.toLowerCase()));
    const hit = onTruthWall?.features?.find((f) => f.kind === t.kind);
    const elsewhere = hit ? undefined : runs.find((r) => r.features?.some((f) => f.kind === t.kind));
    const found = hit ?? elsewhere?.features?.find((f) => f.kind === t.kind);
    const wallOk = Boolean(hit);
    const offsetOk = Boolean(found && typeof found.offset === "number"
      && Math.abs(found.offset - t.offset) <= 6);
    return { slot: t.slot, kind: t.kind, wallOk, offsetOk, offset: found?.offset };
  });

  return {
    wallHits,
    featureWallHits: features.filter((f) => f.wallOk).length,
    featureOffsetHits: features.filter((f) => f.wallOk && f.offsetOk).length,
    features,
  };
}
