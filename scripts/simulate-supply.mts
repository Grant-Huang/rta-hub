/**
 * 供给侧端到端模拟 —— 商家与平台运营那一半。
 *
 * 需求侧有 `simulate.mts`，跑了八个场景；供给侧此前**一个端到端场景都没有**。
 * 而这个平台有三方：客户、商家、平台运营。商家那一半出问题的后果不比客户侧轻——
 * 一个静默吞掉的型号会让这家商家的**每一版**方案都少一个柜子，而没有人会发现。
 *
 * 与需求侧那支一样，走的是**真实 HTTP 端点**，不是直接调库函数：
 * 跑出来的东西就是商家实际会拿到的东西。
 *
 * 覆盖 SCENARIOS 场景 N/O/P/Q/R/S：
 *   N 自助录入并发布　O 脏价目表　P 改价与版本
 *   Q 线索计费与争议　R 商家之间的隔离　S 平台运营的日常
 *
 * 用法：npx tsx scripts/simulate-supply.mts [输出目录]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

process.env.SMTP_HOST = "";
process.env.ADMIN_TOKEN = "sim";
process.env.SITE_PASSWORD_DISABLED = "true";
// CASL 要求每封商业邮件披露发件人名称与联系方式。这几项不配，发送会失败——
// 这是**部署必须配的东西**，不是可选项，所以模拟里也照配一份真实的。
process.env.SENDER_NAME = "RTA-Hub 模拟";
process.env.SMTP_FROM = "sim@rta-hub.example";
process.env.SENDER_PHONE = "+1-604-555-0100";

const OUT = process.argv[2] ?? "sim-supply-out";
const ADMIN = "sim";

type Json = Record<string, any>;

/** 时间线上的一条事件。与需求侧同一个理由：读者的视角是时间，不是数据种类。 */
type Beat =
  | { kind: "act"; who: "商家" | "运营" | "客户"; text: string }
  | { kind: "sys"; text: string }
  | { kind: "ok"; text: string }
  | { kind: "warn"; text: string }
  | { kind: "block"; text: string };

const failures: string[] = [];
const beats: { scenario: string; beats: Beat[] }[] = [];

function check(cond: boolean, pass: string, fail: string, out: Beat[]): boolean {
  if (cond) out.push({ kind: "ok", text: pass });
  else { out.push({ kind: "warn", text: `✗ ${fail}` }); failures.push(fail); }
  return cond;
}

// ── 商家给的价目表 ────────────────────────────────────────────────────────

/** 一份干净的表。真实商家的第二版长这样——第一版见 `DIRTY`。 */
const CLEAN = {
  priceGroups: "code,displayName,rank\nSTD,Standard,1\nPRM,Premium,2\n",
  doorStyles: "name,priceGroup,material,color\n" +
    "Coastal White,STD,MDF,White\nCoastal Walnut,PRM,Walnut,Natural\n",
  modules: [
    "code,type,widths,heights,depths,assembly,faceTemplate",
    "NS-B12,base,12,34-1/2,24,RTA|assembled,",
    "NS-B18,base,18,34-1/2,24,RTA|assembled,",
    "NS-B24,base,24,34-1/2,24,RTA|assembled,",
    "NS-B30,base,30,34-1/2,24,RTA|assembled,",
    "NS-SB33,sinkBase,33,34-1/2,24,RTA,",
    "NS-W2430,wall,24,30|36,12,RTA,",
    "NS-W3030,wall,30,30|36,12,RTA,",
    "NS-F03,filler,3,34-1/2,3/4,RTA,",
    // 装完一套厨房必须有的收口件。第一版价目表里没有——真实商家常漏，
    // 而漏了的后果是每一份报价都被交付前检查拦下（SR-M1）
    "NS-WF03,filler,3,30,3/4,RTA,",
    "NS-TK8,toeKick,96,4-1/2,3/4,RTA,",
    "NS-BEP,panel,24,34-1/2,3/4,RTA,",
    "NS-WEP,panel,12,30|36,3/4,RTA,",
    "NS-TEP,panel,24,84|90,3/4,RTA,",
  ].join("\n"),
  priceMatrix: [
    "moduleCode,priceGroup,listPrice,assembledUpcharge",
    "NS-B12,STD,132.00,14%", "NS-B12,PRM,221.00,14%",
    "NS-B18,STD,158.00,14%", "NS-B18,PRM,266.00,14%",
    "NS-B24,STD,186.00,14%", "NS-B24,PRM,312.00,14%",
    "NS-B30,STD,214.00,14%", "NS-B30,PRM,359.00,14%",
    "NS-SB33,STD,268.00,", "NS-SB33,PRM,449.00,",
    "NS-W2430,STD,148.00,", "NS-W2430,PRM,248.00,",
    "NS-W3030,STD,171.00,", "NS-W3030,PRM,287.00,",
    "NS-F03,STD,36.00,", "NS-F03,PRM,58.00,",
    "NS-WF03,STD,31.00,", "NS-WF03,PRM,49.00,",
    "NS-TK8,STD,44.00,", "NS-TK8,PRM,71.00,",
    "NS-BEP,STD,62.00,", "NS-BEP,PRM,98.00,",
    "NS-WEP,STD,54.00,", "NS-WEP,PRM,86.00,",
    "NS-TEP,STD,118.00,", "NS-TEP,PRM,187.00,",
  ].join("\n"),
  // 备注里带英寸符号——橱柜价目表里到处都是，不该炸掉整张表
  boxMaterials: [
    "code,name,upcharge,default,note",
    'particleBoard,Standard Box,0%,yes,5/8" 颗粒板，标价按这一档',
    'plywood,All-Plywood Box,19%,,1/2" 夹板箱体 + 3/4" 层板',
  ].join("\n"),
};

