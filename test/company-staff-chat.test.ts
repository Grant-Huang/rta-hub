/**
 * 厂商员工会话（Type2 A）—— 对话式初始化：门店地址/标准折扣/目录上传/入驻问答循环。
 * 没配 LLM 的测试环境里走的是确定性兜底路径（精确句式/精确 token），这正是
 * 「没配 LLM 就不许猜」这条约束本身要验的行为。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";

process.env.ADMIN_TOKEN = "test-admin";
process.env.SITE_PASSWORD_DISABLED = "true";

const app = await createApp({ ephemeral: true });

type Json = Record<string, any>;

async function req(path: string, init: RequestInit & { company?: string; admin?: boolean } = {}): Promise<Json> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.company) headers.set("x-company-token", init.company);
  if (init.admin) headers.set("x-admin-token", "test-admin");
  const res = await app.fetch(new Request("http://t" + path, { ...init, headers }));
  const body = (await res.json().catch(() => ({}))) as Json;
  return { ...body, __status: res.status };
}

let seq = 0;
async function newCompany(): Promise<{ id: string; token: string }> {
  const id = `co_sc${seq++}`;
  const r = await req("/api/admin/companies", {
    method: "POST", admin: true,
    body: JSON.stringify({ id, name: `Staff Chat Co ${id}`, quoteEmail: `${id}@t.example` }),
  });
  assert.equal(r.__status, 201, JSON.stringify(r));
  return { id, token: r.accessToken };
}

test("新公司第一次打开线程会看到引导语，列出要备齐的资产和支持的文件格式", async () => {
  const { id, token } = await newCompany();
  const r = await req(`/api/company/${id}/staff-chat`, { company: token });
  assert.equal(r.thread.messages.length, 1);
  assert.equal(r.thread.messages[0].role, "assistant");
  assert.match(r.thread.messages[0].content, /[Pp]rice matrix/);
  assert.match(r.thread.messages[0].content, /\.xlsx/);

  // 再打开一次不会重复种引导语
  const again = await req(`/api/company/${id}/staff-chat`, { company: token });
  assert.equal(again.thread.messages.length, 1);
});

test("说「门店地址是：...」直接落地到 CabinetCompany.storeAddress", async () => {
  const { id, token } = await newCompany();
  const r = await req(`/api/company/${id}/staff-chat/messages`, {
    method: "POST", company: token,
    body: JSON.stringify({ text: "门店地址是：多伦多市中心 123 Main St" }),
  });
  assert.equal(r.__status, 200);
  assert.equal(r.company.storeAddress, "多伦多市中心 123 Main St");
  assert.match(r.thread.messages.at(-1).content, /已记录门店地址/);
});

test("没有规格草稿/发布版本时，设置标准折扣要报错，不能悬空写", async () => {
  const { id, token } = await newCompany();
  const r = await req(`/api/company/${id}/staff-chat/messages`, {
    method: "POST", company: token,
    body: JSON.stringify({ text: "标准折扣 15%" }),
  });
  assert.equal(r.__status, 409);
  assert.match(String(r.error), /import a catalog/i);
});

test("上传 JSON 目录后：能设标准折扣，也能走完追问循环并发布", async () => {
  const { id, token } = await newCompany();

  const upload = await req(`/api/company/${id}/staff-chat/catalog`, {
    method: "POST", company: token,
    body: JSON.stringify({
      priceGroups: [{ code: "STD", displayName: "Standard" }],
      doorStyles: [{ name: "Plain White", priceGroup: "STD" }],
      // 用命名规则认不出来的码，确保产生一条脸型追问（同 onboarding-http.test.ts 的手法）
      modules: [{ code: "ZQ9", type: "base", widths: "30", heights: "34-1/2", depths: "24" }],
      priceMatrix: [{ moduleCode: "ZQ9", priceGroup: "STD", listPrice: "200.00" }],
    }),
  });
  assert.equal(upload.__status, 201, JSON.stringify(upload));
  assert.ok(upload.session.unresolved.length > 0, "认不出的码应该有待确认项");
  assert.equal(upload.thread.messages.at(-1).role, "assistant");

  // 标准折扣现在能设了——草稿已经有 specVersionId
  const disc = await req(`/api/company/${id}/staff-chat/messages`, {
    method: "POST", company: token,
    body: JSON.stringify({ text: "标准折扣 12%" }),
  });
  assert.equal(disc.__status, 200);
  assert.match(disc.thread.messages.at(-1).content, /-12%/);

  // 走完追问循环——没配 LLM，只认精确 token
  let session = await req(`/api/company/${id}/spec/sessions/${upload.session.id}`, { company: token });
  let guard = 0;
  while ((session.pendingQuestions ?? []).length > 0 && guard++ < 10) {
    const q = session.pendingQuestions[0];
    const answer = /elevation/i.test(String(q.prompt)) ? "F2_DOUBLE_DOOR" : "doorStorage";
    const r = await req(`/api/company/${id}/staff-chat/messages`, {
      method: "POST", company: token, body: JSON.stringify({ text: answer }),
    });
    assert.equal(r.__status, 200, JSON.stringify(r));
    assert.match(r.thread.messages.at(-1).content, /Got it|记下了/);
    session = await req(`/api/company/${id}/spec/sessions/${upload.session.id}`, { company: token });
  }
  assert.equal(session.unresolvedCount, 0);
});

test("答不上追问的自由文本，Agent 明确说没听懂，不悄悄划掉那一条", async () => {
  const { id, token } = await newCompany();
  const upload = await req(`/api/company/${id}/staff-chat/catalog`, {
    method: "POST", company: token,
    body: JSON.stringify({
      priceGroups: [{ code: "STD", displayName: "Standard" }],
      doorStyles: [{ name: "Plain White", priceGroup: "STD" }],
      modules: [{ code: "ZQ8", type: "base", widths: "30", heights: "34-1/2", depths: "24" }],
      priceMatrix: [{ moduleCode: "ZQ8", priceGroup: "STD", listPrice: "200.00" }],
    }),
  });
  assert.ok(upload.session.unresolved.length > 0);

  const r = await req(`/api/company/${id}/staff-chat/messages`, {
    method: "POST", company: token, body: JSON.stringify({ text: "不太清楚，你看着办吧" }),
  });
  assert.match(r.thread.messages.at(-1).content, /没听懂|Could not map/i);

  const session = await req(`/api/company/${id}/spec/sessions/${upload.session.id}`, { company: token });
  assert.ok(session.unresolvedCount > 0, "没答上的那条不该被悄悄划掉");
});

test("每次打开页面都重新检查入驻是否完成：有待答追问就继续提醒，不会重复贴同一条", async () => {
  const { id, token } = await newCompany();

  const upload = await req(`/api/company/${id}/staff-chat/catalog`, {
    method: "POST", company: token,
    body: JSON.stringify({
      priceGroups: [{ code: "STD", displayName: "Standard" }],
      doorStyles: [{ name: "Plain White", priceGroup: "STD" }],
      modules: [{ code: "ZQ7", type: "base", widths: "30", heights: "34-1/2", depths: "24" }],
      priceMatrix: [{ moduleCode: "ZQ7", priceGroup: "STD", listPrice: "200.00" }],
    }),
  });
  assert.ok(upload.session.unresolved.length > 0, "认不出的码应该有待确认项");
  const afterUpload = upload.thread.messages.length;

  // 上传刚完成，追问已经在最后一条消息里——重新打开页面不应该再贴一遍
  const reopened = await req(`/api/company/${id}/staff-chat`, { company: token });
  assert.equal(reopened.thread.messages.length, afterUpload);

  // 再打开几次也一样，不会越攒越多
  const reopenedAgain = await req(`/api/company/${id}/staff-chat`, { company: token });
  assert.equal(reopenedAgain.thread.messages.length, afterUpload);

  // 走完追问循环并发布
  let session = await req(`/api/company/${id}/spec/sessions/${upload.session.id}`, { company: token });
  let guard = 0;
  while ((session.pendingQuestions ?? []).length > 0 && guard++ < 10) {
    const q = session.pendingQuestions[0];
    const answer = /elevation/i.test(String(q.prompt)) ? "F2_DOUBLE_DOOR" : "doorStorage";
    await req(`/api/company/${id}/staff-chat/messages`, {
      method: "POST", company: token, body: JSON.stringify({ text: answer }),
    });
    session = await req(`/api/company/${id}/spec/sessions/${upload.session.id}`, { company: token });
  }
  assert.equal(session.unresolvedCount, 0);

  // 没有待答项了，但还没发布——打开页面应该提醒"可以发布了"，且只提醒一次
  const readyToPublish = await req(`/api/company/${id}/staff-chat`, { company: token });
  assert.match(readyToPublish.thread.messages.at(-1).content, /可以发布|ready to publish/i);
  const readyLen = readyToPublish.thread.messages.length;
  const readyAgain = await req(`/api/company/${id}/staff-chat`, { company: token });
  assert.equal(readyAgain.thread.messages.length, readyLen);

  await req(`/api/company/${id}/spec/sessions/${upload.session.id}/publish`, {
    method: "POST", company: token, body: JSON.stringify({ publishedBy: "test" }),
  });

  // 发布完成——入驻结束，打开页面不再提醒
  const afterPublish = await req(`/api/company/${id}/staff-chat`, { company: token });
  assert.equal(afterPublish.thread.messages.length, readyLen);
});

test("不支持的文件类型（.txt）明确拒绝，不假装能解析", async () => {
  const { id, token } = await newCompany();
  const form = new FormData();
  form.set("file", new File(["code,type\nB30,base"], "catalog.txt", { type: "text/plain" }));
  const headers = new Headers();
  headers.set("x-company-token", token);
  const res = await app.fetch(new Request(`http://t/api/company/${id}/staff-chat/catalog`, {
    method: "POST", headers, body: form,
  }));
  assert.equal(res.status, 400);
  const body = await res.json() as Json;
  assert.match(String(body.error), /xlsx|json|pdf/i);
});
