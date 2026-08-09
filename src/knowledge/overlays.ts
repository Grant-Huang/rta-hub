/**
 * 从已发布知识卡合并平台 overlay（FR-22）。
 * 断言路径只读本对象，不读 handbook 正文。
 */
import type { PlatformKnowledgeCard, PlatformOverlays } from "./types.js";

export function publishedConfigCards(
  cards: readonly PlatformKnowledgeCard[],
): PlatformKnowledgeCard[] {
  return cards.filter(
    (c) =>
      c.status === "published" &&
      (c.settleTarget === "config.appliance" ||
        c.settleTarget === "config.layoutHeuristic" ||
        c.settleTarget === "config.dialogue"),
  );
}

export function buildOverlaysFromCards(
  cards: readonly PlatformKnowledgeCard[],
): PlatformOverlays {
  const out: PlatformOverlays = {};
  for (const c of publishedConfigCards(cards)) {
    const st = c.structured;
    if (!st) continue;

    if (c.settleTarget === "config.appliance" && st.applianceDefaults) {
      const a = st.applianceDefaults;
      out.appliance = {
        ...out.appliance,
        ...(a.rangeKind ? { rangeKind: a.rangeKind } : {}),
        ...(a.preferNoCooktopBase != null
          ? { preferNoCooktopBase: a.preferNoCooktopBase }
          : {}),
        ...(a.standardWidthsIn ? { standardWidthsIn: a.standardWidthsIn } : {}),
        ...(a.defaultWidths
          ? { defaultWidths: { ...out.appliance?.defaultWidths, ...a.defaultWidths } }
          : {}),
      };
      // range 标准宽度写入 defaultWidths.range
      if (a.standardWidthsIn?.[0] != null) {
        out.appliance = {
          ...out.appliance,
          defaultWidths: {
            ...out.appliance?.defaultWidths,
            range: a.standardWidthsIn[0],
          },
        };
      }
    }

    if (c.settleTarget === "config.layoutHeuristic") {
      const prefer =
        st.layoutHeuristic?.preferNoCooktopBase ??
        st.applianceDefaults?.preferNoCooktopBase;
      if (prefer != null) {
        out.layoutHeuristic = {
          ...out.layoutHeuristic,
          preferNoCooktopBase: prefer,
        };
      }
    }

    if (c.settleTarget === "config.dialogue" && st.dialogue) {
      out.dialogue = { ...out.dialogue, ...st.dialogue };
    }
  }
  return out;
}

export function preferNoCooktopBase(overlays: PlatformOverlays | undefined): boolean {
  return Boolean(
    overlays?.layoutHeuristic?.preferNoCooktopBase ||
      overlays?.appliance?.preferNoCooktopBase,
  );
}