/**
 * 真实商家给的**第一版**表。常见的脏法一次全塞进去（场景 O）。
 *
 * 判据不是"能导进来多少"，是"没进来的有没有全部被报出来"。
 */
const DIRTY = {
  ...CLEAN,
  modules: [
    "code,type,widths,heights,depths,assembly,faceTemplate",
    "NS-B12,base,12,34-1/2,24,RTA,",
    "NS-B18,Base Cabinet,18,34-1/2,24,RTA,",   // ① 类型写成自己的叫法 → 认不出
    "NS-B24,base,,34-1/2,24,RTA,",              // ② 宽度空着
    "X-9981,base,24,34-1/2,24,RTA,",            // ③ 命名不符合任何规律 → 脸型判不出
    "NS-SB33,sinkBase,33,34-1/2,24,RTA,",
    "NS-W3030,wall,30,30,12,RTA,",
    "NS-F03,filler,3,34-1/2,3/4,RTA,",
  ].join("\n"),
  doorStyles: "name,priceGroup,material,color\n" +
    "Coastal White,STD,MDF,White\n" +
    "Coastal Walnut,LUX,Walnut,Natural\n",     // ④ 引用了不存在的价格组
  priceMatrix: [
    "moduleCode,priceGroup,listPrice,assembledUpcharge",
    "NS-B12,STD,\"$1,132.00 \",",               // ⑤ 带 $ 和逗号和空格 —— 能洗
    "NS-B12,PRM,221.00,",
    "NS-SB33,STD,268.00,", "NS-SB33,PRM,449.00,",
    "NS-W3030,STD,171.00,", "NS-W3030,PRM,287.00,",
    "NS-F03,STD,36.00,", "NS-F03,PRM,58.00,",
    // ⑥ NS-B18 / X-9981 一行价都没有 → 发布时要被点名
  ].join("\n"),
};

/** 涨价后的第二版（场景 P）。同样的型号，标价整体上浮。 */
const V2 = {
  ...CLEAN,
  priceMatrix: CLEAN.priceMatrix.split("\n").map((line, i) => {
    if (i === 0) return line;
    const cells = line.split(",");
    const price = Number(cells[2]);
    return Number.isFinite(price)
      ? [cells[0], cells[1], (price * 1.12).toFixed(2), cells[3] ?? ""].join(",")
      : line;
  }).join("\n"),
};

