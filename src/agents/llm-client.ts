/**
 * `CompletionClient` 的实际实现 —— 基于 `@meso.ai/let-it-flow` 的 LlmService。
 *
 * 与领域逻辑隔离在接口后面，这样：
 *   - 测试用替身，不需要 API key 也能跑；
 *   - 没配 API key 时整条链路降级为确定性问答，而不是崩掉。
 *
 * 支持多端点：
 *   - 文本模型（chat/reasoning）：使用 OPENAI_API_KEY + OPENAI_BASE_URL
 *   - 视觉模型（vision）：使用 OPENAI_API_KEY_VISION + OPENAI_BASE_URL_VISION
 */
import { generateText, Output } from "ai";
import { z } from "zod";
import { LlmService, loadConfig } from "@meso.ai/let-it-flow/runtime";
import type { CompletionClient } from "./types.js";
import {
  modelFor, resolveModelTiers, type CallSite, type ModelTierConfig,
} from "./model-tiers.js";

/** 判断是否为视觉调用点 */
function isVisionCallSite(site: CallSite | undefined): boolean {
  return site === "floorPlanExtract";
}

export function createLlmClient(
  tiers: ModelTierConfig = resolveModelTiers(),
): CompletionClient | undefined {
  if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY_VISION) return undefined;

  // 主模型服务（用于 chat 和 reasoning）
  const mainLlm = process.env.OPENAI_API_KEY ? new LlmService({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    runtimeConfig: loadConfig(),
  }) : undefined;

  // 视觉模型服务（用于 vision）- Ollama 本地不需要 key，只要有 baseURL 就启用
  const hasVisionConfig = process.env.OPENAI_BASE_URL_VISION;
  const visionLlm = hasVisionConfig ? new LlmService({
    apiKey: process.env.OPENAI_API_KEY_VISION || "ollama", // Ollama 本地可能不需要 key
    baseURL: process.env.OPENAI_BASE_URL_VISION,
    runtimeConfig: loadConfig(),
  }) : undefined;

  /**
   * 按调用点取模型和对应的 LLM 服务。
   */
  const modelOf = (site: CallSite | undefined) => {
    const id = site ? modelFor(tiers, site) : undefined;
    // 视觉层使用专门的 vision LLM 服务
    if (isVisionCallSite(site) && visionLlm) {
      return id ? visionLlm.modelById(id) : visionLlm.model("writer");
    }
    // 其他层使用主 LLM 服务
    if (mainLlm) {
      return id ? mainLlm.modelById(id) : mainLlm.model("writer");
    }
    // 兜底
    return visionLlm?.model("writer")!;
  };

  /** 获取对应的 LLM 服务（用于判断 compatMode） */
  const llmOf = (site: CallSite | undefined) => {
    if (isVisionCallSite(site) && visionLlm) return visionLlm;
    return mainLlm;
  };

  /** 部分兼容端点不支持独立 system 角色，需要折叠进首条 user 消息。 */
  const fold = (system: string, messages: { role: "user" | "assistant"; content: string }[], llm: LlmService | undefined) =>
    llm?.compatMode
      ? { messages: [{ role: "user" as const, content: `${system}\n\n---\n${renderHistory(messages)}` }] }
      : { system, messages: messages.length ? messages : [{ role: "user" as const, content: "（开始）" }] };

  return {
    async complete({ system, messages, temperature, callSite }) {
      const llm = llmOf(callSite)!;
      const { text } = await generateText({
        model: modelOf(callSite),
        ...fold(system, messages, llm),
        temperature: temperature ?? 0.3,
      });
      return text;
    },

    async completeJson<T>({ system, messages, schemaHint, temperature, callSite }: {
      system: string;
      messages: { role: "user" | "assistant"; content: string }[];
      schemaHint: string;
      temperature?: number;
      callSite?: CallSite;
    }): Promise<T | undefined> {
      const llm = llmOf(callSite)!;
      // 用宽松 schema 接住模型输出，真正的字段收口交给 stripPriceFields 白名单，
      // 避免因模型多塞一个字段就整体失败。
      const Loose = z.object({
        selections: z.array(z.record(z.string(), z.unknown())).optional(),
        doorStyleId: z.string().optional(),
        notes: z.string().optional(),
      });
      try {
        const { output } = await generateText({
          model: modelOf(callSite),
          ...fold(`${system}\n\n请严格按以下 JSON 结构输出：\n${schemaHint}`, messages, llm),
          output: Output.object({ schema: Loose }),
          temperature: temperature ?? 0.2,
        });
        return output as T | undefined;
      } catch {
        return undefined;
      }
    },
  };
}

function renderHistory(messages: { role: "user" | "assistant"; content: string }[]): string {
  return messages.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`).join("\n");
}
