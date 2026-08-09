/**
 * `CompletionClient` 的实际实现 —— 基于 `@meso.ai/let-it-flow` 的 LlmService。
 *
 * 与领域逻辑隔离在接口后面，这样：
 *   - 测试用替身，不需要 API key 也能跑；
 *   - 没配 API key 时整条链路降级为确定性问答，而不是崩掉。
 *
 * 支持多端点：
 *   - 生产文本：OPENAI_API_KEY + OPENAI_BASE_URL
 *   - 生产视觉：OPENAI_API_KEY_VISION + OPENAI_BASE_URL_VISION
 *   - 测试用户 / simulate：OPENAI_*_TEST + LLM_MODEL_TEST_*（默认本机 Ollama）
 */
import { generateText, Output } from "ai";
import { z } from "zod";
import { LlmService, loadConfig } from "@meso.ai/let-it-flow/runtime";
import type { CompletionClient } from "./types.js";
import {
  modelFor, resolveModelTiers, resolveTestModelTiers, type CallSite, type ModelTierConfig,
} from "./model-tiers.js";

/** 判断是否为视觉调用点 */
function isVisionCallSite(site: CallSite | undefined): boolean {
  return site === "floorPlanExtract";
}

/** 覆盖生产默认端点（用于测试用户客户端）。 */
export interface LlmEndpointConfig {
  apiKey?: string;
  baseURL?: string;
  visionApiKey?: string;
  visionBaseURL?: string;
}

