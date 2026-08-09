/**
 * 已发布 handbook 注入总控 / 解释（FR-22）。
 * 断言路径不得调用本模块。
 */
import type { PlatformKnowledgeCard } from "./types.js";
import type { UiLanguage } from "../i18n/language.js";

const MAX_CHARS = 6000;
const MAX_CARDS = 40;

export function publishedHandbookCards(
  cards: readonly PlatformKnowledgeCard[],
): PlatformKnowledgeCard[] {
  return cards
    .filter((c) => c.status === "published" && c.settleTarget === "handbook")
    .sort((a, b) => {
      // correction 优先，然后新近
      const ak = a.kind === "correction" ? 0 : 1;
      const bk = b.kind === "correction" ? 0 : 1;
      if (ak !== bk) return ak - bk;
      return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
    });
}

export function renderHandbookForPrompt(
  cards: readonly PlatformKnowledgeCard[],
  lang: UiLanguage = "en",
  opts?: { scopes?: readonly string[] },
): string {
  const scopes = opts?.scopes;
  let list = publishedHandbookCards(cards);
  if (scopes?.length) {
    list = list.filter(
      (c) =>
        c.scope.includes("all") ||
        c.scope.some((s) => scopes.includes(s)),
    );
  }
  list = list.slice(0, MAX_CARDS);

  const lines: string[] = [];
  let total = 0;
  for (const c of list) {
    const body = lang === "zh" && c.body.zh ? c.body.zh : c.body.en;
    const block = `- [${c.kind}] ${c.title}: ${body}`;
    if (total + block.length > MAX_CHARS) break;
    lines.push(block);
    total += block.length;
  }
  if (!lines.length) return "";
  const header =
    lang === "zh"
      ? "平台已发布手册（运营训练，非某厂规格）："
      : "Platform handbook (ops-trained, not any seller catalog):";
  return `${header}\n${lines.join("\n")}`;
}

export function exportKnowledgeMarkdown(cards: readonly PlatformKnowledgeCard[]): string {
  const lines = ["# Platform knowledge export", ""];
  for (const c of cards) {
    lines.push(`## ${c.title}`);
    lines.push(`- id: ${c.id}`);
    lines.push(`- status: ${c.status}`);
    lines.push(`- settleTarget: ${c.settleTarget}`);
    lines.push(`- settleStatus: ${c.settleStatus ?? "—"}`);
    lines.push(`- kind: ${c.kind}`);
    lines.push(`- scope: ${c.scope.join(", ")}`);
    lines.push("");
    lines.push(c.body.en);
    if (c.body.zh) lines.push("", c.body.zh);
    if (c.structured) {
      lines.push("", "```json", JSON.stringify(c.structured, null, 2), "```");
    }
    lines.push("");
  }
  return lines.join("\n");
}