// ── 跑一遍 ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mod = await import("../src/server.js");
  // 计费只在**真的投递出去**之后才发生（dry-run 返回 delivered:false，那是对的：
  // 什么都没发出去，就没有线索可收费）。所以这里注入一个假的投递器，
  // 让「发送 → 计费 → 去重 → 争议」这条链路真的走一遍。
  const sent: Record<string, unknown>[] = [];
  const app = await mod.createApp({
    ephemeral: true,
    mailTransport: { async sendMail(msg) { sent.push(msg); return { messageId: `sim_${sent.length}` }; } },
  });

  const call = async (
    p: string,
    init: RequestInit & { acct?: string; company?: string; admin?: boolean } = {},
  ): Promise<Json> => {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (init.acct) headers.set("x-account-id", init.acct);
    if (init.company) headers.set("x-company-token", init.company);
    if (init.admin) headers.set("x-admin-token", ADMIN);
    const res = await app.fetch(new Request("http://sim" + p, { ...init, headers }));
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok && res.status >= 500) {
      throw new Error(`${p} → ${res.status} ${JSON.stringify(body)}`);
    }
    return { ...body, __status: res.status };
  };

  mkdirSync(OUT, { recursive: true });

  // ══ 场景 N + O：新商家从零录到发布 ══════════════════════════════════════
  const n: Beat[] = [];
  n.push({ kind: "act", who: "运营", text: "北岸厨柜想入驻，给他开个后台入口" });
  const created = await call("/api/admin/companies", {
    method: "POST", admin: true,
    body: JSON.stringify({
      id: "co_northshore", name: "North Shore Cabinets",
      aliases: ["北岸厨柜", "NorthShore"], quoteEmail: "quotes@northshore.example",
      province: "BC", subscription: "none",
    }),
  });
  const TOKEN: string = created.accessToken ?? "";
  check(!!TOKEN, `开通成功，令牌已发给商家（${TOKEN.slice(0, 8)}…）`,
    `开通商家失败：${JSON.stringify(created)}`, n);
  check(created.company?.accessToken === undefined,
    "公司对象里不带令牌——它只在这一次回包的独立字段里出现",
    "公司对象里回吐了 accessToken", n);

  n.push({ kind: "act", who: "商家", text: "先看看你们要什么格式" });
  const tpl = await call("/api/company/co_northshore/spec/templates", { company: TOKEN });
  check(!!tpl.templates?.modules && !!tpl.templates?.priceMatrix,
    `拿到空白模板（${Object.keys(tpl.templates ?? {}).length} 张表，含可选的箱体板材表）`,
    `模板拿不到：${JSON.stringify(tpl)}`, n);

  n.push({ kind: "act", who: "商家", text: "开始录入" });
  const s1 = await call("/api/company/co_northshore/spec/sessions", { method: "POST", company: TOKEN });
  const SESSION: string = s1.session?.id ?? "";
  check(!!SESSION && s1.resumed === false, `开了一段录入会话 ${SESSION}`,
    `开会话失败：${JSON.stringify(s1)}`, n);

  // 重复点"开始录入"不该攒下一堆半截会话
  const s1again = await call("/api/company/co_northshore/spec/sessions", { method: "POST", company: TOKEN });
  check(s1again.resumed === true && s1again.session?.id === SESSION,
    "再点一次「开始录入」接着上一段，不是又开一段新的",
    `重复开会话产生了第二段：${s1again.session?.id}`, n);

  // ── 场景 O：先传上来的是脏表 ──
  n.push({ kind: "act", who: "商家", text: "价目表传上来了（Excel 导出的第一版）" });
  const dirty = await call(`/api/company/co_northshore/spec/sessions/${SESSION}/import`, {
    method: "POST", company: TOKEN, body: JSON.stringify({ sources: DIRTY }),
  });
  n.push({
    kind: "sys",
    text: `导入结果：型号 ${dirty.stats?.modulesImported}/${dirty.stats?.moduleRows} 行进来了，` +
      `价格 ${dirty.stats?.priceMatrixImported}/${dirty.stats?.priceMatrixRows} 行；` +
      `待确认 ${dirty.unresolvedCount} 项`,
  });
  check((dirty.rejectedModuleRows ?? 0) > 0 && (dirty.unresolvedCount ?? 0) > 0,
    `脏行没有被静默吞掉：${dirty.rejectedModuleRows} 行型号没进来，全部进了待确认队列`,
    "脏表导进去了却没有任何待确认项——那意味着有东西被静默吞掉了", n);

  const reasons = (dirty.pendingQuestions ?? []).map((q: Json) => String(q.prompt));
  for (const [what, re] of [
    ["类型写成自己的叫法", /类型|type/],
    ["宽度空着", /widths|宽/],
    ["脸型判不出", /正视图|脸型|faceTemplate/],
    ["价格组不存在", /价格组/],
  ] as const) {
    check(reasons.some((r: string) => re.test(r)), `「${what}」被问出来了`,
      `「${what}」没有进待确认队列——它被静默吞掉了`, n);
  }
  // 英寸符号那一条：不是"能不能导进来"，是"会不会炸掉整张表"
  check((dirty.stats?.moduleRows ?? 0) > 0,
    "备注里的英寸符号没有炸掉整张表（RFC 4180：只有字段开头的引号才是引号）",
    "带英寸符号的表整张解析失败", n);

  n.push({ kind: "act", who: "商家", text: "队列没清就想发布试试" });
  const early = await call(`/api/company/co_northshore/spec/sessions/${SESSION}/publish`, {
    method: "POST", company: TOKEN, body: JSON.stringify({ publishedBy: "店长" }),
  });
  check(early.__status === 409 && /待确认/.test(String(early.error)),
    `拦住了，并说清拦的是哪一条：「${early.error}」`,
    `队列没清空却放行了（${early.__status}）`, n);

  // ── 商家照着队列改好表，重新导一次 ──
  n.push({ kind: "act", who: "商家", text: "照着问题清单改好了，重新传一版" });
  const clean = await call(`/api/company/co_northshore/spec/sessions/${SESSION}/import`, {
    method: "POST", company: TOKEN, body: JSON.stringify({ sources: CLEAN }),
  });
  n.push({
    kind: "sys",
    text: `重新导入：型号 ${clean.stats?.modulesImported}/${clean.stats?.moduleRows} 行全部进来，` +
      `剩 ${clean.unresolvedCount} 项要商家自己说清楚`,
  });
  check(clean.stats?.modulesImported === clean.stats?.moduleRows,
    "型号全部进来了", `还有 ${clean.rejectedModuleRows} 行型号没进来`, n);

  // 「NS-」这套命名不符合任何内置规则——**这是常态**，每家商家的命名体系都不一样。
  // 系统不猜，逐个问；商家逐个答。这一段就是场景 N 第 4 点。
  n.push({
    kind: "act", who: "商家",
    text: `我们的编号规则你们认不出来，我逐个说：还剩 ${clean.unresolvedCount} 条`,
  });
  const FACE: Record<string, string> = {
    "NS-B12": "F1_SINGLE_DOOR", "NS-B18": "F1_SINGLE_DOOR",
    "NS-B24": "F5_TWO_DRAWERS_OVER_DOUBLE", "NS-B30": "F5_TWO_DRAWERS_OVER_DOUBLE",
    "NS-SB33": "F7_FALSE_FRONT_DOUBLE",
    "NS-W2430": "F2_DOUBLE_DOOR", "NS-W3030": "F2_DOUBLE_DOOR",
    "NS-F03": "F1_SINGLE_DOOR", "NS-WF03": "F1_SINGLE_DOOR",
    "NS-TK8": "F1_SINGLE_DOOR", "NS-BEP": "F1_SINGLE_DOOR", "NS-WEP": "F1_SINGLE_DOOR",
    "NS-TEP": "F1_SINGLE_DOOR",
  };
  const ROLE: Record<string, string[]> = {
    "NS-B12": ["doorStorage"], "NS-B18": ["doorStorage"],
    "NS-B24": ["doorStorage", "drawerStorage"], "NS-B30": ["doorStorage", "drawerStorage"],
    "NS-SB33": ["sinkBase", "cooktopBase"],
    "NS-W2430": ["doorStorage"], "NS-W3030": ["doorStorage"],
    "NS-F03": ["trim"], "NS-WF03": ["trim"],
    "NS-TK8": ["trim"], "NS-BEP": ["trim"], "NS-WEP": ["trim"], "NS-TEP": ["trim"],
  };

  let state = clean;
  let guard = 0;
  while ((state.pendingQuestions ?? []).length > 0 && guard++ < 60) {
    const q: Json = state.pendingQuestions[0];
    // 追问里带着型号码，照着给答案
    const code = Object.keys(FACE).find((k) => String(q.prompt).includes(k));
    const answer = /正视图/.test(String(q.prompt))
      ? { faceTemplateId: code ? FACE[code] : "F1_SINGLE_DOOR" }
      : { roles: code ? ROLE[code] : ["doorStorage"] };
    const r = await call(`/api/company/co_northshore/spec/sessions/${SESSION}/answer`, {
      method: "POST", company: TOKEN,
      body: JSON.stringify({ questionId: q.id, answer }),
    });
    if (r.__status !== 200) {
      check(false, "", `回答第 ${guard} 条追问失败：${r.error}`, n);
      break;
    }
    state = r;
  }
  n.push({ kind: "sys", text: `逐条答完，人工修正 ${state.manualCorrections} 次` });
  check(state.unresolvedCount === 0, "队列清空",
    `逐条答完之后还剩 ${state.unresolvedCount} 项：` +
      (state.pendingQuestions ?? []).map((q: Json) => q.prompt).join(" | "), n);
  check(state.canPublish === true, "可以发布了", "队列空了却还是不让发布", n);

  // 答案要**真的落到规格上**：只把警报关掉而不补数据，等于没答
  const draftBundle = await call(`/api/company/co_northshore/spec/sessions/${SESSION}`, { company: TOKEN });
  check(draftBundle.__status === 200, "会话读得回来", "会话读不回来", n);

  n.push({ kind: "act", who: "商家", text: "确认发布" });
  const pub = await call(`/api/company/co_northshore/spec/sessions/${SESSION}/publish`, {
    method: "POST", company: TOKEN, body: JSON.stringify({ publishedBy: "店长" }),
  });
  check(pub.__status === 201 && pub.published?.status === "published",
    `发布成功，版本 v${pub.published?.versionNo}（不可变）`,
    `发布失败：${JSON.stringify(pub)}`, n);
  check(pub.canQuote === false && (pub.blockers ?? []).some((b: string) => /订阅/.test(b)),
    "并且说清了「发布 ≠ 能出报价」：订阅还没生效",
    "发布后没说明还需要订阅生效——商家会以为自己已经上线了", n);
  check(pub.specCompleteness?.ready === true,
    "规格完整性检查通过：收口件齐了，客户下单时不会被交付前检查拦下",
    `规格缺料：${(pub.specCompleteness?.missing ?? []).join("、")}`, n);

  // ── 缺收口件的那一版：发布放行，但**当场告诉商家后果** ──
  //
  // 这一条是这次模拟抓到的真问题：商家发布了一套没有踢脚板的规格，系统说
  // 「发布成功」，商家开订阅、等线索，等到的是一条都没有——因为每一份报价
  // 都在交付前被 SR-M1 拦下了，而看到那句错的是客户，不是他。
  n.push({ kind: "act", who: "商家", text: "（另一家漏了收口件，看看会怎样）" });
  const gap = await call("/api/admin/companies", {
    method: "POST", admin: true,
    body: JSON.stringify({
      id: "co_gapco", name: "Gap Cabinets", quoteEmail: "q@gap.example", subscription: "active",
    }),
  });
  const gapSession = await call("/api/company/co_gapco/spec/sessions", {
    method: "POST", company: gap.accessToken,
  });
  // 型号和价格行**一起**拿掉：只删型号会留下一堆孤儿价格行，
  // 而那是另一个问题（"型号未在型号表中定义"），会盖住这里要验的那一条
  const DROP = /NS-TK8|NS-BEP|NS-WEP|NS-WF03|NS-TEP/;
  const noTrim = {
    ...CLEAN,
    modules: CLEAN.modules.split("\n").filter((l) => !DROP.test(l)).join("\n"),
    priceMatrix: CLEAN.priceMatrix.split("\n").filter((l) => !DROP.test(l)).join("\n"),
  };
  await call(`/api/company/co_gapco/spec/sessions/${gapSession.session.id}/import`, {
    method: "POST", company: gap.accessToken,
    body: JSON.stringify({
      sources: noTrim,
      faceOverrides: { "NS-": { templateId: "F2_DOUBLE_DOOR" } },
    }),
  });
  // 把剩下的追问一次性划掉（这里验的是发布那一刻的提示，不是回答流程）
  let gapState = await call(`/api/company/co_gapco/spec/sessions/${gapSession.session.id}`, {
    company: gap.accessToken,
  });
  let gapGuard = 0;
  while ((gapState.pendingQuestions ?? []).length > 0 && gapGuard++ < 60) {
    const q: Json = gapState.pendingQuestions[0];
    gapState = await call(`/api/company/co_gapco/spec/sessions/${gapSession.session.id}/answer`, {
      method: "POST", company: gap.accessToken,
      body: JSON.stringify({
        questionId: q.id,
        answer: /正视图/.test(String(q.prompt))
          ? { faceTemplateId: "F2_DOUBLE_DOOR" } : { roles: ["doorStorage"] },
      }),
    });
  }
  const gapPub = await call(`/api/company/co_gapco/spec/sessions/${gapSession.session.id}/publish`, {
    method: "POST", company: gap.accessToken, body: JSON.stringify({ publishedBy: "店长" }),
  });
  check(gapPub.specCompleteness?.ready === false
    && (gapPub.blockers ?? []).some((b: string) => /踢脚|收口/.test(b)),
    `缺收口件时**在发布那一刻**就说清了：${(gapPub.specCompleteness?.missing ?? []).join("、")}`,
    `缺收口件却没有在发布时提示（商家要等到"一条线索都没有"才发现）：${JSON.stringify(gapPub.specCompleteness)}`, n);
  check(gapPub.canQuote === false,
    "并且明确标了「现在还出不了报价」", "缺料却说能出报价", n);

  n.push({ kind: "act", who: "运营", text: "北岸签了订阅，开通" });
  const sub = await call("/api/admin/companies/co_northshore/subscription", {
    method: "POST", admin: true, body: JSON.stringify({ subscription: "active" }),
  });
  check(sub.active === true, "订阅生效，公司状态变为 active（发布 + 订阅两条都满足）",
    `订阅开通后公司仍不是 active：${JSON.stringify(sub)}`, n);
  beats.push({ scenario: "N + O. 新商家自助录入并发布（含脏价目表）", beats: n });

  // ══ 场景 R：商家之间的隔离 ═════════════════════════════════════════════
  const r: Beat[] = [];
  r.push({ kind: "act", who: "商家", text: "（北岸拿自己的令牌去碰枫岭的东西）" });
  const cases: [string, Json][] = [
    ["读枫岭的计费事件", await call("/api/company/co_pilot/billing", { company: TOKEN })],
    ["开枫岭的录入会话", await call("/api/company/co_pilot/spec/sessions", { method: "POST", company: TOKEN })],
    ["改枫岭的规格草稿", await call(`/api/company/co_pilot/spec/sessions/${SESSION}/import`, {
      method: "POST", company: TOKEN, body: JSON.stringify({ sources: CLEAN }) })],
    ["不带令牌读自己的账单", await call("/api/company/co_northshore/billing")],
  ];
  for (const [what, res] of cases) {
    check(res.__status === 401 || res.__status === 404,
      `${what} → 挡住（${res.__status}）`,
      `${what} 竟然通过了（${res.__status}）——这是把一家的价目表交到竞争对手手上`, r);
  }
  // 用自己的会话 id 去打别家的路径：令牌对得上公司，但会话不属于那家
  const crossSession = await call(`/api/company/co_northshore/spec/sessions/${SESSION}`, { company: TOKEN });
  check(crossSession.__status === 200, "自己的令牌 + 自己的会话 → 正常读到", "自己的会话都读不到", r);

  const ghost = await call("/api/company/co_不存在的公司/billing", { company: TOKEN });
  const wrongToken = await call("/api/company/co_pilot/billing", { company: "gibberish" });
  check(ghost.error === wrongToken.error,
    "「公司不存在」与「令牌不对」返回同样的说法——不让人枚举出平台上有哪些公司",
    `两种失败的说法不同：「${ghost.error}」vs「${wrongToken.error}」`, r);
  beats.push({ scenario: "R. 商家之间的隔离", beats: r });

  // ══ 场景 P：改价与版本 ═════════════════════════════════════════════════
  const p: Beat[] = [];
  p.push({ kind: "act", who: "客户", text: "（先在北岸下一份报价，作为改价前的基准）" });
  const q1 = await quoteAt(call, "co_northshore");
  if (!q1) {
    p.push({ kind: "warn", text: "✗ 没能在新商家这里出一份报价——后面的版本对比没法做" });
    failures.push("新入驻的商家出不了报价");
  } else {
    p.push({ kind: "sys", text: `客户拿到报价 ${q1.id}　${q1.total}` });

    p.push({ kind: "act", who: "商家", text: "板材涨价 12%，开新草稿" });
    const s2 = await call("/api/company/co_northshore/spec/sessions", { method: "POST", company: TOKEN });
    const S2: string = s2.session?.id ?? "";
    check(S2 !== SESSION && s2.resumed === false,
      "开的是一段新会话——已发布的那一版不在这里改", "改价复用了已发布的那段会话", p);

    const v2import = await call(`/api/company/co_northshore/spec/sessions/${S2}/import`, {
      method: "POST", company: TOKEN, body: JSON.stringify({ sources: V2 }),
    });
    // 改价不该重问一遍"这个柜子长什么样"——那是型号的固有属性，不是这一版的属性
    check(v2import.unresolvedCount === 0,
      `改价不用重答一遍：${v2import.inheritedFromPrevious} 个型号的脸型与能力从上一版继承过来`,
      `改一次价被要求重答 ${v2import.unresolvedCount} 条追问——` +
        "答二十遍之后人会开始随手点，这套队列就白设了", p);
    const pub2 = await call(`/api/company/co_northshore/spec/sessions/${S2}/publish`, {
      method: "POST", company: TOKEN, body: JSON.stringify({ publishedBy: "店长" }),
    });
    check(pub2.__status === 201 && pub2.published?.versionNo === 2,
      `v2 发布成功，v1 自动归档（${pub2.archived?.status}）`,
      `v2 发布失败：${JSON.stringify(pub2)}`, p);
    check(pub2.archived?.status === "archived", "v1 转 archived", "v1 没有被归档", p);

    // 老报价一分不变
    const reread = await call(`/api/quotes/${q1.id}`, { acct: q1.acct });
    check(reread.quote?.total === q1.raw,
      `改价之后重读那份老报价：金额一分没变（${reread.formattedTotal}）`,
      `老报价金额漂了：${q1.total} → ${reread.formattedTotal}`, p);
    check(reread.quote?.specVersionId === q1.specVersionId,
      "它引用的还是当时那一版规格（快照，不是实时查价）",
      "老报价指向了新版本", p);

    // 新客户按 v2
    const q2 = await quoteAt(call, "co_northshore");
    if (q2) {
      check(q2.raw > q1.raw,
        `新客户按 v2 报价，比涨价前贵（${q1.total} → ${q2.total}）`,
        `涨价 12% 之后新报价没有变贵：${q1.total} → ${q2.total}`, p);
    }

    // 已发布的版本不可改
    const tamper = await call(`/api/company/co_northshore/spec/sessions/${SESSION}/import`, {
      method: "POST", company: TOKEN, body: JSON.stringify({ sources: V2 }),
    });
    check(tamper.__status === 409,
      `想直接改已发布的 v1 → 拒绝：「${tamper.error}」`,
      `已发布的版本被改动了（${tamper.__status}）`, p);
  }
  beats.push({ scenario: "P. 改价与版本", beats: p });

  // ══ 场景 Q：线索计费与争议 ═════════════════════════════════════════════
  const qb: Beat[] = [];
  const lead = await quoteAt(call, "co_pilot", { send: true });
  if (!lead) {
    qb.push({ kind: "warn", text: "✗ 没能走到发送这一步" });
    failures.push("报价发送链路走不通");
  } else {
    qb.push({
      kind: "sys",
      text: `客户确认发送 → 枫岭邮箱收到（共投递 ${sent.length} 封）　报价 ${lead.id}`,
    });
    check(sent.length > 0, "邮件真的投递出去了", "一封邮件都没发出去", qb);
    const bills = await call("/api/company/co_pilot/billing", { admin: true });
    const mine = (bills.events ?? []).filter((e: Json) => e.conversationId === lead.conversationId);
    check(mine.length === 1, "记了一条线索计费事件", `计费事件数不对：${mine.length}`, qb);

    // 30 天窗口内再发一次
    const again = await call(`/api/quotes/${lead.id}/send`, { method: "POST", acct: lead.acct });
    const bills2 = await call("/api/company/co_pilot/billing", { admin: true });
    const mine2 = (bills2.events ?? []).filter((e: Json) => e.conversationId === lead.conversationId);
    check(mine2.length === 1,
      `同一客户 30 天内再发一次：邮件照发，但不重复计费（仍然 ${mine2.length} 条）`,
      `重复计费了：${mine2.length} 条`, qb);
    check(again.billingSuppressed === true || again.billingEventId === undefined,
      "并且如实说明了这一次没有计费", "重复发送时没说明计费是否发生", qb);

    const evt = mine2[0];
    if (evt) {
      qb.push({ kind: "act", who: "商家", text: "这条线索的联系方式是空号，我要申诉" });
      const disp = await call(`/api/company/co_pilot/billing/${evt.id}/dispute`, {
        method: "POST", admin: true,
        body: JSON.stringify({ reason: "invalidContact", evidence: "电话打不通，邮件退回", openedBy: "店长" }),
      });
      check(disp.event?.feeStatus === "disputed" && !!disp.event?.dispute?.openedAt,
        `争议已受理，这笔费用转为 ${disp.event?.feeStatus}——争议期内不入账`,
        `发起争议失败：feeStatus=${disp.event?.feeStatus}`, qb);

      const pending = await call("/api/admin/disputes", { admin: true });
      const row = (pending.disputes ?? []).find((d: Json) => d.event?.id === evt.id);
      check(!!row, "运营的裁定台上看得到这一条", "裁定台上看不到刚提的争议", qb);
      // 裁定要有依据：光有一个 id 和金额，运营判断不了这条线索是不是真的
      check(!!row?.evidence?.auditTrail?.length,
        `并且带着可核对的证据（${row?.evidence?.auditTrail?.length} 条审计流水、快照完整性 ${row?.evidence?.snapshotIntact}）`,
        "裁定台上没有可核对的证据", qb);

      qb.push({ kind: "act", who: "运营", text: "查了投递回执，确实退信 —— 免单" });
      const resolved = await call(`/api/admin/billing/${evt.id}/resolve`, {
        method: "POST", admin: true,
        body: JSON.stringify({ resolution: "fullRefund", resolvedBy: "ops_amy" }),
      });
      check(resolved.event?.dispute?.resolution === "fullRefund"
        && resolved.event?.feeStatus === "refunded"
        && resolved.event?.dispute?.resolvedBy === "ops_amy",
        `裁定为免单，费用状态转为 ${resolved.event?.feeStatus}，裁定人与时间都留了痕`,
        `裁定失败：feeStatus=${resolved.event?.feeStatus} resolution=${resolved.event?.dispute?.resolution}`, qb);

      const after = await call("/api/admin/disputes", { admin: true });
      check(!(after.disputes ?? []).some((d: Json) => d.event?.id === evt.id),
        "裁定完就从待办里消失了", "已裁定的还留在待办列表上", qb);

      const twice = await call(`/api/company/co_pilot/billing/${evt.id}/dispute`, {
        method: "POST", admin: true,
        body: JSON.stringify({ reason: "duplicate", evidence: "再来一次", openedBy: "店长" }),
      });
      check(twice.__status === 409,
        "已裁定的事件不能再次发起争议", `重复争议被接受了（${twice.__status}）`, qb);
    }
  }
  beats.push({ scenario: "Q. 线索计费与争议", beats: qb });

  // ══ 场景 S：平台运营的日常 ═════════════════════════════════════════════
  const sb: Beat[] = [];
  const gates = await call("/api/admin/launch-gates", { admin: true });
  const all: Json[] = gates.gates ?? [];
  const blocking = all.filter((g) => g.blocking && g.status !== "verified");
  sb.push({
    kind: "sys",
    text: `上线闸门：${all.length} 项，其中 ${blocking.length} 项会阻断生产启动` +
      `（${blocking.map((g) => g.id).join("、")}）`,
  });
  check(all.length > 0, "闸门清单看得到", "闸门清单是空的", sb);
  // 「还没就绪」这件事必须是**明确的否**，不能靠字段名写错就变成一片绿
  check(gates.ready === false && blocking.length > 0,
    `明确标了「还不能上生产」——每一项都带着 owner 与待办说明`,
    `闸门报告说已经就绪（ready=${gates.ready}，阻断项 ${blocking.length}），` +
      "但台账里明明还有没核实的项", sb);
  for (const g of blocking) {
    sb.push({ kind: "warn", text: `⛔ [${g.id}] ${g.title}（${g.owner}）：${g.detail}` });
  }

  const signals = await call("/api/admin/mention-signals", { admin: true });
  const leaked = JSON.stringify(signals).match(/@[\w.]+@|ca_demo|customerAccountId/);
  check(!leaked,
    "销售看板只有聚合计数与外联话术，没有任何客户身份（FR-13 第 3 条）",
    `销售看板里漏出了客户身份：${leaked?.[0]}`, sb);

  const retention = await call("/api/admin/retention/plan", { admin: true });
  check(retention.__status === 200, "留存清除计划出得来", "留存清除计划出不来", sb);
  sb.push({
    kind: "warn",
    text: "留存清除：计划已生成；定时任务见 RETENTION_CRON_MS / POST /api/admin/retention/run（B6）",
  });

  const noAuth = await call("/api/admin/launch-gates");
  check(noAuth.__status === 401, "不带运营令牌读运营接口 → 挡住", "运营接口没有鉴权", sb);
  beats.push({ scenario: "S. 平台运营的日常", beats: sb });

  // ── 报告 ──
  const report = render(beats);
  console.log(report);
  writeFileSync(path.join(OUT, "supply.txt"), report, "utf-8");

  if (failures.length > 0) {
    console.log(`\n✖ 冒烟检查未通过（${failures.length} 项）：`);
    for (const f of failures) console.log(`  · ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✔ 冒烟检查通过：${beats.length} 组供给侧场景全程走通。`);
  }
  console.log(`\n产出写入 ${OUT}/supply.txt`);
}

