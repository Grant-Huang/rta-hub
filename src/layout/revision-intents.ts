/**
 * 意图化修订 —— 场景 / 模拟器用意图，不写死不存在的 SKU 话术。
 *
 * note（含 #N）应在见到第一版图的 cabinetIndex 后再生成。
 */
import type { SharedPreferences } from "../domain/types.js";
import type { Placement } from "./generate.js";

export type LayoutRevisionIntent =
  | "spice_near_cooktop"
  | "trash_pullout"
  | "more_drawers"
  | "doors_over_drawers"
  | "enlarge_island"
  | "double_drawer"
  | "sink_under_window"
  | "swap_door_style"
  | "unactionable";

export interface CabinetIndexEntry {
  no: number;
  code?: string;
  wallRunId: string;
  layer: Placement["layer"];
  x: number;
  width: number;
  /** 同墙最近家电/水槽（若有） */
  near?: "range" | "cooktop" | "sink" | "refrigerator";
}

export interface ResolvedRevision {
  intent: LayoutRevisionIntent;
  note: string;
  changes: {
    storage?: SharedPreferences["storage"];
    budgetBand?: SharedPreferences["budgetBand"];
    doorStyleId?: string;
    layoutHints?: SharedPreferences["layoutHints"];
  };
}

/** 从 placements 建柜号索引（含 near 关系）。 */
export function buildCabinetIndex(placements: readonly Placement[]): CabinetIndexEntry[] {
  const anchors = placements.filter(
    (p) =>
      p.label === "sink"
      || p.applianceKind === "range"
      || p.applianceKind === "cooktop"
      || p.applianceKind === "refrigerator",
  );
  return placements
    .filter((p) => p.kind === "cabinet" && p.cabinetNo !== undefined && p.layer === "base")
    .map((p) => {
      const near = nearestAnchor(p, anchors);
      return {
        no: p.cabinetNo!,
        ...(p.moduleCode ? { code: p.moduleCode } : {}),
        wallRunId: p.wallRunId,
        layer: p.layer,
        x: p.x,
        width: p.width,
        ...(near ? { near } : {}),
      };
    })
    .sort((a, b) => a.no - b.no);
}

function nearestAnchor(
  cab: Placement,
  anchors: readonly Placement[],
): CabinetIndexEntry["near"] | undefined {
  let best: { kind: NonNullable<CabinetIndexEntry["near"]>; dist: number } | undefined;
  for (const a of anchors) {
    if (a.wallRunId !== cab.wallRunId) continue;
    const ax = a.x + a.width / 2;
    const cx = cab.x + cab.width / 2;
    const dist = Math.abs(ax - cx);
    const kind: NonNullable<CabinetIndexEntry["near"]> =
      a.label === "sink"
        ? "sink"
        : a.applianceKind === "range"
          ? "range"
          : a.applianceKind === "cooktop"
            ? "cooktop"
            : "refrigerator";
    if (!best || dist < best.dist) best = { kind, dist };
  }
  return best?.kind;
}

/** 找靠近灶具（range/cooktop）的地柜，供调料拉篮等意图落地。 */
export function pickCabinetNearCooktop(
  index: readonly CabinetIndexEntry[],
): CabinetIndexEntry | undefined {
  const near = index.find((c) => c.near === "range" || c.near === "cooktop");
  if (near) return near;
  return index[0];
}

export function pickCabinetNearSink(
  index: readonly CabinetIndexEntry[],
): CabinetIndexEntry | undefined {
  return index.find((c) => c.near === "sink") ?? index[0];
}

/**
 * 把意图落到 note + changes。cabinetIndex 来自首版俯视图；
 * 无索引时仍给可执行的意图级 changes（generate 侧按 near 再解析）。
 */
