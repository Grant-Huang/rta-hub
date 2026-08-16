/**
 * 场景一测试报告 Critical Bug 复现 + 回归锁定：
 *
 * 客户只点了 "L-shape"（或打字说 "L-shape"），系统套用模板预填墙长/层高/
 * 门窗——这些是模板假设，**不是**客户确认过的（FR-15.5，见 `applyFloorplanTemplate`
 * 与 `readiness.ts` 里每个字段都留的待确认项）。
 *
 * 但服务端喂给对话模型的 `confirmedBriefs`（`server.ts` 里 `intakeStatus.confirmedBriefs`，
 * 经 `orchestrator.ts` 的 `intakeStatusNote` 拼成系统提示词里的
 * "Already confirmed (do NOT re-ask): ..." 一段）之前把 `needs_confirm`
 * 状态的字段也当成了 "ok" 一并塞进去——模型看到提示词说这些"已确认勿再问"，
 * 于是在回复里把模板假设的墙长当事实复述给客户（"your North wall at 144"...""），
 * 还跳过了本该做的确认，直接问下一件事。
 *
 * 这份测试直接接管 LLM 客户端，抓取真正发给模型的系统提示词，验证模板刚
 * 套用、客户还没确认任何数字时，提示词的"已确认"清单里不能出现这些数字。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { CompletionClient } from "../src/agents/types.js";

process.env.SMTP_HOST = "";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";
process.env.ADMIN_TOKEN = "test-admin-token";
process.env.SENDER_NAME = "RTA Hub";
process.env.SMTP_FROM = "quotes@rta-hub.test";
process.env.SENDER_PHONE = "+1-800-555-0100";

let app: { fetch: (req: Request) => Response | Promise<Response> };
const capturedSystemPrompts: string[] = [];

const captureClient: CompletionClient = {
  async complete(input) {
    capturedSystemPrompts.push(input.system);
    // 固定回复，跟这个测试的断言无关——只关心发给模型的提示词内容。
    return "Got it, thanks!";
  },
};

before(async () => {
  const mod = await import("../src/server.js");
  app = await mod.createApp({ ephemeral: true, llm: captureClient });
});

const CONSUMER = "ca_demo_consumer";
const base = "http://localhost";

function req(pathname: string, init: RequestInit & { accountId?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.accountId) headers.set("x-account-id", init.accountId);
  return app.fetch(new Request(base + pathname, { ...init, headers }));
}

async function createConversation(accountId = CONSUMER): Promise<string> {
  const r = await req("/api/conversations", { method: "POST", accountId });
  assert.equal(r.status, 201);
  const body = await r.json() as { conversation: { id: string } };
  return body.conversation.id;
}

test("打字说「L-shape」套用模板后，喂给模型的系统提示词不能把未确认的墙长/门窗当成已确认", async () => {
  capturedSystemPrompts.length = 0;
  const id = await createConversation();

  const r = await req(`/api/conversations/${id}/messages`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ text: "L-shape" }),
  });
  assert.equal(r.status, 200, await r.clone().text());

  assert.ok(capturedSystemPrompts.length > 0, "这一轮应该调用了模型");
  const prompt = capturedSystemPrompts[capturedSystemPrompts.length - 1]!;

  // 墙长 144"/120" 是模板假设，客户从没报过——绝不能出现在 `intakeStatusNote`
  // 拼的 "[Status] ... Already confirmed (do NOT re-ask): ..." 这句具体清单里，
  // 否则模型会当事实复述给客户，还会因为"已确认勿再问"跳过本该做的确认。
  // 注意：系统提示词前半段本身就有一句通用指示"do not re-ask fields already
  // confirmed"（跟本次待验证的清单无关），必须精确锚定 `[Status]` 后面那句
  // 才不会误配到那句通用指示。
  const confirmedSection = prompt.match(
    /\[Status\][^]*?Already confirmed \(do NOT re-ask\):([^]*?)(?:\n\n|Ask at most ONE|$)/,
  )?.[1] ?? "";
  assert.notEqual(confirmedSection, "", "没能从提示词里定位到 [Status] 的 Already confirmed 清单");
  assert.doesNotMatch(confirmedSection, /144/,
    `模板假设的墙长 144" 不该出现在"已确认"清单里：\n${confirmedSection}`);
  assert.doesNotMatch(confirmedSection, /120/,
    `模板假设的墙长 120" 不该出现在"已确认"清单里：\n${confirmedSection}`);
  assert.doesNotMatch(confirmedSection, /window|plumbing|door/i,
    `模板预填、未经客户确认的门窗/上下水不该出现在"已确认"清单里：\n${confirmedSection}`);

  // 反过来，这些待确认项应该出现在"还要问"的清单里，而不是被静默吞掉。
  assert.match(prompt, /wall.{0,40}(length|North|East)/i,
    "墙长待确认应该出现在提示词的追问候选里");
});
