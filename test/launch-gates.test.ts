/**
 * 上线闸门 —— 把「上线前必须核实的事」做成会拦人的东西。
 *
 * 最要紧的断言：**生产环境有未核实的阻断项必须拒绝启动**，
 * 且逃生口只能逐项声明，不能一把全关。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertLaunchReady, evaluateGate, evaluateLaunchGates, genericCatalogVerified, isPassing,
  LAUNCH_GATES, LaunchGatesNotMet, launchGateReport, launchGateSummary,
} from "../src/app/launch-gates.js";

const NOW = new Date("2026-08-06T00:00:00Z");
const gateOf = (id: string) => LAUNCH_GATES.find((g) => g.id === id)!;

/** 所有阻断项都已核实的环境，作为「可上线」的基线。 */
function allVerified(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const g of LAUNCH_GATES) env[g.env] = "2026-08-01";
  return { ...env, ...over };
}

// ── 清单本身 ──────────────────────────────────────────────────────────────

test("清单覆盖用户点名的六项", () => {
  const ids = LAUNCH_GATES.map((g) => g.id).sort();
  assert.deepEqual(ids, ["A1/A2", "A4", "A6", "B6", "E1", "G4"]);
});

test("阻断与否的划分：会安静产出错误结果的才阻断", () => {
  for (const id of ["A1/A2", "A6", "E1", "G4"]) {
    assert.equal(gateOf(id).blocking, true, `${id} 应该阻断`);
  }
  // A4 代码已如实降级标注、B6 不产出错误结果，故只告警
  for (const id of ["A4", "B6"]) {
    assert.equal(gateOf(id).blocking, false, `${id} 不该阻断启动`);
  }
});

test("会变的项有复核周期，一次性的项没有", () => {
  assert.equal(gateOf("A1/A2").revalidateAfterDays, 365, "税率每年可能变");
  assert.ok(gateOf("A6").revalidateAfterDays! > 0, "NKBA 指南有修订历史");
  assert.equal(gateOf("E1").revalidateAfterDays, undefined, "做完了就是做完了");
});

test("每一项都说清了错了会怎样", () => {
  for (const g of LAUNCH_GATES) {
    assert.ok(g.why.length > 20, `${g.id} 缺少影响说明`);
    assert.ok(g.env.startsWith("VERIFIED_"), `${g.id} 的变量名应统一前缀`);
  }
});

// ── 单项判定 ──────────────────────────────────────────────────────────────

test("未设置 → 未核实", () => {
  const r = evaluateGate(gateOf("A6"), {}, NOW);
  assert.equal(r.status, "unverified");
  assert.match(r.detail, /VERIFIED_NKBA_CLEARANCES/);
});

test("写 true 不算核实 —— 日期才回答得了「什么时候核的」", () => {
  const r = evaluateGate(gateOf("A6"), { VERIFIED_NKBA_CLEARANCES: "true" }, NOW);
  assert.equal(r.status, "unverified");
  assert.match(r.detail, /YYYY-MM-DD/);
});

test("非法或未来日期不算核实", () => {
  for (const v of ["2026-13-45", "昨天", "2026/08/06", "2027-01-01"]) {
    assert.equal(
      evaluateGate(gateOf("A6"), { VERIFIED_NKBA_CLEARANCES: v }, NOW).status,
      "unverified",
      `${v} 不该通过`,
    );
  }
});

test("合法日期 → 已核实，并给出距复核到期的天数", () => {
  const r = evaluateGate(gateOf("A1/A2"), { VERIFIED_TAX_RATES: "2026-08-01" }, NOW);
  assert.equal(r.status, "verified");
  assert.equal(r.verifiedOn, "2026-08-01");
  assert.equal(r.daysUntilRevalidation, 360);
});

test("过了复核周期 → stale，且 stale 不算通过", () => {
  // 税率 365 天复核；2025-01-01 核的，到 2026-08-06 已经过期
  const r = evaluateGate(gateOf("A1/A2"), { VERIFIED_TAX_RATES: "2025-01-01" }, NOW);
  assert.equal(r.status, "stale");
  assert.equal(isPassing(r), false, "过期的核实等于没核实");
  assert.match(r.detail, /超过 365 天复核周期/);
});

test("没有复核周期的项，核实一次长期有效", () => {
  const r = evaluateGate(gateOf("E1"), { VERIFIED_AUTH_MODEL: "2020-01-01" }, NOW);
  assert.equal(r.status, "verified");
  assert.equal(r.daysUntilRevalidation, undefined);
});

// ── 逃生口 ────────────────────────────────────────────────────────────────

test("逃生口必须逐项声明，不能一把全关", () => {
  const env = { LAUNCH_GATES_ACKNOWLEDGED: "A6" };
  assert.equal(evaluateGate(gateOf("A6"), env, NOW).status, "acknowledged");
  // 别的项不受影响
  assert.equal(evaluateGate(gateOf("G4"), env, NOW).status, "unverified");

  // 没有「全关」这种写法
  const wildcard = { LAUNCH_GATES_ACKNOWLEDGED: "*" };
  assert.equal(evaluateGate(gateOf("A6"), wildcard, NOW).status, "unverified");
  const truthy = { LAUNCH_GATES_ACKNOWLEDGED: "true" };
  assert.equal(evaluateGate(gateOf("A6"), truthy, NOW).status, "unverified");
});

