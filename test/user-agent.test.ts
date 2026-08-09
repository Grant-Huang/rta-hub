/**
 * FR-20：用户 agent 信息隔离与确定性答法。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deterministicReply, factsFromScenario, personaForCaseIndex, userAgentTurn,
} from "../scripts/user-agent.mts";

const mission = {
  brief: "Explore kitchen cabinets under assistant guidance.",
  softGoals: ["Follow assistant questions."],
};

test("开场不倾倒预算/省份等全量事实", () => {
  const { text } = deterministicReply({
    client: undefined,
    persona: "beginner",
    mission,
    facts: {
      intent: "想换橱柜",
      style: "Modern",
      budget: "Budget CAD $10–20k",
      province: "Ontario ON",
    },
    assistantHistory: [],
    opening: true,
    language: "zh",
  });
  assert.match(text, /厨房|柜/);
  assert.doesNotMatch(text, /Ontario|CAD \$10/);
});

test("被问风格时才答风格；不问预算就不报预算", () => {
  const styleAsk = deterministicReply({
    client: undefined,
    persona: "familiar",
    mission,
    facts: { style: "Nordic", budget: "Budget under CAD $10k" },
    assistantHistory: ["What's your preferred kitchen style?"],
  });
  assert.match(styleAsk.text, /Nordic/);
  assert.doesNotMatch(styleAsk.text, /Budget under/);

  const budgetAsk = deterministicReply({
    client: undefined,
    persona: "familiar",
    mission,
    facts: { style: "Nordic", budget: "Budget under CAD $10k" },
    assistantHistory: ["What's your budget range?"],
  });
  assert.match(budgetAsk.text, /Budget under/);
});

test("问 L 形两腿长度+层高时答尺寸，不答 Modern", () => {
  const r = deterministicReply({
    client: undefined,
    persona: "familiar",
    mission,
    facts: {
      style: "Modern",
      kitchenTalk: "L-shape, long leg ~12 ft, short leg ~8 ft",
      walls: [
        { label: "long", length: 144 },
        { label: "short", length: 96 },
      ],
      ceilingHeight: 96,
    },
    assistantHistory: [
      "Since your layout is an L-shape, I just need the length of each leg and your ceiling height.",
    ],
  });
  assert.match(r.text, /12 ft|144|L-shape|short|long/i);
  assert.match(r.text, /96|ceiling|层高/i);
  assert.doesNotMatch(r.text, /^Modern$/);
});

test("识图失败要求手输时，familiar 打出可解析的墙长与层高", () => {
  const r = deterministicReply({
    client: undefined,
    persona: "familiar",
    mission,
    facts: {
      walls: [
        { label: "North", length: 132 },
        { label: "East", length: 108 },
      ],
      ceilingHeight: 96,
      style: "Modern shaker",
    },
    assistantHistory: [
      'I received your floor plan but couldn\'t read wall segments yet. Got file metadata but no image content. '
        + 'Answer in text only — send wall lengths and ceiling (e.g. North 84", East 108", ceiling 96").',
    ],
  });
  assert.match(r.text, /North\s*132/i);
  assert.match(r.text, /East\s*108/i);
  assert.match(r.text, /ceiling\s*96/i);
  assert.doesNotMatch(r.text, /Modern/);
});

test("人设轮转：beginner / familiar / trade_pro", () => {
  assert.equal(personaForCaseIndex(0), "beginner");
  assert.equal(personaForCaseIndex(1), "familiar");
  assert.equal(personaForCaseIndex(2), "trade_pro");
  assert.equal(personaForCaseIndex(3), "beginner");
});

test("邀约出图时 deterministic 带 consent_design", () => {
  const r = deterministicReply({
    client: undefined,
    persona: "familiar",
    mission,
    facts: {},
    assistantHistory: ["Shall I generate a design drawing?"],
  });
  assert.equal(r.uiAction, "consent_design");
});

test("factsFromScenario 不把系统检查表写进 facts", () => {
  const f = factsFromScenario({
    turns: ["想重做厨房"],
    walls: [{ label: "North", length: 120 }],
    ceilingHeight: 96,
    prefs: { budgetBand: "standard" },
    shape: "L-shape",
  });
  assert.ok(f.intent);
  assert.ok(f.budget);
  const blob = JSON.stringify(f);
  assert.doesNotMatch(blob, /readyToAskDesign|missingFields|FR-15/);
});

test("LLM 路径传入完整对话且角色翻转（客户→assistant，平台→user）", async () => {
  let seen: { role: string; content: string }[] | undefined;
  const client = {
    async complete(input: {
      messages: { role: "user" | "assistant"; content: string }[];
    }) {
      seen = input.messages;
      return "Long leg about 12 ft, short about 8 ft, ceiling 8 ft\nACTION:none";
    },
  };
  const r = await userAgentTurn({
    client: client as never,
    persona: "familiar",
    mission,
    facts: {
      style: "Modern",
      walls: [{ label: "long", length: 144 }, { label: "short", length: 96 }],
      ceilingHeight: 96,
    },
    conversationHistory: [
      { role: "user", content: "One wall ~12 ft" },
      { role: "assistant", content: "Got the 12 ft wall — what about the other walls and ceiling?" },
      { role: "user", content: "L-shape" },
      {
        role: "assistant",
        content: "I just need the length of each leg of the L, plus your ceiling height.",
      },
    ],
  });
  assert.equal(r.source, "llm");
  assert.match(r.text, /12 ft|8 ft|ceiling/i);
  assert.ok(seen);
  assert.equal(seen![0]!.role, "assistant");
  assert.match(seen![0]!.content, /One wall/);
  assert.equal(seen![1]!.role, "user");
  assert.match(seen![1]!.content, /Got the 12 ft/);
  assert.equal(seen![2]!.role, "assistant");
  assert.equal(seen![2]!.content, "L-shape");
  assert.equal(seen!.at(-1)!.role, "user");
  assert.match(seen!.at(-1)!.content, /length of each leg/);
});
