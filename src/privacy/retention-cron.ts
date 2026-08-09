/**
 * 留存清除定时任务（B6）—— 按间隔调用计划生成 + 执行。
 *
 * 环境变量：
 *   RETENTION_CRON_MS — 间隔毫秒；未设或 ≤0 则不启动（仍可手工 POST /retention/run）
 *   VERIFIED_RETENTION_CRON — 核实日期（YYYY-MM-DD），见 launch-gates
 */
import type { RetentionSweepResult } from "./retention.js";

export interface RetentionCronHandle {
  stop: () => void;
  /** 最近一次执行结果（若有）。 */
  lastResult: () => RetentionSweepResult | undefined;
}

export function startRetentionCron(input: {
  intervalMs: number;
  run: () => Promise<RetentionSweepResult>;
  log?: (line: string) => void;
}): RetentionCronHandle | undefined {
  if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) return undefined;
  const log = input.log ?? ((line: string) => console.log(line));
  let last: RetentionSweepResult | undefined;
  let running = false;

  const tick = async () => {
    if (running) {
      log("[retention-cron] previous sweep still running — skip");
      return;
    }
    running = true;
    try {
      last = await input.run();
      log(
        `[retention-cron] sweep done dryRun=${last.dryRun} ` +
          `conv=${last.conversationsDeleted} est=${last.estimatesDeleted} ` +
          `quoteDeId=${last.quotesDeIdentified} auditDel=${last.auditDeleted}`,
      );
    } catch (e) {
      log(`[retention-cron] sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, input.intervalMs);
  // 不阻止进程退出
  if (typeof timer === "object" && "unref" in timer) {
    (timer as NodeJS.Timeout).unref();
  }
  log(`[retention-cron] started intervalMs=${input.intervalMs}`);
  // 启动后稍后跑一次，避免与 seed/listen 抢 IO
  setTimeout(() => { void tick(); }, Math.min(5_000, input.intervalMs));

  return {
    stop: () => clearInterval(timer),
    lastResult: () => last,
  };
}

/** 从环境解析间隔；默认关闭（0）。生产可设 86400000（每天）。 */
export function retentionCronIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["RETENTION_CRON_MS"]?.trim();
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
