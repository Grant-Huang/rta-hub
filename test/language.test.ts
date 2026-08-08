/**
 * 客户语言偏好 —— 默认英文；明确要求才切中文；图纸不受影响。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LANGUAGE, detectLanguageSwitch, languageRuleForLlm, languageSwitchAck,
  resolveLanguage,
} from "../src/i18n/language.js";
import { rtaIntro, renderRtaComparison } from "../src/quote/rta-disclosure.js";
import { quickRepliesFor } from "../src/agents/quick-replies.js";
import { missingFields, orchestratorReply, optionsFor } from "../src/agents/orchestrator.js";
import { annotationFor } from "../src/render/kernel/annotate.js";
import { PALETTE } from "../src/render/kernel/palette.js";
import { tradeoffQuestion } from "../src/preferences/questions.js";

test("默认语言是英文", () => {
  assert.equal(DEFAULT_LANGUAGE, "en");
  assert.equal(resolveLanguage(undefined), "en");
  assert.equal(resolveLanguage({}), "en");
});

test("只有明确要求才切换语言，夹几个中文字不算", () => {
  assert.equal(detectLanguageSwitch("用中文聊"), "zh");
  assert.equal(detectLanguageSwitch("please reply in Chinese"), "zh");
  assert.equal(detectLanguageSwitch("can you talk in english?"), "en");
  assert.equal(detectLanguageSwitch("厨房大概 12 尺，L 型"), undefined);
  assert.equal(detectLanguageSwitch("hello, budget around 15k"), undefined);
});

test("开场白与快捷回答默认英文", () => {
  assert.match(rtaIntro("en"), /ready-to-assemble/i);
  assert.match(rtaIntro("en"), /not fully custom/i);
  assert.doesNotMatch(rtaIntro("en"), /不是全定制/);

  const chips = quickRepliesFor(missingFields(""), 5, "en");
  assert.ok(chips.some((q) => q.options.includes("L-shape")));
  assert.ok(chips.some((q) => q.options.includes("One wall ~12 ft")));
});

test("英文快捷回答点下去能消掉对应缺失字段", () => {
  for (const q of quickRepliesFor(missingFields(""), 5, "en")) {
    for (const option of q.options) {
      assert.equal(missingFields(option).includes(q.field), false,
        `English chip 「${option}」 did not clear 「${q.field}」`);
    }
  }
});

test("中文快捷回答仍然可用", () => {
  for (const q of quickRepliesFor(missingFields(""), 5, "zh")) {
    for (const option of q.options) {
      assert.equal(missingFields(option).includes(q.field), false,
        `Chinese chip 「${option}」 did not clear 「${q.field}」`);
    }
  }
});

test("无模型时兜底问答跟语言走", async () => {
  const en = await orchestratorReply(undefined, {
    conversationId: "c", requirements: "", history: [],
  }, "hi", { ...optionsFor("consumer"), language: "en" });
  assert.match(en.content, /Got it|Still need|kitchen size|layout/i);

  const zh = await orchestratorReply(undefined, {
    conversationId: "c", requirements: "", history: [],
  }, "你好", { ...optionsFor("consumer"), language: "zh" });
  assert.match(zh.content, /了解了|还需要|厨房尺寸|布局/);
});

test("切换语言确认句与 LLM 规则匹配", () => {
  assert.match(languageSwitchAck("zh"), /中文/);
  assert.match(languageSwitchAck("en"), /English/);
  assert.match(languageRuleForLlm("zh"), /中文/);
  assert.match(languageRuleForLlm("en"), /English/);
});

test("RTA 详细对照可按语言输出", () => {
  assert.match(renderRtaComparison("en"), /Custom:/);
  assert.match(renderRtaComparison("zh"), /定制：/);
});

test("偏好取舍题默认英文", () => {
  const q = tradeoffQuestion();
  assert.match(q.prompt, /trade-offs/i);
  assert.ok(q.options.some((o) => /Total price/i.test(o.label)));
});

test("图纸图例与标注固定英文", () => {
  assert.equal(PALETTE.cabinet.legend, "Cabinet");
  assert.equal(PALETTE.sinkBase.legend, "Sink base");
  assert.equal(PALETTE.appliance.legend, "Appliance (owner-supplied)");

  const sink = annotationFor({
    kind: "cabinet", layer: "base", wallRunId: "w1",
    x: 0, width: 36, height: 34.5, depth: 24, label: "sink", moduleCode: "SB36",
  });
  assert.equal(sink?.primary, "Sink");

  const fridge = annotationFor({
    kind: "appliance", layer: "base", wallRunId: "w1",
    x: 0, width: 36, height: 34.5, depth: 24, applianceKind: "refrigerator",
    applianceSpec: {
      kind: "refrigerator", width: 33, clearanceEachSide: 1, provenance: "assumed",
    },
  });
  assert.equal(fridge?.primary, "Refrigerator");
  assert.match(fridge?.secondary ?? "", /assumed/);
});
