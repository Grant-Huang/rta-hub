/**
 * 系统训练 Agent —— FR-22。仅 admin 通道调用。
 */
import { randomUUID } from "node:crypto";
import type { CompletionClient } from "./types.js";
import {
  extractKnowledge,
  type PlatformKnowledgeCard,
  type TrainerChatMessage,
  type TrainerConversation,
} from "../knowledge/index.js";

export interface TrainerTurnResult {
  conversation: TrainerConversation;
  assistantMessage: TrainerChatMessage;
  proposedCards: PlatformKnowledgeCard[];
  rejected?: { message: string; code: string };
}

export async function trainerTurn(input: {
  conversation: TrainerConversation;
  userText: string;
  taughtBy: string;
  client?: CompletionClient;
  /** 调用方负责 persist；这里只返回新卡 */
  saveCards: (cards: PlatformKnowledgeCard[]) => Promise<void>;
}): Promise<TrainerTurnResult> {
  const at = new Date().toISOString();
  const userMsg: TrainerChatMessage = {
    id: randomUUID(),
    role: "user",
    content: input.userText,
    at,
  };

  const extracted = await extractKnowledge({
    text: input.userText,
    trainerConversationId: input.conversation.id,
    taughtBy: input.taughtBy,
    client: input.client,
  });

  if (extracted.cards.length) {
    await input.saveCards(extracted.cards);
  }

  const assistantMsg: TrainerChatMessage = {
    id: randomUUID(),
    role: "assistant",
    content: extracted.assistantSummary,
    at: new Date().toISOString(),
    proposedCardIds: extracted.cards.map((c) => c.id),
  };

  const conversation: TrainerConversation = {
    ...input.conversation,
    messages: [...input.conversation.messages, userMsg, assistantMsg],
    cardIds: [
      ...input.conversation.cardIds,
      ...extracted.cards.map((c) => c.id),
    ],
    updatedAt: assistantMsg.at,
  };

  return {
    conversation,
    assistantMessage: assistantMsg,
    proposedCards: extracted.cards,
    ...(extracted.rejected ? { rejected: extracted.rejected } : {}),
  };
}

export function newTrainerConversation(createdBy: string): TrainerConversation {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    messages: [],
    cardIds: [],
    createdAt: now,
    updatedAt: now,
    createdBy,
  };
}