test("逗号分隔多项，容忍空格", () => {
  const env = { LAUNCH_GATES_ACKNOWLEDGED: " A6 , G4 " };
  assert.equal(evaluateGate(gateOf("A6"), env, NOW).status, "acknowledged");
  assert.equal(evaluateGate(gateOf("G4"), env, NOW).status, "acknowledged");
  assert.equal(evaluateGate(gateOf("E1"), env, NOW).status, "unverified");
});

// ── 启动检查 ──────────────────────────────────────────────────────────────

test("生产环境有未核实的阻断项 → 抛错", () => {
  assert.throws(
    () => assertLaunchReady({ NODE_ENV: "production" }, NOW),
    LaunchGatesNotMet,
  );
});

test("报错信息要能直接照着做：说清哪几项、为什么、怎么声明", () => {
  try {
    assertLaunchReady({ NODE_ENV: "production" }, NOW);
    assert.fail("应该抛错");
  } catch (e) {
    const msg = (e as Error).message;
    for (const id of ["A1/A2", "A6", "E1", "G4"]) assert.ok(msg.includes(id), `缺 ${id}`);
    assert.match(msg, /VERIFIED_NKBA_CLEARANCES=YYYY-MM-DD/);
    assert.match(msg, /LAUNCH_BLOCKERS\.md/);
    assert.match(msg, /LAUNCH_GATES_ACKNOWLEDGED=/);
    // 非阻断项不该出现在拦截理由里
    assert.ok(!msg.includes("VERIFIED_RETENTION_CRON"));
  }
});

test("非生产环境不拦 —— 本地开发照常跑", () => {
  assert.doesNotThrow(() => assertLaunchReady({}, NOW));
  assert.doesNotThrow(() => assertLaunchReady({ NODE_ENV: "development" }, NOW));
});

test("阻断项全部核实后放行；非阻断项未核实不影响启动", () => {
  const env = allVerified();
  delete env["VERIFIED_RETENTION_CRON"];
  delete env["VERIFIED_GENERIC_CATALOG"];
  assert.doesNotThrow(() => assertLaunchReady(env, NOW));
});

test("阻断项过期同样拦下 —— 不能靠一次核实吃三年", () => {
  const env = allVerified({ VERIFIED_TAX_RATES: "2025-01-01" });
  assert.throws(() => assertLaunchReady(env, NOW), LaunchGatesNotMet);
});

test("显式承担风险后可以启动", () => {
  assert.doesNotThrow(() => assertLaunchReady({
    NODE_ENV: "production",
    LAUNCH_GATES_ACKNOWLEDGED: "A1/A2,A6,E1,G4",
  }, NOW));
});

// ── 启动提示 ──────────────────────────────────────────────────────────────

test("有待办时逐项列出，并标明阻断与否", () => {
  const lines = launchGateReport({}, NOW).join("\n");
  assert.match(lines, /6 项待办/);
  assert.match(lines, /4 项会阻断生产启动/);
  assert.match(lines, /🚫 \[A6\]/);
  assert.match(lines, /⚠️\s*\[B6\]/);
  assert.match(lines, /LAUNCH_BLOCKERS\.md/);
});

test("全部通过时只报一行，但临近复核会提醒", () => {
  const clean = launchGateReport(allVerified(), NOW);
  assert.equal(clean.length, 1);
  assert.match(clean[0]!, /全部已核实/);

  // 税率核实于 360 天前 → 还有 5 天到期，应该提醒
  const soon = launchGateReport(allVerified({ VERIFIED_TAX_RATES: "2025-08-11" }), NOW);
  assert.ok(soon.some((l) => /A1\/A2.*还有 \d+ 天需复核/.test(l)), soon.join("\n"));
});

test("显式承担风险的项在启动日志里留痕", () => {
  const lines = launchGateReport({ LAUNCH_GATES_ACKNOWLEDGED: "A6" }, NOW).join("\n");
  assert.match(lines, /⚑ \[A6\]/);
  assert.match(lines, /显式承担风险/);
});

// ── 运营端点视图 ──────────────────────────────────────────────────────────

test("摘要给出 ready 与逐项状态", () => {
  const notReady = launchGateSummary({}, NOW);
  assert.equal(notReady.ready, false);
  assert.equal(notReady.gates.length, 6);
  assert.ok(notReady.gates.every((g) => g.why.length > 0));

  const ready = launchGateSummary(allVerified(), NOW);
  assert.equal(ready.ready, true);
});

// ── A4 的取值收口 ─────────────────────────────────────────────────────────

test("A4：新的日期变量是权威，旧的 true 开关继续认", () => {
  assert.equal(genericCatalogVerified({}), false);
  assert.equal(genericCatalogVerified({ VERIFIED_GENERIC_CATALOG: "2026-08-01" }), true);
  // 旧配置不能因为改造而静默失效
  assert.equal(genericCatalogVerified({ GENERIC_CATALOG_VERIFIED: "true" }), true);
  assert.equal(genericCatalogVerified({ GENERIC_CATALOG_VERIFIED: "false" }), false);
});
