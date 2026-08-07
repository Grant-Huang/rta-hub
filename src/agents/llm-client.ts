/**
 * `CompletionClient` 的实际实现 —— 基于 `@meso.ai/let-it-flow` 的 LlmService。
 *
 * 与领域逻辑隔离在接口后面，这样：
 *   - 测试用替身，不需要 API key 也能跑；
 *   - 没配 API key 时整条链路降级为确定性问答，而不是崩掉。
 */
import { generateText, Output } from "ai";
import { z } from "zod";
import { LlmService, loadConfig } from "@meso.ai/let-it-flow/runtime";
import type { CompletionClient } from "./types.js";
import {
  modelFor, resolveModelTiers, type CallSite, type ModelTierConfig,
} from "./model-tiers.js";
import { recordUsage } from "./token-meter.js";

/** `LanguageModel` 可能是模型实例，也可能就是一个 id 字符串——两种都要认。 */
function modelIdOf(model: unknown): string {
  if (typeof model === "string") return model;
  const id = (model as { modelId?: unknown } | null)?.modelId;
  return typeof id === "string" ? id : "unknown";
}

export function createLlmClient(
  tiers: ModelTierConfig = resolveModelTiers(),
): CompletionClient | undefined {
  if (!process.env.OPENAI_API_KEY) return undefined;

  const llm = new LlmService({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    runtimeConfig: loadConfig(),
  });

  /**
   * 按调用点取模型。
   *
   * 分层配置没给出模型 id 时回退到 let-it-flow 的 `writer` 角色——它自己的
   * 配置体系仍然管用，我们只是在它之上加了一层按调用点的映射
   * （见 model-tiers.ts 里为什么不用它的 CallSite 枚举）。
   */
  const modelOf = (site: CallSite | undefined) => {
    const id = site ? modelFor(tiers, site) : undefined;
    return id ? llm.modelById(id) : llm.model("writer");
  };

  /** 部分兼容端点不支持独立 system 角色，需要折叠进首条 user 消息。 */
  const fold = (system: string, messages: { role: "user" | "assistant"; content: string }[]) =>
    llm.compatMode
      ? { messages: [{ role: "user" as const, content: `${system}\n\n---\n${renderHistory(messages)}` }] }
      : { system, messages: messages.length ? messages : [{ role: "user" as const, content: "（开始）" }] };

  return {
    async complete({ system, messages, temperature, callSite }) {
      const model = modelOf(callSite);
      const result = await generateText({
        model,
        ...fold(system, messages),
        temperature: temperature ?? 0.3,
      });
      recordUsage({
        ...(callSite ? { callSite } : {}),
        model: modelIdOf(model),
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
      });
      return result.text;
    },

    async completeJson<T>({ system, messages, schemaHint, temperature, callSite }: {
      system: string;
      messages: { role: "user" | "assistant"; content: string }[];
      schemaHint: string;
      temperature?: number;
      callSite?: CallSite;
    }): Promise<T | undefined> {
      // 用宽松 schema 接住模型输出，真正的字段收口交给 stripPriceFields 白名单，
      // 避免因模型多塞一个字段就整体失败。
      const Loose = z.object({
        selections: z.array(z.record(z.string(), z.unknown())).optional(),
        doorStyleId: z.string().optional(),
        notes: z.string().optional(),
      });
      try {
        const model = modelOf(callSite);
        const result = await generateText({
          model,
          ...fold(`${system}\n\n请严格按以下 JSON 结构输出：\n${schemaHint}`, messages),
          output: Output.object({ schema: Loose }),
          temperature: temperature ?? 0.2,
        });
        recordUsage({
          ...(callSite ? { callSite } : {}),
          model: modelIdOf(model),
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
        });
        return result.output as T | undefined;
      } catch {
        return undefined;
      }
    },
  };
}

function renderHistory(messages: { role: "user" | "assistant"; content: string }[]): string {
  return messages.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`).join("\n");
}
