/**
 * 商家自助录入规格的 HTTP 路径 —— FR-2、SCENARIOS 场景 N/O/P。
 *
 * 这套状态机在 `spec/onboarding.ts` 里早就写好了，但**一直没有出口**：
 * 只有种子文件在进程内调它。一家真实商家没有任何办法把自己的价目表录进来，
 * 供给侧这一半从外面看是不存在的——这组测试盯的就是那个出口。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";

process.env.ADMIN_TOKEN = "test-admin";
process.env.SITE_PASSWORD_DISABLED = "true";

const app = await createApp({ ephemeral: true });

type Json = Record<string, any>;

async function req(
  path: string,
  init: RequestInit & { company?: string; admin?: boolean } = {},
): Promise<Json> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.company) headers.set("x-company-token", init.company);
  if (init.admin) headers.set("x-admin-token", "test-admin");
  const res = await app.fetch(new Request("http://t" + path, { ...init, headers }));
  const body = (await res.json().catch(() => ({}))) as Json;
  return { ...body, __status: res.status };
}

const SOURCES = {
  priceGroups: "code,displayName,rank\nSTD,Standard,1\n",
  doorStyles: "name,priceGroup\nPlain White,STD\n",
  modules: [
    "code,type,widths,heights,depths,assembly,faceTemplate",
    "B30,base,30,34-1/2,24,RTA,",
    "W3030,wall,30,30,12,RTA,",
  ].join("\n"),
  priceMatrix: "moduleCode,priceGroup,listPrice\nB30,STD,200.00\nW3030,STD,150.00\n",
};

let seq = 0;
async function newCompany(): Promise<{ id: string; token: string }> {
  const id = `co_t${seq++}`;
  const r = await req("/api/admin/companies", {
    method: "POST", admin: true,
    body: JSON.stringify({ id, name: `Test ${id}`, quoteEmail: `${id}@t.example` }),
  });
  assert.equal(r.__status, 201, JSON.stringify(r));
  return { id, token: r.accessToken };
}

// ── 开通 ─────────────────────────────────────────────────────────────────

test("开通商家时令牌只在这一次回包里出现", async () => {
  const r = await req("/api/admin/companies", {
    method: "POST", admin: true,
    body: JSON.stringify({ id: "co_secret", name: "Secret", quoteEmail: "s@t.example" }),
  });
  assert.ok(r.accessToken);
  assert.equal(r.company.accessToken, undefined, "公司对象里回吐了令牌");

  // 公司目录是公开的——令牌一旦出现在那里，隔离就等于没有
  const dir = await req("/api/companies");
  assert.equal(JSON.stringify(dir).includes(r.accessToken), false, "公司目录里漏出了令牌");
});

test("开通要运营令牌", async () => {
  const r = await req("/api/admin/companies", {
    method: "POST", body: JSON.stringify({ name: "X", quoteEmail: "x@t.example" }),
  });
  assert.equal(r.__status, 401);
});

// ── 录入会话 ─────────────────────────────────────────────────────────────

test("再点一次「开始录入」接着上一段，不是又开一段新的", async () => {
  // 每次都开新的话，商家会攒下一堆半截会话，还分不清哪一段是昨天填到一半的那个
  const { id, token } = await newCompany();
  const a = await req(`/api/company/${id}/spec/sessions`, { method: "POST", company: token });
  const b = await req(`/api/company/${id}/spec/sessions`, { method: "POST", company: token });
  assert.equal(a.resumed, false);
  assert.equal(b.resumed, true);
  assert.equal(b.session.id, a.session.id);
});

test("导入同时给出「进来几条」和「卡住几条」", async () => {
  // 只报一句"导入成功"，商家不会知道他 200 个型号里有 30 个根本没进来
  const { id, token } = await newCompany();
  const s = await req(`/api/company/${id}/spec/sessions`, { method: "POST", company: token });
  const r = await req(`/api/company/${id}/spec/sessions/${s.session.id}/import`, {
    method: "POST", company: token,
    body: JSON.stringify({
      sources: { ...SOURCES, modules: SOURCES.modules + "\nBAD,不是个类型,30,34,24,RTA," },
    }),
  });
  assert.equal(r.stats.moduleRows, 3);
  assert.equal(r.stats.modulesImported, 2);
  assert.equal(r.rejectedModuleRows, 1);
  assert.ok(r.unresolvedCount >= 1);
});

test("待确认项没清空不许发布，并说清拦的是哪一条", async () => {
  const { id, token } = await newCompany();
  const s = await req(`/api/company/${id}/spec/sessions`, { method: "POST", company: token });
  await req(`/api/company/${id}/spec/sessions/${s.session.id}/import`, {
    method: "POST", company: token,
    body: JSON.stringify({
      sources: { ...SOURCES, modules: SOURCES.modules + "\nZZZ9,base,30,34,24,RTA," },
    }),
  });
  const pub = await req(`/api/company/${id}/spec/sessions/${s.session.id}/publish`, {
    method: "POST", company: token, body: JSON.stringify({ publishedBy: "店长" }),
  });
  assert.equal(pub.__status, 409);
  assert.match(String(pub.error), /待确认/);
  assert.equal(pub.code, "UNRESOLVED_ITEMS");
  // 「发布失败」对商家毫无用处——要把剩下的问题一起带回去
  assert.ok((pub.pendingQuestions ?? []).length > 0);
});

test("回答追问要带值，并且真的落到规格上", async () => {
  const { id, token } = await newCompany();
  const s = await req(`/api/company/${id}/spec/sessions`, { method: "POST", company: token });
  const imported = await req(`/api/company/${id}/spec/sessions/${s.session.id}/import`, {
    method: "POST", company: token,
    body: JSON.stringify({
      sources: {
        ...SOURCES,
        modules: "code,type,widths,heights,depths,assembly\nZZZ9,base,30,34-1/2,24,RTA\n",
        priceMatrix: "moduleCode,priceGroup,listPrice\nZZZ9,STD,200.00\n",
      },
    }),
  });
  const faceQ = imported.pendingQuestions.find((q: Json) => /正视图/.test(q.prompt));
  assert.ok(faceQ, "认不出脸型的型号应该有一条追问");

  // 不带值 → 不算答完
  const empty = await req(`/api/company/${id}/spec/sessions/${s.session.id}/answer`, {
    method: "POST", company: token, body: JSON.stringify({ questionId: faceQ.id }),
  });
  assert.equal(empty.__status, 400);
  assert.equal(empty.code, "ANSWER_MISSING_VALUE");

  const ok = await req(`/api/company/${id}/spec/sessions/${s.session.id}/answer`, {
    method: "POST", company: token,
    body: JSON.stringify({ questionId: faceQ.id, answer: { faceTemplateId: "F2_DOUBLE_DOOR" } }),
  });
  assert.equal(ok.__status, 200);
  assert.equal(ok.unresolvedCount, imported.unresolvedCount - 1);
});

// ── 发布 ─────────────────────────────────────────────────────────────────

async function publishable(): Promise<{ id: string; token: string; sessionId: string }> {
  const { id, token } = await newCompany();
  const s = await req(`/api/company/${id}/spec/sessions`, { method: "POST", company: token });
  await req(`/api/company/${id}/spec/sessions/${s.session.id}/import`, {
    method: "POST", company: token, body: JSON.stringify({ sources: SOURCES }),
  });
  // 逐条答完。**没有"跳过"这个动作**——每一条都要给一个真的值
  let state = await req(`/api/company/${id}/spec/sessions/${s.session.id}`, { company: token });
  let guard = 0;
  while ((state.pendingQuestions ?? []).length > 0 && guard++ < 40) {
    const q = state.pendingQuestions[0];
    const answer = /正视图/.test(String(q.prompt))
      ? { faceTemplateId: "F2_DOUBLE_DOOR" }
      : { roles: ["doorStorage"] };
    state = await req(`/api/company/${id}/spec/sessions/${s.session.id}/answer`, {
      method: "POST", company: token, body: JSON.stringify({ questionId: q.id, answer }),
    });
    assert.equal(state.__status, 200, JSON.stringify(state));
  }
  return { id, token, sessionId: s.session.id };
}

test("发布后明确说「还出不了报价」，并列出到底缺什么", async () => {
  // 商家发布完、开了订阅、等线索，等到的是一条都没有——因为每一份报价都在
  // 交付前被 SR-M1 拦下了，而看到那句错的是客户，不是他
  const { id, token, sessionId } = await publishable();
  const pub = await req(`/api/company/${id}/spec/sessions/${sessionId}/publish`, {
    method: "POST", company: token, body: JSON.stringify({ publishedBy: "店长" }),
  });
  assert.equal(pub.__status, 201);
  assert.equal(pub.published.status, "published");
  assert.equal(pub.canQuote, false);

  // 两道门槛都要说：订阅 + 规格完整性
  assert.ok(pub.blockers.some((b: string) => /订阅/.test(b)), JSON.stringify(pub.blockers));
  assert.equal(pub.specCompleteness.ready, false);
  assert.ok(pub.specCompleteness.missing.some((m: string) => /踢脚|收口|填缝/.test(m)),
    JSON.stringify(pub.specCompleteness));
});

test("已发布的那一版不能再改，要开新草稿", async () => {
  const { id, token, sessionId } = await publishable();
  await req(`/api/company/${id}/spec/sessions/${sessionId}/publish`, {
    method: "POST", company: token, body: JSON.stringify({ publishedBy: "店长" }),
  });
  const tamper = await req(`/api/company/${id}/spec/sessions/${sessionId}/import`, {
    method: "POST", company: token, body: JSON.stringify({ sources: SOURCES }),
  });
  assert.equal(tamper.__status, 409);
  assert.match(String(tamper.error), /开新草稿/);
});

test("改价不用把「这个柜子长什么样」再答一遍", async () => {
  // 那是型号的固有属性，不是这一版的属性。答二十遍之后人会开始随手点，
  // 而这套队列存在的全部意义就是让人认真看一眼。
  //
  // 用的是**命名规则认不出来的**型号码（每家商家的命名体系都不一样，这是常态）：
  // 能被规则认出来的码本来就不会问，验不出继承有没有生效。
  const { id, token } = await newCompany();
  const odd = {
    ...SOURCES,
    modules: "code,type,widths,heights,depths,assembly\nZQ7,base,30,34-1/2,24,RTA\n",
    priceMatrix: "moduleCode,priceGroup,listPrice\nZQ7,STD,200.00\n",
  };
  const s1 = await req(`/api/company/${id}/spec/sessions`, { method: "POST", company: token });
  let st = await req(`/api/company/${id}/spec/sessions/${s1.session.id}/import`, {
    method: "POST", company: token, body: JSON.stringify({ sources: odd }),
  });
  assert.ok(st.unresolvedCount > 0, "认不出的码第一次应该被问");

  let guard = 0;
  while ((st.pendingQuestions ?? []).length > 0 && guard++ < 20) {
    const q = st.pendingQuestions[0];
    st = await req(`/api/company/${id}/spec/sessions/${s1.session.id}/answer`, {
      method: "POST", company: token,
      body: JSON.stringify({
        questionId: q.id,
        answer: /正视图/.test(String(q.prompt))
          ? { faceTemplateId: "F2_DOUBLE_DOOR" } : { roles: ["doorStorage"] },
      }),
    });
  }
  await req(`/api/company/${id}/spec/sessions/${s1.session.id}/publish`, {
    method: "POST", company: token, body: JSON.stringify({ publishedBy: "店长" }),
  });

  const s2 = await req(`/api/company/${id}/spec/sessions`, { method: "POST", company: token });
  assert.notEqual(s2.session.id, s1.session.id, "改价应该开一段新会话");

  const v2 = await req(`/api/company/${id}/spec/sessions/${s2.session.id}/import`, {
    method: "POST", company: token,
    body: JSON.stringify({
      sources: { ...odd, priceMatrix: "moduleCode,priceGroup,listPrice\nZQ7,STD,240.00\n" },
    }),
  });
  assert.equal(v2.unresolvedCount, 0, `改价被要求重答 ${v2.unresolvedCount} 条`);
  assert.ok(v2.inheritedFromPrevious > 0, "一条都没从上一版继承过来");
});

// ── 隔离 ─────────────────────────────────────────────────────────────────

test("A 家的令牌碰不了 B 家的规格", async () => {
  // 这是一个多商家平台，互为竞争对手。一次越权就是把一家的价目表交到另一家手上
  const a = await newCompany();
  const b = await newCompany();
  const sb = await req(`/api/company/${b.id}/spec/sessions`, { method: "POST", company: b.token });

  const cases = [
    await req(`/api/company/${b.id}/spec/sessions`, { method: "POST", company: a.token }),
    await req(`/api/company/${b.id}/spec/templates`, { company: a.token }),
    await req(`/api/company/${b.id}/spec/sessions/${sb.session.id}/import`, {
      method: "POST", company: a.token, body: JSON.stringify({ sources: SOURCES }) }),
    await req(`/api/company/${b.id}/spec/sessions/${sb.session.id}/publish`, {
      method: "POST", company: a.token, body: JSON.stringify({}) }),
  ];
  for (const r of cases) {
    assert.ok(r.__status === 401 || r.__status === 404, `越权通过了：${r.__status}`);
  }
});

test("令牌对得上公司，但会话不属于那家 → 也要挡住", async () => {
  const a = await newCompany();
  const b = await newCompany();
  const sb = await req(`/api/company/${b.id}/spec/sessions`, { method: "POST", company: b.token });
  // 拿 B 家的会话 id，走 A 家的路径、用 A 家的令牌
  const r = await req(`/api/company/${a.id}/spec/sessions/${sb.session.id}`, { company: a.token });
  assert.equal(r.__status, 404);
});

// ── 订阅 ─────────────────────────────────────────────────────────────────

test("发布 + 订阅两条都满足，公司才真的 active", async () => {
  const { id, token, sessionId } = await publishable();
  const before = await req(`/api/admin/companies/${id}/subscription`, {
    method: "POST", admin: true, body: JSON.stringify({ subscription: "active" }),
  });
  assert.equal(before.active, false, "只有订阅、还没发布规格，不该是 active");

  await req(`/api/company/${id}/spec/sessions/${sessionId}/publish`, {
    method: "POST", company: token, body: JSON.stringify({ publishedBy: "店长" }),
  });
  const after = await req(`/api/admin/companies/${id}/subscription`, {
    method: "POST", admin: true, body: JSON.stringify({ subscription: "active" }),
  });
  assert.equal(after.active, true);
  assert.equal(after.company.accessToken, undefined, "订阅接口回吐了令牌");
});


test("没有「跳过」这个动作——不给答案就不许划掉", () => {
  // 留一个"先划掉再说"的按钮，等于整套队列是可选的：
  // 商家点二十下就能带着一堆空数据发布
  return (async () => {
    const { id, token } = await newCompany();
    const s = await req(`/api/company/${id}/spec/sessions`, { method: "POST", company: token });
    await req(`/api/company/${id}/spec/sessions/${s.session.id}/import`, {
      method: "POST", company: token,
      body: JSON.stringify({
        sources: {
          ...SOURCES,
          modules: "code,type,widths,heights,depths,assembly\nZZZ9,base,30,34-1/2,24,RTA\n",
          priceMatrix: "moduleCode,priceGroup,listPrice\nZZZ9,STD,200.00\n",
        },
      }),
    });
    const skip = await req(`/api/company/${id}/spec/sessions/${s.session.id}/answer`, {
      method: "POST", company: token, body: JSON.stringify({ unresolvedIndex: 0 }),
    });
    assert.equal(skip.__status, 400);
    assert.match(String(skip.error), /重新导入/, "没有告诉商家该怎么处理表里写错的那几条");

    const still = await req(`/api/company/${id}/spec/sessions/${s.session.id}`, { company: token });
    assert.ok(still.unresolvedCount > 0, "那一条被划掉了");
  })();
});
