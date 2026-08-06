/**
 * 贸易账号的交互差异 —— FR-11、SCENARIOS 场景 F 第 4 点。
 *
 * 定案：**只在「问得多不多、解不解释术语」上有差异，不在能力上有差异。**
 * 建商懂行业术语，不需要新手引导；但报价、闸门、校验一律与消费者相同——
 * 让专业账号绕过闸门会直接破坏 FR-8。
 *
 * 拆成独立文件是因为它同时被对话编排（agents/orchestrator）和项目列表用到，
 * 而 orchestrator 不该为了拿一个 prompt 参数去依赖项目管理模块。
 */
import type { AccountType } from "../domain/types.js";

export interface TradeInteractionProfile {
  /** 每轮最多问几个字段。消费者 1-2 个，建商可以一次问全。 */
  maxQuestionsPerTurn: number;
  /** 是否解释行业术语。 */
  explainJargon: boolean;
  /** 是否跳过「确认需求摘要」这类确认步骤。 */
  skipConfirmationPrompts: boolean;
  /**
   * 是否展示贸易价与折扣明细。
   *
   * 注意：这是**呈现开关**，不是定价开关。真正决定按哪种账号定价的是
   * `effectiveAccountType`（verification.ts）——界面藏起来不等于价格没给出去。
   */
  showTradePricing: boolean;
}

export const CONSUMER_PROFILE: TradeInteractionProfile = {
  maxQuestionsPerTurn: 2,
  explainJargon: true,
  skipConfirmationPrompts: false,
  showTradePricing: false,
};

export const TRADE_PROFILE: TradeInteractionProfile = {
  maxQuestionsPerTurn: 5,
  explainJargon: false,
  skipConfirmationPrompts: true,
  showTradePricing: true,
};

export function interactionProfile(accountType: AccountType): TradeInteractionProfile {
  return accountType === "trade" ? TRADE_PROFILE : CONSUMER_PROFILE;
}
