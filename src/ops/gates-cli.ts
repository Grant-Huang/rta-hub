/**
 * 上线闸门检查 CLI —— `pnpm gates`。
 *
 * 不启动服务就能回答「现在还差哪几项才能上线」。部署脚本可以直接用它的退出码
 * 做门禁：有阻断项未通过就返回 1。
 */
import "dotenv/config";
import { evaluateLaunchGates, isPassing, launchGateReport } from "../app/launch-gates.js";

const OWNER_LABEL = { engineering: "工程", operations: "运营", legal: "法务" } as const;

function main(): void {
  const results = evaluateLaunchGates();
  const blocking = results.filter((r) => r.gate.blocking);
  const ready = blocking.every(isPassing);

  console.log("\n上线闸门（台账见 docs/LAUNCH_BLOCKERS.md）\n");

  for (const r of results) {
    const mark = { verified: "✓", stale: "⏰", unverified: "✗", acknowledged: "⚑" }[r.status];
    const kind = r.gate.blocking ? "阻断" : "告警";
    console.log(`${mark} [${r.gate.id}] ${r.gate.title}`);
    console.log(`    ${kind}　${OWNER_LABEL[r.gate.owner]}　${r.gate.env}`);
    console.log(`    ${r.detail}`);
    if (!isPassing(r)) console.log(`    影响：${r.gate.why}`);
    console.log();
  }

  console.log(launchGateReport().join("\n"));
  console.log();

  if (!ready) {
    const missing = blocking.filter((r) => !isPassing(r)).map((r) => r.gate.id);
    console.log(`结论：**尚不可上线**。阻断项：${missing.join("、")}`);
    console.log("生产环境（NODE_ENV=production）启动会被拒绝。\n");
    process.exit(1);
  }
  console.log("结论：阻断项已全部通过，可以上线。\n");
}

main();
