/**
 * 客户会话生命周期：active ↔ archived（UI_SHELL_REDESIGN）。
 * 缺省 status 视为 active，兼容旧数据。
 */

export type ConversationLifecycleStatus = "active" | "archived";

export interface LifecycleFields {
  status?: ConversationLifecycleStatus;
  archivedAt?: string;
}

export function lifecycleStatus(conv: LifecycleFields): ConversationLifecycleStatus {
  return conv.status === "archived" ? "archived" : "active";
}

export function isConversationArchived(conv: LifecycleFields): boolean {
  return lifecycleStatus(conv) === "archived";
}

/** 列表/tooltip 用的完整标题；无用户消息时回落默认文案。 */
export function conversationFullTitle(
  messages: { role: string; content: string }[],
  emptyLabel = "New conversation",
): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = (firstUser?.content ?? "").trim();
  return text || emptyLabel;
}

export function truncateConversationTitle(full: string, max = 40): string {
  if (full.length <= max) return full;
  return full.slice(0, max);
}
