/**
 * 平面文件存储 —— 原子写与唯一约束（PRE_LAUNCH_CHECKLIST E7、G1）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonCollection, UniqueConstraintError } from "../src/store/json-store.js";

interface Row { id: string; dedupeKey?: string; name?: string }

function newCollection(name = "rows.json"): { col: JsonCollection<Row>; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "rta-store-"));
  return { col: new JsonCollection<Row>(path.join(dir, name)), dir };
}

test("插入后持久化，重新加载可读回", async () => {
  const { col, dir } = newCollection();
  await col.insert({ id: "a", name: "A" });
  await col.insert({ id: "b", name: "B" });

  const reloaded = new JsonCollection<Row>(path.join(dir, "rows.json"));
  assert.equal(reloaded.all().length, 2);
  assert.equal(reloaded.byId("a")!.name, "A");
});

test("写入是原子的：不留临时文件", async () => {
  const { col, dir } = newCollection();
  await col.insert({ id: "a" });
  await col.update("a", { name: "changed" });
  const files = readdirSync(dir);
  assert.deepEqual(files, ["rows.json"], `残留了临时文件：${files.join(", ")}`);
  assert.ok(JSON.parse(readFileSync(path.join(dir, "rows.json"), "utf-8")));
});

test("重复 id 被拒绝", async () => {
  const { col } = newCollection();
  await col.insert({ id: "a" });
  await assert.rejects(() => col.insert({ id: "a" }), UniqueConstraintError);
});

test("唯一约束在数据层兜底 —— 计费去重键不依赖应用代码判重", async () => {
  const { col } = newCollection();
  col.addUniqueKey("dedupeKey", (r) => r.dedupeKey);
  await col.insert({ id: "e1", dedupeKey: "k1" });
  await assert.rejects(
    () => col.insert({ id: "e2", dedupeKey: "k1" }),
    (e: unknown) => e instanceof UniqueConstraintError && e.constraintName === "dedupeKey",
  );
  // 不同键正常插入
  await col.insert({ id: "e3", dedupeKey: "k2" });
  assert.equal(col.all().length, 2);
});

test("并发写不丢数据（写队列串行化）", async () => {
  const { col, dir } = newCollection();
  await Promise.all(
    Array.from({ length: 50 }, (_, i) => col.insert({ id: `r${i}`, name: `n${i}` })),
  );
  assert.equal(col.all().length, 50);
  const onDisk = JSON.parse(readFileSync(path.join(dir, "rows.json"), "utf-8")) as Row[];
  assert.equal(onDisk.length, 50, "落盘条数应与内存一致");
});

test("并发写中的唯一冲突不会卡死后续写入", async () => {
  const { col } = newCollection();
  col.addUniqueKey("dedupeKey", (r) => r.dedupeKey);
  const results = await Promise.allSettled([
    col.insert({ id: "a", dedupeKey: "same" }),
    col.insert({ id: "b", dedupeKey: "same" }),
    col.insert({ id: "c", dedupeKey: "other" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  // 队列没卡死
  await col.insert({ id: "d", dedupeKey: "third" });
  assert.equal(col.all().length, 3);
});

test("update 也走唯一约束校验", async () => {
  const { col } = newCollection();
  col.addUniqueKey("dedupeKey", (r) => r.dedupeKey);
  await col.insert({ id: "a", dedupeKey: "k1" });
  await col.insert({ id: "b", dedupeKey: "k2" });
  await assert.rejects(() => col.update("b", { dedupeKey: "k1" }), UniqueConstraintError);
  // 更新自己不算冲突
  await col.update("a", { dedupeKey: "k1", name: "x" });
  assert.equal(col.byId("a")!.name, "x");
});

test("remove 与 reset", async () => {
  const { col } = newCollection();
  await col.insert({ id: "a" });
  assert.equal(await col.remove("a"), true);
  assert.equal(await col.remove("a"), false);
  await col.reset([{ id: "z" }]);
  assert.equal(col.all().length, 1);
});
