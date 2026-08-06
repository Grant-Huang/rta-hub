/**
 * 上线闸门 —— 把「上线前必须核实的事」变成代码里会拦人的东西。
 *
 * ## 为什么要这个
 *
 * 检查清单（PRE_LAUNCH_CHECKLIST.md）是给人看的，几十项，容易漏。真正危险的几项
 * 有个共同点：**错了不会报错，只会安静地给出错的结果**——税率错了照样出报价单，
 * NKBA 净空错了照样判方案合规。等发现的时候，错的东西已经发出去了。
 *
 * 所以这些项不能只躺在文档里。这里把它们做成启动时的闸门：
 *
 *   - 生产环境有未核实的阻断项 → **拒绝启动**；
 *   - 非生产 → 每次启动打印清单；
 *   - 要明知故犯，必须**逐项**写进 `LAUNCH_GATES_ACKNOWLEDGED`，不能一把全关。
 *
 * 与 site-gate.ts 同一条思路：让配置/流程的疏漏变成一次响亮的启动失败。
 *
 * ## 为什么记日期而不是 true
 *
 * 核实过不等于永远有效。各省税率会改（NS 2025-04-01 由 15% 降到 14%，
 * 我们的税表里就是两条记录），NKBA 指南也有修订历史。所以环境变量的值是
 * **核实日期**（`YYYY-MM-DD`），过了复核周期会重新变成待办。
 * 写 `true` 的话，三年后没人知道那个 `true` 是什么时候按下的。
 *
 * 台账与核实方法见 docs/LAUNCH_BLOCKERS.md。
 */

export type GateOwner = "engineering" | "operations" | "legal";

export interface LaunchGate {
  /** 与 PRE_LAUNCH_CHECKLIST 的编号对齐，便于两边对照。 */
  id: string;
  title: string;
  /** 声明已核实的环境变量。取值是核实日期 `YYYY-MM-DD`。 */
  env: string;
  owner: GateOwner;
  /** 生产环境未核实时是否拒绝启动。 */
  blocking: boolean;
  /** 多久要复核一次；不填表示一次核实长期有效。 */
  revalidateAfterDays?: number;
  /** 为什么它是闸门——错了会怎样。 */
  why: string;
}

/**
 * 闸门清单。
 *
 * blocking 的判断标准是**「错了会不会安静地产出错误的对外结果」**：
 *   - 税率错 → 报价单金额错，且是发给客户和公司的 → 阻断
 *   - NKBA 净空错 → 合规方案被判不合规，或不合规方案放行 → 阻断
 *   - 鉴权没做 → 任何人可冒充账号读取他人 PII → 阻断
 *   - 线索费率没定 → 会向公司收一笔没谈过的钱 → 阻断
 *   - GenericCatalog 来源未核实 → 代码已经如实降级标注为占位数据 → 只告警
 *   - 留存清除没接定时任务 → 数据留超期，是合规问题但不产出错误结果 → 只告警
 */
export const LAUNCH_GATES: readonly LaunchGate[] = [
  {
    id: "A1/A2",
    title: "各省税率与生效日期逐条核对",
    env: "VERIFIED_TAX_RATES",
    owner: "operations",
    blocking: true,
    revalidateAfterDays: 365,
    why: "税率错了，报价单上的金额就是错的，而这份金额会同时发给客户和橱柜公司。" +
      "税率还会变（NS 2025-04-01 由 15% 降到 14%），所以核实有保质期。",
  },
  {
    id: "A4",
    title: "GenericCatalog 价格区间的数据来源",
    env: "VERIFIED_GENERIC_CATALOG",
    owner: "operations",
    blocking: false,
    why: "未核实时代码已经如实把预估标注为占位数据（不会冒充行业数据），" +
      "所以不阻断启动；但一直不定案，冷启动预估的可信度就一直立不住。",
  },
  {
    id: "A6",
    title: "NKBA 人体工程净空数值核实",
    env: "VERIFIED_NKBA_CLEARANCES",
    owner: "operations",
    blocking: true,
    revalidateAfterDays: 730,
    why: "这些是硬约束：数值偏大会把本来合规的方案判为不合规（客户拿不到方案），" +
      "偏小会放过真正的问题（灶台旁没处放热锅的方案被发出去）。两个方向都不会报错。",
  },
  {
    id: "B6",
    title: "留存到期清除的定时任务接线",
    env: "VERIFIED_RETENTION_CRON",
    owner: "engineering",
    blocking: false,
    why: "清除计划已实现并有测试，但没有定时任务真的去跑它。" +
      "数据会留超 PIPEDA 承诺的期限——是合规问题，但不产出错误结果，故只告警。",
  },
  {
    id: "E1",
    title: "生产级鉴权（真正的登录态）",
    env: "VERIFIED_AUTH_MODEL",
    owner: "engineering",
    blocking: true,
    why: "当前 X-Account-Id 头不做校验：整站口令后面的人仍可改这个头读取他人的" +
      "姓名、邮箱与户型图。整站口令买到的是时间，不是安全。",
  },
  {
    id: "G4",
    title: "线索费率定案并写入公司合同",
    env: "VERIFIED_LEAD_FEE",
    owner: "operations",
    blocking: true,
    why: "费率没定就开始计费，等于向入驻公司收一笔他们没同意过的钱。",
  },
];

