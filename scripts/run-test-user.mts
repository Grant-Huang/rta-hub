/**
 * CLI：跑测试用户 Agent 套件（写入 DATA_DIR，标题 test-）。
 * 用法：npx tsx scripts/run-test-user.mts [count=3]
 */
import "dotenv/config";

process.env.SITE_PASSWORD_DISABLED = process.env.SITE_PASSWORD_DISABLED || "true";
if (!process.env.ADMIN_TOKEN) process.env.ADMIN_TOKEN = "dev-admin";

const count = Math.min(8, Math.max(1, Number(process.argv[2] ?? 3)));

async function main() {
  const { createApp, getAppContext } = await import("../src/server.js");
  const { createTestLlmClient, createCriticLlmClient } = await import("../src/agents/llm-client.js");
  const { createAppFetch, startAndRunTestSuite, suggestedPointIds } =
    await import("../src/testing/index.js");

  const sessionRunId = `test_cli_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const app = await createApp({
    origin: "test",
    runId: sessionRunId,
  });
  const ctx = getAppContext();
  const call = createAppFetch(app);

  console.log(`[run-test-user] count=${count} dataDir=${ctx.dataDir}`);
  console.log(`[run-test-user] suggested: ${suggestedPointIds().join(", ")}`);
  console.log(`[run-test-user] user LLM: ${createTestLlmClient() ? "test/ollama" : "deterministic"}`);
  console.log(`[run-test-user] critic LLM: ${createCriticLlmClient() ? "critic" : "deterministic"}`);

  const run = await startAndRunTestSuite(
    {
      call,
      repos: ctx.repos,
      dataDir: ctx.dataDir,
      sessionRunId,
      userLlm: createTestLlmClient(),
      criticLlm: createCriticLlmClient() ?? undefined,
    },
    {
      count,
      pointIds: suggestedPointIds(),
      runCritic: true,
      accountId: "ca_test",
    },
  );

  console.log(`\n[run-test-user] ${run.id} → ${run.status}`);
  for (const c of run.cases) {
    console.log(
      `  ${c.status.padEnd(7)} ${c.title}  conv=${c.conversationId ?? "—"}  notes=${c.notes.join(",")}`,
    );
    if (c.errors.length) console.log(`           errors: ${c.errors.join("; ")}`);
  }
  if (run.critiqueSummary) console.log("\n[critic]\n" + run.critiqueSummary);

  const failed = run.cases.filter((c) => c.status === "failed").length;
  if (run.status !== "completed" || failed === run.cases.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
