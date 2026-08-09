/**
 * Agent 抽象 —— FR-1、REQUIREMENTS 3.1。
 *
 * 关键设计约束：
 *   1. **一套引擎按 companyId 参数化**，不是每家公司一个进程（§3.4）。
 *   2. 公司 Agent 的知识边界 = 该公司 published 规格 + 当前项目上下文；
 *      回答不了就是回答不了，不编、不借用别家信息。
 *   3. **Agent 不产出价格。** 它只输出「选择」，价格由 PricingEngine 算（FR-8 第 1 条）。
 */
import type { CompanyEngagementHandoff, ModuleSelection } from "../domain/types.js";
import type { CallSite } from "./model-tiers.js";

/**
 * 对话完成接口——把具体 LLM 客户端隔离在外，便于测试替身。
 *
 * `callSite` 决定用哪一层模型（轻量/主力/视觉，见 model-tiers.ts）。
 * 它是可选的：不传就走默认模型，老的调用方不用改。
 */
export interface CompletionClient {
  complete(input: {
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
    temperature?: number;
    callSite?: CallSite;
  }): Promise<string>;

  /** 结构化输出。返回 undefined 表示模型未能产出合法结构。 */
  completeJson?<T>(input: {
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
    schemaHint: string;
    temperature?: number;
    callSite?: CallSite;
  }): Promise<T | undefined>;
}

export interface AgentContext {
  conversationId: string;
  /** 已收集的需求摘要，逐轮累积。 */
  requirements: string;
  history: { role: "user" | "assistant"; content: string }[];
  /** FR-23 子轨：交接包（含 confirmedFacts / 厂专用选型）；公司 Agent 必读。 */
  handoff?: CompanyEngagementHandoff;
  /**
   * 当前会话户型几何摘要（墙长/层高）。
   * 厂商谈转角柜/懒人转盘时必须结合实际墙长，不能空谈型号。
   */
  geometryNote?: string;
}

export interface AgentReply {
  content: string;
  /** 更新后的需求摘要（总控助手才会产出）。 */
  requirements?: string;
  /** 该回复来自哪家公司的 Agent；总控助手为 undefined。 */
  companyId?: string;
  /** 模型是否因为超出知识边界而拒答——用于监控 Agent 是否在编造。 */
  refused?: boolean;
}

/** 设计意图 —— Agent 允许产出的唯一「结构化」东西，绝不含价格。 */
export interface DesignIntent {
  selections: ModuleSelection[];
  doorStyleId?: string;
  notes: string;
}
