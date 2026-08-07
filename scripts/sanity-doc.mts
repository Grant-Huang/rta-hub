/**
 * 生成 / 校验《合理性审查规范》—— `docs/SANITY_RULES.md`。
 *
 * 规则表在 `src/delivery/sanity-rules.ts`，文档从它生成。**不是"文档和代码要
 * 记得同步"，而是文档就是代码的一个视图**——这两者一旦允许各写各的，
 * 迟早出现「规范里写了但代码没查」或者反过来，而两种都很难发现。
 *
 *   pnpm sanity:doc          写文件
 *   pnpm sanity:doc --check  只校验，不一致就非零退出（CI 用）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { SANITY_RULES, type SanityRule } from "../src/delivery/sanity-rules.js";

const OUT = "docs/SANITY_RULES.md";

const GROUPS: [string, string, string][] = [
  ["G", "几何与干涉", "装得进去、彼此不打架。这一组全部是阻断项——几何不成立的方案，" +
    "后面所有的好看与便宜都没有意义。"],
  ["E", "人体工程与安全", "NKBA 厨房规划指南的常见表述。⚠️ **这是种子数据，" +
    "上线前必须核对现行版本**（见 PRE_LAUNCH_CHECKLIST）。"],
  ["M", "物料与规格", "照这份清单下单，东西要能装完整，且每一项都真实存在。"],
  ["Q", "报价", "客户拿着这个数去比价、去签合同。"],
  ["D", "披露与阶段", "该说的话真的说了，该客户点头的地方真的等他点了头。"],
  ["V", "图纸", "客户看图做判断。图上少一个标签，判断依据就少一条。"],
];

const SEVERITY = { blocking: "🚫 阻断", advisory: "⚠️ 提示" } as const;
const ENFORCER = {
  audit: "交付前审核", layout: "排布层", render: "渲染层", pricing: "定价层",
} as const;

function section(rule: SanityRule): string {
  return [
    `#### ${rule.id}　${rule.title}`,
    "",
    `| | |`,
    `|---|---|`,
    `| 严重度 | ${SEVERITY[rule.severity]} |`,
    `| 由谁执行 | ${ENFORCER[rule.enforcedBy]}（\`${rule.implementedIn}\`） |`,
    "",
    `**判据**：${rule.criterion}`,
    "",
    `**为什么**：${rule.why}`,
    "",
  ].join("\n");
}

export function renderDoc(): string {
  const counts = {
    blocking: SANITY_RULES.filter((r) => r.severity === "blocking").length,
    advisory: SANITY_RULES.filter((r) => r.severity === "advisory").length,
  };

  const head = [
    "# 合理性审查规范",
    "",
    "> **这份文档由 `scripts/sanity-doc.mts` 从 `src/delivery/sanity-rules.ts` 生成。**",
    "> 不要手改——改规则改那个文件，然后跑 `pnpm sanity:doc`。",
    "> CI 会用 `--check` 校验两者一致（`test/sanity-rules.test.ts` 也会）。",
    "",
    "## 这份规范是干什么的",
    "",
    "把一份方案 / 一份报价交给客户之前，要过的全部检查，逐条列在这里。",
    "",
    "以前这些检查散在四五个模块里：排布器判净空、BOM 判缺不缺料、",
    "定价引擎判价格矩阵有没有洞。每一处都能跑，但**没有任何一处回答得了",
    "「一份方案要过哪些关」**——要回答这个问题，得把五个文件读一遍，",
    "而且读完还不确定有没有漏。于是产生两种事故，都很难发现：",
    "",
    "1. 规范里写了、代码里没实现——「我们检查了」其实没检查；",
    "2. 代码里加了检查、规范没更新——客户被拦下来，翻遍文档找不到依据。",
    "",
    "所以规则表只有一份，文档是它的视图。",
    "",
    "## 两档严重度，不设权重",
    "",
    "- **🚫 阻断**：一条都不放行，**不参与权衡**。任何权重都能被",
    "  「其他方面都很好」投票压过去，而一份缺料的报价单不会因为方案好看",
    "  就变得能用。",
    "- **⚠️ 提示**：不拦，但**必须显示给客户**。它们是交付物的一部分，",
    "  不是服务端日志——「你选的组装方式有几个柜体不提供」只写进日志的话，",
    "  客户永远不会知道。",
    "",
    `当前共 ${SANITY_RULES.length} 条：阻断 ${counts.blocking} 条、提示 ${counts.advisory} 条。`,
    "",
    "## 速查表",
    "",
    "| 编号 | 规则 | 严重度 | 由谁执行 |",
    "|---|---|---|---|",
    ...SANITY_RULES.map((r) =>
      `| ${r.id} | ${r.title} | ${SEVERITY[r.severity]} | ${ENFORCER[r.enforcedBy]} |`),
    "",
  ];

  const body: string[] = [];
  for (const [letter, name, intro] of GROUPS) {
    const rules = SANITY_RULES.filter((r) => r.id.startsWith(`SR-${letter}`));
    if (rules.length === 0) continue;
    body.push(`## ${name}`, "", intro, "");
    for (const r of rules) body.push(section(r));
  }

  const tail = [
    "---",
    "",
    "## 审核结论怎么读",
    "",
    "`renderAuditText` 把结论写成客户能读的话，每一条都带编号：",
    "",
    "```",
    "【这一版还不能用】",
    "  ✗ [SR-E2] 灶具两侧的落台区不足（现为 0\" / 57\"，需要一侧 ≥15\"、另一侧 ≥12\"）——这是放置热锅的安全空间",
    "",
    "【需要你知道的几点】",
    "  ! [SR-D2] 这面墙的排布评分偏低（48/100）——柜宽跳动或有凑数窄柜，想更整齐的话可以让我再调一版。",
    "```",
    "",
    "带编号是为了让结论**可追溯**：客户能查到依据，运营能核对这一条是谁规定的。",
    "没有编号的话，审核结论就只是一句系统自己说的话。",
    "",
    "## 加一条规则要做什么",
    "",
    "1. 在 `src/delivery/sanity-rules.ts` 的 `SanityRuleId` 里加编号，在 `SANITY_RULES` 里加条目；",
    "2. **真的实现它**——`enforcedBy` 写 `audit` 的，`auditDeliverable` 里必须跑得到；",
    "3. `pnpm sanity:doc` 重新生成本文档；",
    "4. 加测试。`test/sanity-rules.test.ts` 会检查「声明由审核执行的规则，审核确实跑到了」，",
    "   但它证明不了这条规则**判得对**——那需要一个会被它拦下来的用例。",
    "",
  ];

  return [...head, ...body, ...tail].join("\n");
}

const wanted = renderDoc();
const check = process.argv.includes("--check");
if (check) {
  let actual = "";
  try { actual = readFileSync(OUT, "utf8"); } catch { /* 文件不存在 */ }
  if (actual !== wanted) {
    console.error(`✖ ${OUT} 与 src/delivery/sanity-rules.ts 不一致。跑 \`pnpm sanity:doc\` 重新生成。`);
    process.exit(1);
  }
  console.log(`✔ ${OUT} 与规则表一致（${SANITY_RULES.length} 条）`);
} else {
  writeFileSync(OUT, wanted);
  console.log(`已写入 ${OUT}（${SANITY_RULES.length} 条规则）`);
}
