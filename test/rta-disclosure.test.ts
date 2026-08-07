/**
 * 「这里卖的是 RTA」—— 必须**预先**说，而且三处措辞同源。
 *
 * 客户提的问题：「需要预先告知用户是 rta，必要时要解释与定制橱柜的区别，
 * 以免误会与投诉。」
 *
 * 最要紧的一条：**这道题不交给模型答**。答错的代价是客户按定制的预期下单、
 * 到货才发现是一箱板件，而那已经不是解释得清的阶段了。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RTA_INTRO, RTA_QUOTE_NOTE, RTA_DIFFERENCES, renderRtaComparison, asksAboutRta,
} from "../src/quote/rta-disclosure.js";
import { orchestratorReply } from "../src/agents/orchestrator.js";
import { interactionProfile } from "../src/trade/interaction.js";

const ctx = {
  conversationId: "c_test",
  requirements: "",
  history: [] as { role: "user" | "assistant"; content: string }[],
};
const opts = { profile: interactionProfile("consumer") };

test("开场那一段把三件事都说到：不是定制、需要组装、不含安装", () => {
  assert.match(RTA_INTRO, /RTA/);
  assert.match(RTA_INTRO, /不是全定制/);
  assert.match(RTA_INTRO, /组装/);
  assert.match(RTA_INTRO, /安装/);
});

test("报价单末尾也说一遍——只在开场说过一次不算说过", () => {
  // 报价单是客户**已经把方案做完之后**才看到的，也是他拿去跟定制报价比的那一份
  assert.match(RTA_QUOTE_NOTE, /RTA/);
  assert.match(RTA_QUOTE_NOTE, /组装/);
  assert.match(RTA_QUOTE_NOTE, /不含.*安装/);
  assert.match(RTA_QUOTE_NOTE, /定制/, "没提醒客户拿去与定制对比时要算上这一点");
});

test("差异表把最容易变成投诉的那几条都列了", () => {
  const aspects = RTA_DIFFERENCES.map((d) => d.aspect);
  for (const need of ["尺寸", "安装", "到货状态"]) {
    assert.ok(aspects.includes(need), `差异表里没有「${need}」——那正是事后最容易吵的一条`);
  }
  // 每一条都要两边都说，只说 RTA 那边等于没有对比
  for (const d of RTA_DIFFERENCES) {
    assert.ok(d.rta.length > 0 && d.custom.length > 0, `${d.aspect} 只写了一边`);
  }
});

test("差异说明既不贬低也不美化：说清便宜在哪，不说「质量差」", () => {
  const text = renderRtaComparison();
  assert.match(text, /省掉|设计费|组装工时/, "没说清便宜是因为省掉了什么");
  assert.match(text, /不是\*\*质量\*\*|差的是\*\*做法\*\*/,
    "没点明差的是做法不是质量——不点明，客户会以为 RTA 就是低质");
});

test("客户问「RTA 和定制有什么区别」时认得出来", () => {
  const yes = [
    "RTA 和定制有什么区别",
    "这个和全屋定制有啥不一样",
    "什么是 RTA",
    "需要自己组装吗？跟定制橱柜差在哪",
    "定制橱柜和这个厨房柜子有什么不同",
  ];
  for (const q of yes) assert.ok(asksAboutRta(q), `没认出这是在问 RTA：「${q}」`);

  const no = ["厨房一面墙 12 尺", "预算两万加币", "门板要白色的", "什么时候能发货"];
  for (const q of no) assert.equal(asksAboutRta(q), false, `误判成问 RTA：「${q}」`);
});

test("这道题**不走模型**——配了模型也一样给固定答案", async () => {
  // 模型答这道题的典型失手是把差异说轻（"主要是需要自己组装"），
  // 而恰恰是被说轻的那几条事后最容易变成投诉
  let called = false;
  const client = {
    complete: async () => { called = true; return "RTA 就是便宜一点的橱柜，其他都一样。"; },
  };
  const reply = await orchestratorReply(client, ctx, "RTA 和定制有什么区别？", opts);
  assert.equal(called, false, "把产品边界问题交给了模型");
  assert.match(reply.content, /尺寸/);
  assert.match(reply.content, /安装/);
});

test("没配模型时同样答得出来——不退化成「还需要：厨房尺寸…」", async () => {
  const reply = await orchestratorReply(undefined, ctx, "什么是 RTA？", opts);
  assert.match(reply.content, /ready-to-assemble|待组装/);
  assert.doesNotMatch(reply.content, /还想确认|还需要/,
    "把客户的提问当成了「他还没答我的问题」");
});

test("普通需求陈述照走原路，没被这条分支截走", async () => {
  const reply = await orchestratorReply(undefined, ctx, "厨房是 L 型，一面墙 12 尺", opts);
  assert.doesNotMatch(reply.content, /ready-to-assemble/);
});
