/**
 * 快捷回答 —— 「点一下就答完」这件事必须真的成立。
 *
 * 客户的原话：「类似『您偏好的厨房风格是什么？』这样的问题，会话框中要么显示
 * 按钮让客户选择，要么提示用户只用输入"现代简约"（告诉用户怎么快速回答）。」
 *
 * 这一组测试盯的是**最容易出的那个错**：给了按钮，客户点了，系统下一轮又问
 * 同一个问题——因为按钮上的字 `missingFields` 的关键词表认不出来。
 * 那比不给按钮更糟：客户会以为系统坏了。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { quickRepliesFor, ASK_STYLE_RULES } from "../src/agents/quick-replies.js";
import { missingFields } from "../src/agents/orchestrator.js";

const ALL_FIELDS = missingFields("");

test("五个缺失字段每一个都有快捷回答，没有漏网的", () => {
  const covered = quickRepliesFor(ALL_FIELDS, ALL_FIELDS.length).map((q) => q.field);
  assert.deepEqual([...covered].sort(), [...ALL_FIELDS].sort());
});

test("每个选项点下去都能真的把那个字段答掉", () => {
  for (const q of quickRepliesFor(ALL_FIELDS, ALL_FIELDS.length)) {
    for (const option of q.options) {
      const stillMissing = missingFields(option);
      assert.equal(stillMissing.includes(q.field), false,
        `点了「${option}」之后系统还认为缺「${q.field}」——下一轮会原样再问一遍`);
    }
  }
});

test("每组快捷回答都带一句「怎么快速回答」的提示", () => {
  for (const q of quickRepliesFor(ALL_FIELDS, ALL_FIELDS.length)) {
    assert.ok(q.hint.length > 0, `${q.field} 没有提示语`);
    assert.ok(q.options.length >= 2, `${q.field} 只有 ${q.options.length} 个选项，不成其为选择`);
  }
});

test("给的组数与助手本轮问的问题数对齐", () => {
  // 问了两件事却摆出五组按钮，客户不知道该先点哪个
  assert.equal(quickRepliesFor(ALL_FIELDS, 2).length, 2);
  assert.equal(quickRepliesFor(ALL_FIELDS, 1).length, 1);
  assert.equal(quickRepliesFor(ALL_FIELDS, 0).length, 0);
});

test("已经答齐的对话不再给按钮", () => {
  const answered = "厨房一面墙 12 尺，L 型，现代简约风格，预算 1-2 万加币，安大略省 ON";
  assert.deepEqual(quickRepliesFor(missingFields(answered)), []);
});

test("提问纪律进了 system prompt——光有按钮治不住模型写长问题", () => {
  assert.match(ASK_STYLE_RULES, /几个字答完/);
  assert.match(ASK_STYLE_RULES, /举例最多给三个/);
});