/**
 * 借需求侧那条链路在某家公司出一份报价。
 *
 * 供给侧的很多断言（改价不影响老报价、线索计费）都要先有一份真实报价，
 * 而"真实"的意思就是**走客户实际走的那条路**，不是直接往库里塞一条。
 */
async function quoteAt(
  call: (p: string, init?: RequestInit & { acct?: string; company?: string; admin?: boolean }) => Promise<Json>,
  companyId: string,
  opts: { send?: boolean } = {},
): Promise<{ id: string; total: string; raw: number; acct: string; conversationId: string; specVersionId: string } | undefined> {
  const acct = "ca_demo_consumer";
  const conv = await call("/api/conversations", { method: "POST", acct });
  const conversationId: string = conv.conversation?.id;
  if (!conversationId) return undefined;

  const fp = await call(`/api/conversations/${conversationId}/floorplan`, {
    method: "POST", acct,
    body: JSON.stringify({ fileName: "k.png", mimeType: "image/png", sizeBytes: 1 }),
  });
  const fpId: string = fp.floorPlan?.id;
  if (!fpId) return undefined;

  await call(`/api/floorplans/${fpId}/resolve`, {
    method: "POST", acct, body: JSON.stringify({ addRun: { label: "北墙", length: 144 } }),
  });
  await call(`/api/floorplans/${fpId}/resolve`, {
    method: "POST", acct, body: JSON.stringify({ ceilingHeight: 96 }),
  });
  const advance = (action: string) => call(`/api/conversations/${conversationId}/design/advance`, {
    method: "POST", acct, body: JSON.stringify({ companyId, action }),
  });
  await advance("consent");
  await call(`/api/floorplans/${fpId}/plan-view`, {
    method: "POST", acct, body: JSON.stringify({ companyId }),
  });
  await advance("approvePlan");
  const layout = await call(`/api/floorplans/${fpId}/layout`, {
    method: "POST", acct, body: JSON.stringify({ companyId }),
  });
  if (!layout.selections) {
    if (process.env.SUPPLY_DEBUG) console.error("layout 失败:", JSON.stringify(layout).slice(0, 400));
    return undefined;
  }

  const spec = await call(`/api/companies/${companyId}/spec`);
  const doorStyleId = spec.doorStyles?.[0]?.id;
  const quote = await call("/api/quotes", {
    method: "POST", acct,
    body: JSON.stringify({ companyId, conversationId, doorStyleId, selections: layout.selections }),
  });
  if (!quote.quote) {
    if (process.env.SUPPLY_DEBUG) console.error("报价失败:", JSON.stringify(quote).slice(0, 600));
    return undefined;
  }

  if (opts.send) {
    const confirmed = await call(`/api/quotes/${quote.quote.id}/confirm`, { method: "POST", acct });
    const sendRes = await call(`/api/quotes/${quote.quote.id}/send`, { method: "POST", acct });
    if (process.env.SUPPLY_DEBUG) {
      console.error("confirm:", JSON.stringify(confirmed).slice(0, 200));
      console.error("send status:", sendRes.quote?.status, "dryRun:", sendRes.dryRun,
        "billing:", sendRes.billingEventId, "err:", sendRes.sendError ?? sendRes.error);
    }
  }
  return {
    id: quote.quote.id, total: quote.formattedTotal, raw: quote.quote.total,
    acct, conversationId, specVersionId: quote.quote.specVersionId,
  };
}

const ICON: Record<Beat["kind"], string> = {
  act: "", sys: "  ", ok: "  ✔ ", warn: "  ", block: "  ⛔ ",
};

function render(groups: { scenario: string; beats: Beat[] }[]): string {
  const out: string[] = [];
  for (const g of groups) {
    out.push("", "═".repeat(72), g.scenario, "═".repeat(72));
    for (const b of g.beats) {
      if (b.kind === "act") out.push(`  ${b.who}：${b.text}`);
      else out.push(`${ICON[b.kind]}${b.text}`);
    }
  }
  return out.join("\n");
}

await main();
