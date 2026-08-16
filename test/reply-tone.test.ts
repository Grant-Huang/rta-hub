/**
 * 回复语气润色（agents/reply-tone.ts）——只改措辞不改事实，锚点丢了就原样退回。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { polishReplyTone } from "../src/agents/reply-tone.js";
import type { CompletionClient } from "../src/agents/types.js";

const ORIGINAL = 'Q1: Confirm wall "North" length (read ~144")? Q2: Any windows? Or say "no windows".';

function stubClient(reply: (text: string) => string): CompletionClient {
  return {
    async complete({ messages }) {
      return reply(messages[0]?.content ?? "");
    },
  };
}

test("没配 client：原样返回，不发起任何调用", async () => {
  const out = await polishReplyTone(undefined, ORIGINAL, "en");
  assert.equal(out, ORIGINAL);
});

test("空文本：原样返回", async () => {
  const client = stubClient(() => "should never be called");
  const out = await polishReplyTone(client, "   ", "en");
  assert.equal(out, "   ");
});

test("润色结果保住了所有锚点：采用润色后的文本", async () => {
  const client = stubClient(() =>
    'Thanks so much! Q1: Could you confirm the "North" wall length (read ~144")? '
      + 'Q2: Any windows on these walls? Or say "no windows" and we\'ll move on.');
  const out = await polishReplyTone(client, ORIGINAL, "en");
  assert.notEqual(out, ORIGINAL, "应该采用了润色后的文本");
  assert.match(out, /Q1:/);
  assert.match(out, /Q2:/);
  assert.match(out, /"North"/);
  assert.match(out, /144"/);
  assert.match(out, /"no windows"/);
});

test("润色结果弄丢了 Q# 编号：整段作废，原样退回", async () => {
  const client = stubClient(() =>
    'Thanks! Please confirm the "North" wall is about 144" long, and let us know about windows — or say "no windows".');
  const out = await polishReplyTone(client, ORIGINAL, "en");
  assert.equal(out, ORIGINAL);
});

test("润色结果篡改了引号示例短语：整段作废，原样退回", async () => {
  const client = stubClient(() =>
    'Q1: Confirm wall "North" length (read ~144")? Q2: Any windows? Or say "nope, no windows here".');
  const out = await polishReplyTone(client, ORIGINAL, "en");
  assert.equal(out, ORIGINAL, "改写了示例短语——客户照抄改写后的话就可能踩不中正则");
});

test("润色结果丢了数字：整段作废，原样退回", async () => {
  const client = stubClient(() =>
    'Q1: Confirm wall "North" length? Q2: Any windows? Or say "no windows".');
  const out = await polishReplyTone(client, ORIGINAL, "en");
  assert.equal(out, ORIGINAL, "丢了墙长数字 144\"");
});

test("模型调用失败：原样退回，不抛错", async () => {
  const client: CompletionClient = {
    async complete() {
      throw new Error("timeout");
    },
  };
  const out = await polishReplyTone(client, ORIGINAL, "en");
  assert.equal(out, ORIGINAL);
});

test("模型返回空字符串：原样退回", async () => {
  const client = stubClient(() => "   ");
  const out = await polishReplyTone(client, ORIGINAL, "en");
  assert.equal(out, ORIGINAL);
});

test("OCR 排障标记 [g:...] 也是锚点——润色丢了同样作废", async () => {
  const withTag = 'Here\'s what I read from your floor plan (1 wall): North ~144". [g:ocr+vl]';
  const client = stubClient(() => "Here's what I read from your floor plan: North is about 144 inches.");
  const out = await polishReplyTone(client, withTag, "en");
  assert.equal(out, withTag, "丢了 [g:ocr+vl] 排障标记");
});

test("中文：润色结果保住锚点就采用", async () => {
  const zhOriginal = 'Q1: 请确认「北墙」墙长（读到约 144"）？没有窗可以说「没有窗」。';
  const client = stubClient(() => '好的呀～Q1: 麻烦确认一下「北墙」的墙长（读到约 144"）好吗？没有窗的话说一声「没有窗」就行。');
  const out = await polishReplyTone(client, zhOriginal, "zh");
  assert.notEqual(out, zhOriginal);
  assert.match(out, /Q1:/);
  assert.match(out, /「北墙」/);
  assert.match(out, /144"/);
  assert.match(out, /「没有窗」/);
});
