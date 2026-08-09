/**
 * 访问控制阶段（design vs production）—— 控制 admin 对跨厂 L1 的写权限。
 *
 * 见 docs/ACCESS_CONTROL.md §3.2。
 *
 * 解析优先级：
 *   1. `ACCESS_STAGE`（或别名 `RTA_STAGE`）显式值
 *   2. `NODE_ENV === "production"` → production
 *   3. 默认 `design`（本地 / 测试宽松）
 */
export type AccessStage = "design" | "production";

const DESIGN_ALIASES = new Set(["design", "development", "dev"]);
const PRODUCTION_ALIASES = new Set(["production", "prod"]);

/**
 * 从环境变量解析访问阶段。
 * 非法显式值回落默认（不静默当成 production）。
 */
export function resolveAccessStage(
  env: NodeJS.ProcessEnv = process.env,
): AccessStage {
  const raw = (env["ACCESS_STAGE"] ?? env["RTA_STAGE"] ?? "")
    .trim()
    .toLowerCase();
  if (PRODUCTION_ALIASES.has(raw)) return "production";
  if (DESIGN_ALIASES.has(raw)) return "design";
  if (env["NODE_ENV"] === "production") return "production";
  return "design";
}

/** 当前进程的访问阶段（多数调用点用此）。 */
export function currentAccessStage(): AccessStage {
  return resolveAccessStage();
}

export function isProductionAccessStage(stage: AccessStage): boolean {
  return stage === "production";
}
