/**
 * 测试用户 LLM 客户端与生产端点隔离。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestLlmClient, stripOpenAiV1 } from "../src/agents/llm-client.js";
import { createVisionExtractorFromTestEnv } from "../src/floorplan/ollama-vision.js";

test("stripOpenAiV1 去掉兼容路径后缀", () => {
  assert.equal(stripOpenAiV1("http://localhost:11434/v1"), "http://localhost:11434");
  assert.equal(stripOpenAiV1("http://localhost:11434/v1/"), "http://localhost:11434");
  assert.equal(stripOpenAiV1("http://localhost:11434"), "http://localhost:11434");
});

test("未配任何 TEST 信号时 createTestLlmClient 为 undefined", () => {
  const client = createTestLlmClient({});
  assert.equal(client, undefined);
});

test("仅配 LLM_MODEL_TEST_CHAT 即可启用测试客户端（默认本机 Ollama）", () => {
  const client = createTestLlmClient({
    LLM_MODEL_TEST_CHAT: "qwen2.5:14b-instruct",
  });
  assert.ok(client);
  assert.equal(typeof client!.complete, "function");
});

test("测试视觉不读生产 OPENAI_BASE_URL_VISION", () => {
  const none = createVisionExtractorFromTestEnv({
    OPENAI_BASE_URL_VISION: "http://prod-vision:9999",
    LLM_MODEL_VISION: "prod-vl",
  });
  assert.equal(none, undefined);

  const test = createVisionExtractorFromTestEnv({
    LLM_MODEL_TEST_VISION: "qwen2.5vl:latest",
    OPENAI_BASE_URL_TEST_VISION: "http://localhost:11434",
  });
  assert.ok(test);
});