export type GateStatus = "verified" | "stale" | "unverified" | "acknowledged";

export interface GateResult {
  gate: LaunchGate;
  status: GateStatus;
  /** 核实日期（解析成功时）。 */
  verifiedOn?: string;
  /** 距离复核到期还有几天；已过期为负。 */
  daysUntilRevalidation?: number;
  detail: string;
}

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 明知故犯的逃生口：必须逐项写 id，不能一把全关。 */
function acknowledged(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    (env["LAUNCH_GATES_ACKNOWLEDGED"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function evaluateGate(
  gate: LaunchGate,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): GateResult {
  if (acknowledged(env).has(gate.id)) {
    return {
      gate,
      status: "acknowledged",
      detail: "已在 LAUNCH_GATES_ACKNOWLEDGED 中显式承担风险",
    };
  }

  const raw = env[gate.env]?.trim();
  if (!raw) {
    return { gate, status: "unverified", detail: `未设置 ${gate.env}` };
  }
  if (!DATE_RE.test(raw)) {
    // 不接受 true —— 日期才回答得了「什么时候核实的」
    return {
      gate,
      status: "unverified",
      detail: `${gate.env} 必须是核实日期（YYYY-MM-DD），当前是 "${raw}"`,
    };
  }
  const on = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(on)) {
    return { gate, status: "unverified", detail: `${gate.env} 不是合法日期："${raw}"` };
  }
  if (on > now.getTime()) {
    return { gate, status: "unverified", detail: `${gate.env} 是未来日期："${raw}"` };
  }

  if (gate.revalidateAfterDays === undefined) {
    return { gate, status: "verified", verifiedOn: raw, detail: `${raw} 已核实` };
  }

  const dueAt = on + gate.revalidateAfterDays * DAY_MS;
  const daysLeft = Math.floor((dueAt - now.getTime()) / DAY_MS);
  if (daysLeft < 0) {
    return {
      gate, status: "stale", verifiedOn: raw, daysUntilRevalidation: daysLeft,
      detail: `${raw} 核实，已超过 ${gate.revalidateAfterDays} 天复核周期 ${-daysLeft} 天`,
    };
  }
  return {
    gate, status: "verified", verifiedOn: raw, daysUntilRevalidation: daysLeft,
    detail: `${raw} 已核实，${daysLeft} 天后需复核`,
  };
}

export function evaluateLaunchGates(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): GateResult[] {
  return LAUNCH_GATES.map((g) => evaluateGate(g, env, now));
}

/** 通过 = 已核实或已显式承担风险。stale 不算通过——过期的核实等于没核实。 */
export function isPassing(r: GateResult): boolean {
  return r.status === "verified" || r.status === "acknowledged";
}

export class LaunchGatesNotMet extends Error {
  constructor(readonly failures: readonly GateResult[], message: string) {
    super(message);
    this.name = "LaunchGatesNotMet";
  }
}

/**
 * 生产环境的启动前检查。
 *
 * 只拦 `blocking` 的项；非阻断项由启动提示负责让人看见。
 */
export function assertLaunchReady(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): void {
  if (env["NODE_ENV"] !== "production") return;

  const failures = evaluateLaunchGates(env, now).filter((r) => r.gate.blocking && !isPassing(r));
  if (failures.length === 0) return;

  const lines = failures.map((r) =>
    `  [${r.gate.id}] ${r.gate.title}\n` +
    `      状态：${r.detail}\n` +
    `      为什么拦你：${r.gate.why}\n` +
    `      负责方：${ownerLabel(r.gate.owner)}　声明方式：${r.gate.env}=YYYY-MM-DD`);

  throw new LaunchGatesNotMet(
    failures,
    `还有 ${failures.length} 项上线闸门未通过：\n\n${lines.join("\n\n")}\n\n` +
    `核实方法与台账见 docs/LAUNCH_BLOCKERS.md。\n` +
    `确实要在未核实的情况下上线，请逐项写入 ` +
    `LAUNCH_GATES_ACKNOWLEDGED=${failures.map((r) => r.gate.id).join(",")}（会记录在启动日志里）。`,
  );
}

function ownerLabel(owner: GateOwner): string {
  return { engineering: "工程", operations: "运营", legal: "法务" }[owner];
}

/**
 * 启动时打印的摘要。
 *
 * 全部通过时只有一行；有待办时把它们摊开——这就是「上线时提醒我一下」的落点。
 */
export function launchGateReport(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): string[] {
  const results = evaluateLaunchGates(env, now);
  const outstanding = results.filter((r) => !isPassing(r));
  const ack = results.filter((r) => r.status === "acknowledged");

  const lines: string[] = [];
  if (outstanding.length === 0 && ack.length === 0) {
    lines.push("上线闸门：全部已核实 ✓");
    const soon = results
      .filter((r) => r.daysUntilRevalidation !== undefined && r.daysUntilRevalidation <= 30);
    for (const r of soon) {
      lines.push(`  · [${r.gate.id}] ${r.gate.title} 还有 ${r.daysUntilRevalidation} 天需复核`);
    }
    return lines;
  }

  const blockingCount = outstanding.filter((r) => r.gate.blocking).length;
  lines.push(
    `上线闸门：${outstanding.length} 项待办` +
    (blockingCount > 0 ? `（其中 ${blockingCount} 项会阻断生产启动）` : "") +
    "　—— 详见 docs/LAUNCH_BLOCKERS.md",
  );
  for (const r of outstanding) {
    lines.push(
      `  ${r.gate.blocking ? "🚫" : "⚠️ "} [${r.gate.id}] ${r.gate.title}` +
      `（${ownerLabel(r.gate.owner)}）：${r.detail}`,
    );
  }
  for (const r of ack) {
    lines.push(`  ⚑ [${r.gate.id}] ${r.gate.title}：${r.detail}`);
  }
  return lines;
}

/** 运营端点用的结构化视图。 */
export function launchGateSummary(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
) {
  const results = evaluateLaunchGates(env, now);
  return {
    ready: results.filter((r) => r.gate.blocking).every(isPassing),
    gates: results.map((r) => ({
      id: r.gate.id,
      title: r.gate.title,
      owner: r.gate.owner,
      blocking: r.gate.blocking,
      env: r.gate.env,
      status: r.status,
      detail: r.detail,
      ...(r.verifiedOn ? { verifiedOn: r.verifiedOn } : {}),
      ...(r.daysUntilRevalidation !== undefined
        ? { daysUntilRevalidation: r.daysUntilRevalidation } : {}),
      why: r.gate.why,
    })),
  };
}

/**
 * A4 的取值收口。
 *
 * 旧的 `GENERIC_CATALOG_VERIFIED=true` 继续认——它已经在用了，
 * 直接改会让现有部署静默变成「未核实」。新配置用日期，是权威来源。
 */
export function genericCatalogVerified(env: NodeJS.ProcessEnv = process.env): boolean {
  const gate = LAUNCH_GATES.find((g) => g.id === "A4")!;
  if (isPassing(evaluateGate(gate, env))) return true;
  return env["GENERIC_CATALOG_VERIFIED"] === "true";
}
