/**
 * 回归：助手自己说的话（引导示例 / Space-check 警告文案）混进对话历史后，
 * 被几何/特征解析器当成"客户刚才说的话"重新解析，进而：
 *   - 无中生有地在墙上加出一处不存在的门洞（`parseDoorFromChat` 命中警告文案
 *     里的 "doors"/"门洞" 一词）；
 *   - 或把客户已经报对的墙长/层高覆盖回引导文案里的示例数字。
 *
 * 根因是 `src/server.ts` 里 `historyBlob`/`combined` 会把最近的助手消息也拼进去
 * 喂给 `applyChatSiteAnswers`。#26 当时的修法是把**固定模板**里容易被误认成
 * 真实数据的具体数字/关键词去掉——对写死的 Space-check 警告文案有效，但治不了
 * LLM 在自由文本回复里现场编的举例（比如"比如：主墙15'，左墙6'…"，没有一个
 * 固定字符串可删）。所以后来又加了一层：`applyChatSiteAnswers` /
 * `applyChatApplianceAnswers`（真正写入 FloorPlan 的两条正则路径）现在只看
 * `role === "user"` 的历史，助手的话——不管是固定模板还是模型现场生成的——
 * 都不会再进这两个函数的输入。`needShell`（建户型壳）等只读路径不受影响，
 * 仍然按原样看全量历史（那正是"要回填助手复述里的确认"这句注释想要的）。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.SMTP_HOST = "";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";
process.env.ADMIN_TOKEN = "test-admin-token";

let app: { fetch: (req: Request) => Response | Promise<Response> };
let getAppContext: () => {
  repos: {
    conversations: {
      byId: (id: string) => { messages: { role: string; content: string; at: string }[] } | undefined;
      update: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
    };
  };
};
const base = "http://localhost";
const CONSUMER = "ca_demo_consumer";

before(async () => {
  const mod = await import("../src/server.js");
  app = await mod.createApp({ ephemeral: true, llm: undefined });
  getAppContext = mod.getAppContext;
});

function req(pathname: string, init: RequestInit & { accountId?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.accountId) headers.set("x-account-id", init.accountId);
  return app.fetch(new Request(base + pathname, { ...init, headers }));
}

async function json<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

interface WallRun {
  id: string; label: string; length: number;
  features: { kind: string; offset: number; width: number }[];
}
interface FloorPlan {
  id: string;
  parsedGeometry: { wallRuns: WallRun[]; ceilingHeight?: number };
}

test("Space-check 警告文案与引导示例进历史后，重发同一句正确墙长不应污染几何数据", async () => {
  const created = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await json<{ conversation: { id: string } }>(created);
  const convId = conversation.id;

  // 1) 上传户型（无图字节 → 走"没有视觉模型"降级，零墙段，触发引导示例文案）
  await req(`/api/conversations/${convId}/floorplan`, {
    method: "POST", accountId: CONSUMER,
    body: JSON.stringify({ fileName: "kitchen.png", mimeType: "image/png", sizeBytes: 12345 }),
  });

  // 2) 客户手输墙长 + 层高
  const wallMsg = 'North 84", ceiling 96"';
  await req(`/api/conversations/${convId}/messages`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ text: wallMsg }),
  });

  // 3) 报一组明显放不下的家电，触发真实的 ⚠ Space check 警告
  //    （警告文案会被写进 conv.messages，进入下一轮的 historyBlob）
  const fitMsg = 'Fridge 48", range 48"';
  const fitReply = await req(`/api/conversations/${convId}/messages`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ text: fitMsg }),
  });
  const fitBody = await json<{ replies?: { content: string }[]; floorPlanId?: string }>(fitReply);
  const fitText = (fitBody.replies ?? []).map((r) => r.content).join("\n");
  assert.match(fitText, /Space check|空间不够/, "本用例前提：家电应当放不下并触发空间检查警告");
  // 回归的关键前提：警告文案不能再包含会被 parseDoorFromChat 命中的 "door"/"门洞" 等词
  assert.doesNotMatch(fitText, /\bdoors?\b/i, "Space-check 警告不应再含 'door(s)' 一词（会被误认成客户在报门洞）");
  assert.doesNotMatch(fitText, /门洞|门口|开门/, "Space-check 警告不应再含门洞相关关键词");

  const planId = fitBody.floorPlanId;
  assert.ok(planId, "触发空间检查前应已建好户型壳");

  // 4) 客户重发**同一句**正确的墙长/层高（真实场景里的常见反应：以为没被听懂）
  await req(`/api/conversations/${convId}/messages`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ text: wallMsg }),
  });

  const finalPlanRes = await req(`/api/floorplans/${planId}`, { accountId: CONSUMER });
  const { floorPlan } = await json<{ floorPlan: FloorPlan }>(finalPlanRes);
  const north = floorPlan.parsedGeometry.wallRuns.find((r) => r.label === "North")!;

  assert.ok(north, "North 墙段应当存在");
  assert.equal(north.length, 84, "重发同一句正确墙长后，North 长度不应被引导示例里的占位数字覆盖");
  assert.equal(floorPlan.parsedGeometry.ceilingHeight, 96, "层高不应被引导示例覆盖");
  assert.equal(
    north.features.filter((f) => f.kind === "door").length, 0,
    "不应凭空出现一处门洞——这正是此前死循环+数据损坏的根因",
  );
});

test("助手自由文本里现场举的例子（非固定模板）混进历史后，不能抢在客户真实回答之前把墙长\"确认\"掉", async () => {
  const created = await req("/api/conversations", { method: "POST", accountId: CONSUMER });
  const { conversation } = await json<{ conversation: { id: string } }>(created);
  const convId = conversation.id;

  // 先让客户报一段墙，建好户型壳
  await req(`/api/conversations/${convId}/messages`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ text: 'Left wall 72"' }),
  });

  // 模拟助手在自由文本回复里现场举了个例子——这类文案是模型现场生成的，不是
  // 写死的模板字符串，没法靠"删关键词"防住（#26 的修法对这种情况无效）。
  // 测试环境没配模型，没法真的让它说出来，这里直接往会话历史里插一条
  // assistant 消息模拟"它已经说过"这个状态。
  const ctx = getAppContext();
  const conv = ctx.repos.conversations.byId(convId)!;
  await ctx.repos.conversations.update(convId, {
    messages: [...conv.messages, {
      role: "assistant",
      content: "比如你可以说 Right wall 6' 这样报。",
      at: new Date().toISOString(),
    }],
  });

  // 客户接着报的是真实的、跟助手举例不同的右墙长度——不该被助手刚才随口
  // 举的例子"抢先确认"，导致客户的真实数字被当成一次非法修改而拦下。
  const reply = await req(`/api/conversations/${convId}/messages`, {
    method: "POST", accountId: CONSUMER, body: JSON.stringify({ text: 'Right wall 96"' }),
  });
  const body = await json<{ floorPlanId?: string }>(reply);
  const planId = body.floorPlanId;
  assert.ok(planId, "户型壳应当已存在");

  const planRes = await req(`/api/floorplans/${planId}`, { accountId: CONSUMER });
  const { floorPlan } = await json<{ floorPlan: FloorPlan }>(planRes);
  const right = floorPlan.parsedGeometry.wallRuns.find((r) => r.label === "Right");

  assert.ok(right, "Right 墙段应当存在");
  assert.equal(
    right!.length, 96,
    "客户真实说的 96 英寸不应被助手举例里的 72 英寸抢先「确认」并挡住",
  );
});