export function resolveRevisionIntent(input: {
  intent: LayoutRevisionIntent;
  note?: string;
  changes?: ResolvedRevision["changes"];
  cabinetIndex?: readonly CabinetIndexEntry[];
  doorStyleId?: string;
}): ResolvedRevision {
  const index = input.cabinetIndex ?? [];
  const base = input.changes ?? {};

  switch (input.intent) {
    case "spice_near_cooktop": {
      const cab = pickCabinetNearCooktop(index);
      const note =
        input.note
        ?? (cab
          ? `把靠近灶台的 #${cab.no} 换成调料拉篮`
          : "灶台旁边加个调料拉篮");
      return {
        intent: input.intent,
        note,
        changes: {
          ...base,
          layoutHints: {
            ...(base.layoutHints ?? {}),
            includeSpicePullout: true,
            spiceNear: "range",
            ...(cab ? { spiceCabinetNo: cab.no } : {}),
          },
        },
      };
    }
    case "trash_pullout": {
      const cab = pickCabinetNearSink(index) ?? pickCabinetNearCooktop(index);
      const note =
        input.note
        ?? (cab ? `把 #${cab.no} 换成放垃圾桶的柜子` : "增加放垃圾桶的柜子");
      return {
        intent: input.intent,
        note,
        changes: {
          ...base,
          layoutHints: {
            ...(base.layoutHints ?? {}),
            includeTrashPullout: true,
            trashNear: "sink",
            ...(cab ? { trashCabinetNo: cab.no } : {}),
          },
        },
      };
    }
    case "more_drawers":
      return {
        intent: input.intent,
        note: input.note ?? "锅具多，希望抽屉多一些",
        changes: { ...base, storage: base.storage ?? "drawers" },
      };
    case "doors_over_drawers":
      return {
        intent: input.intent,
        note: input.note ?? "抽屉做这么多有点贵，还是多用门板柜吧",
        changes: { ...base, storage: base.storage ?? "doors" },
      };
    case "enlarge_island":
      return {
        intent: input.intent,
        note: input.note ?? "把岛台做大一点",
        changes: {
          ...base,
          layoutHints: {
            ...(base.layoutHints ?? {}),
            enlargeIslandInches: base.layoutHints?.enlargeIslandInches ?? 12,
          },
        },
      };
    case "double_drawer": {
      const cab =
        pickCabinetNearCooktop(index)
        ?? index.find((c) => c.width >= 15)
        ?? index[0];
      const note =
        input.note
        ?? (cab ? `把 #${cab.no} 改成双抽` : "灶台附近那个柜子改成双抽");
      return {
        intent: input.intent,
        note,
        changes: {
          ...base,
          layoutHints: {
            ...(base.layoutHints ?? {}),
            ...(cab ? { doubleDrawerNos: [cab.no] } : {}),
          },
        },
      };
    }
    case "sink_under_window":
      return {
        intent: input.intent,
        note: input.note ?? "sink base要放在窗子下面",
        changes: base,
      };
    case "swap_door_style":
      return {
        intent: input.intent,
        note: input.note ?? "门板换个样式看看",
        changes: {
          ...base,
          ...(input.doorStyleId || base.doorStyleId
            ? { doorStyleId: input.doorStyleId ?? base.doorStyleId }
            : {}),
        },
      };
    case "unactionable":
      return {
        intent: input.intent,
        note: input.note ?? "整体看着大气一点就好",
        changes: {},
      };
  }
}

/** 冒烟：note 里若点名 #N 或 moduleCode，下一版必须真有对应物。 */
export function assertNoteMatchesLayout(input: {
  note: string;
  cabinetIndex: readonly CabinetIndexEntry[];
  moduleCodes: readonly string[];
}): { ok: boolean; detail?: string } {
  const nos = [...input.note.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  for (const n of nos) {
    if (!input.cabinetIndex.some((c) => c.no === n)) {
      return { ok: false, detail: `note 提到 #${n} 但本版没有该柜号` };
    }
  }
  // 仅当 note 显式出现「换成 XXX」类型号时才核验 moduleCodes（避免误伤普通英文）
  const codeHit = input.note.match(
    /(?:换成|改成|用)\s*([A-Z]{1,6}\d{2}[A-Z0-9]*)/i,
  );
  if (codeHit?.[1]) {
    const code = codeHit[1].toUpperCase();
    if (!input.moduleCodes.map((c) => c.toUpperCase()).includes(code)) {
      return { ok: false, detail: `note 提到 ${code} 但本版 moduleCounts 没有` };
    }
  }
  return { ok: true };
}
