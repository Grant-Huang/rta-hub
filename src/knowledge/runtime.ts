/**
 * 从仓储卡片得到运行时 handbook / overlay（FR-22）。
 * 强制经 `cardsForRuntimeInjection`——未 publish / 非白名单 sink 不得进入客户路径。
 */
import { preferNoCooktopBase } from "./overlays.js";
import type { PlatformKnowledgeCard, PlatformOverlays } from "./types.js";
import type { UiLanguage } from "../i18n/language.js";
import type { ApplianceKind } from "../floorplan/appliances.js";
import {
  handbookPromptForRuntime,
  overlaysForRuntime,
} from "./access.js";

export function platformKnowledgeRuntime(cards: readonly PlatformKnowledgeCard[]): {
  overlays: PlatformOverlays;
  handbook: (lang: UiLanguage) => string;
} {
  const overlays = overlaysForRuntime(cards);
  return {
    overlays,
    handbook: (lang) =>
      handbookPromptForRuntime(cards, lang, { scopes: ["orchestrator", "all"] }),
  };
}

/** 塞进 LayoutOptions 的白名单字段。 */
export function layoutOptsFromOverlays(overlays: PlatformOverlays): {
  layoutHeuristic?: { preferNoCooktopBase: boolean };
  applianceDefaultWidths?: Partial<Record<ApplianceKind, number>>;
} {
  const out: ReturnType<typeof layoutOptsFromOverlays> = {};
  if (preferNoCooktopBase(overlays)) {
    out.layoutHeuristic = { preferNoCooktopBase: true };
  }
  if (overlays.appliance?.defaultWidths) {
    out.applianceDefaultWidths = overlays.appliance.defaultWidths as Partial<
      Record<ApplianceKind, number>
    >;
  }
  return out;
}
