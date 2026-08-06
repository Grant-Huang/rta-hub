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

export function createLlmClient(): CompletionClient | undefined {
  if (!process.env.OPENAI_API_KEY) return undefined;

  const llm = new LlmService({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    runtimeConfig: loadConfig(),
  });

  /** 部分兼容端点不支持独立 system 角色，需要折叠进首条 user 消息。 */
  const fold = (system: string, messages: { role: "user" | "assistant"; content: string }[]) =>
    llm.compatMode
      ? { messages: [{ role: "user" as const, content: `${system}\n\n---\n${renderHistory(messages)}` }] }
      : { system, messages: messages.length ? messages : [{ role: "user" as const, content: "（开始）" }] };

  return {
    async complete({ system, messages, temperature }) {
      const { text } = await generateText({
        model: llm.model("writer"),
        ...fold(system, messages),
        temperature: temperature ?? 0.3,
      });
      return text;
    },

    async completeJson<T>({ system, messages, schemaHint, temperature }: {
      system: string;
      messages: { role: "user" | "assistant"; content: string }[];
      schemaHint: string;
      temperature?: number;
    }): Promise<T | undefined> {
      // 用宽松 schema 接住模型输出，真正的字段收口交给 stripPriceFields 白名单，
      // 避免因模型多塞一个字段就整体失败。
      const Loose = z.object({
        selections: z.array(z.record(z.string(), z.unknown())).optional(),
        doorStyleId: z.string().optional(),
        notes: z.string().optional(),
      });
      try {
        const { output } = await generateText({
          model: llm.model("writer"),
          ...fold(`${system}\n\n请严格按以下 JSON 结构输出：\n${schemaHint}`, messages),
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