export function createLlmClient(
  tiers: ModelTierConfig = resolveModelTiers(),
  endpoints: LlmEndpointConfig = {},
): CompletionClient | undefined {
  const apiKey = endpoints.apiKey ?? process.env.OPENAI_API_KEY;
  const baseURL = endpoints.baseURL ?? process.env.OPENAI_BASE_URL;
  const visionApiKey = endpoints.visionApiKey ?? process.env.OPENAI_API_KEY_VISION;
  const visionBaseURL = endpoints.visionBaseURL ?? process.env.OPENAI_BASE_URL_VISION;

  if (!apiKey && !visionApiKey && !visionBaseURL) return undefined;

  // 主模型服务（用于 chat 和 reasoning）
  const mainLlm = apiKey ? new LlmService({
    apiKey,
    baseURL: baseURL || undefined,
    runtimeConfig: loadConfig(),
  }) : undefined;

  // 视觉模型服务（用于 vision）- Ollama 本地不需要 key，只要有 baseURL 就启用
  const hasVisionConfig = Boolean(visionBaseURL?.trim());
  const visionLlm = hasVisionConfig ? new LlmService({
    apiKey: visionApiKey || "ollama",
    baseURL: visionBaseURL,
    runtimeConfig: loadConfig(),
  }) : undefined;

  if (!mainLlm && !visionLlm) return undefined;

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
    return visionLlm!.model("writer");
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

  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 60_000;

  return {
    async complete({ system, messages, temperature, callSite }) {
      const llm = llmOf(callSite)!;
      const { text } = await withTimeout(
        generateText({
          model: modelOf(callSite),
          ...fold(system, messages, llm),
          temperature: temperature ?? 0.3,
          abortSignal: AbortSignal.timeout(timeoutMs),
        }),
        timeoutMs,
        `LLM complete timed out after ${timeoutMs}ms`,
      );
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
        const { output } = await withTimeout(
          generateText({
            model: modelOf(callSite),
            ...fold(`${system}\n\n请严格按以下 JSON 结构输出：\n${schemaHint}`, messages, llm),
            output: Output.object({ schema: Loose }),
            temperature: temperature ?? 0.2,
            abortSignal: AbortSignal.timeout(timeoutMs),
          }),
          timeoutMs,
          `LLM completeJson timed out after ${timeoutMs}ms`,
        );
        return output as T | undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * 测试用户 agent / 场景生成专用客户端。
 *
 * 默认指向本机 Ollama（`OPENAI_BASE_URL_TEST`），模型读 `LLM_MODEL_TEST_*`。
 * **不读取**生产 `OPENAI_API_KEY` / `LLM_MODEL_CHAT` 等，避免 simulate 误烧生产额度。
 */
export function createTestLlmClient(
  env: NodeJS.ProcessEnv = process.env,
): CompletionClient | undefined {
  const tiers = resolveTestModelTiers(env);
  const baseURL = env.OPENAI_BASE_URL_TEST?.trim() || "http://localhost:11434/v1";
  const apiKey = env.OPENAI_API_KEY_TEST?.trim() || "ollama";
  const visionBaseURL = env.OPENAI_BASE_URL_TEST_VISION?.trim()
    || stripOpenAiV1(baseURL)
    || "http://localhost:11434/v1";
  const visionApiKey = env.OPENAI_API_KEY_TEST_VISION?.trim() || apiKey;

  // 未配任何 TEST 模型且未显式开测试端点 → 不启用（走确定性用户 agent）
  if (!tiers.anyConfigured && !env.OPENAI_BASE_URL_TEST?.trim() && !env.OPENAI_API_KEY_TEST?.trim()) {
    return undefined;
  }

  return createLlmClient(tiers, {
    apiKey,
    baseURL,
    visionApiKey,
    visionBaseURL,
  });
}

/** Ollama 原生视觉端点不要带 `/v1`；OpenAI 兼容文本端点常带 `/v1`。 */
export function stripOpenAiV1(url: string): string {
  return url.replace(/\/v1\/?$/, "");
}

/**
 * DesignCritic 专用客户端：只要 reasoning + vision（不负责客户闲聊）。
 * 默认 reasoning → DeepSeek（可复用生产 key）；vision → 本机 Qwen VL。
 * 不强制读取 LLM_MODEL_CHAT。
 */
export function createCriticLlmClient(
  env: NodeJS.ProcessEnv = process.env,
): CompletionClient | undefined {
  const apiKey = env.OPENAI_API_KEY_CRITIC?.trim() || env.OPENAI_API_KEY?.trim();
  const baseURL = env.OPENAI_BASE_URL_CRITIC?.trim() || env.OPENAI_BASE_URL?.trim();
  const reasoning = env.LLM_MODEL_CRITIC_REASONING?.trim()
    || env.LLM_MODEL_REASONING?.trim()
    || env.LLM_MODEL_CHAT?.trim()
    || "deepseek-v4-pro";
  const visionModel = env.LLM_MODEL_CRITIC_VISION?.trim()
    || env.LLM_MODEL_TEST_VISION?.trim()
    || "qwen2.5vl:latest";
  const visionBaseURL = env.OPENAI_BASE_URL_CRITIC_VISION?.trim()
    || env.OPENAI_BASE_URL_TEST_VISION?.trim()
    || "http://localhost:11434/v1";
  const visionApiKey = env.OPENAI_API_KEY_CRITIC_VISION?.trim() || "ollama";

  if (!apiKey && !env.OPENAI_BASE_URL_CRITIC_VISION?.trim()) {
    // 允许仅本地 vision + 无 reasoning（降级确定性 critique）
    if (!env.LLM_MODEL_CRITIC_REASONING?.trim() && !env.LLM_MODEL_CRITIC_VISION?.trim()) {
      return undefined;
    }
  }

  const tiers: ModelTierConfig = {
    chat: { effectiveModelId: reasoning, modelId: reasoning },
    reasoning: { effectiveModelId: reasoning, modelId: reasoning },
    vision: { effectiveModelId: visionModel, modelId: visionModel },
    anyConfigured: true,
  };

  return createLlmClient(tiers, {
    ...(apiKey ? { apiKey, baseURL: baseURL || undefined } : { apiKey: "ollama", baseURL: visionBaseURL }),
    visionApiKey,
    visionBaseURL,
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function renderHistory(messages: { role: "user" | "assistant"; content: string }[]): string {
  return messages.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`).join("\n");
}
