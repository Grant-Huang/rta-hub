/**
 * 平面文件持久化 —— MVP 阶段的存储（REQUIREMENTS FR-12、第 9 节 MVP-3 再迁数据库）。
 *
 * 两个必须做对的点（PRE_LAUNCH_CHECKLIST E7）：
 *   1. **原子写**：写临时文件 + rename，避免进程中断留下半个 JSON。
 *   2. **写串行化**：同一文件的并发写用 promise 链排队，避免后写覆盖先写。
 */
import { mkdirSync, readFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Collection<T> {
  all(): T[];
  find(pred: (item: T) => boolean): T | undefined;
  filter(pred: (item: T) => boolean): T[];
  insert(item: T): Promise<T>;
  update(id: string, patch: Partial<T>): Promise<T>;
  upsert(item: T): Promise<T>;
  remove(id: string): Promise<boolean>;
  /** 仅用于测试：清空并重载。 */
  reset(items?: T[]): Promise<void>;
}

interface Identified {
  id: string;
}

export class JsonCollection<T extends Identified> implements Collection<T> {
  private items: T[] = [];
  /** 写队列：保证同一集合的写操作串行执行。 */
  private writeChain: Promise<unknown> = Promise.resolve();
  /** 唯一约束：字段名 → 取值函数。插入/更新时强制检查。 */
  private readonly uniqueKeys: { name: string; key: (item: T) => string | undefined }[] = [];

  constructor(private readonly filePath: string) {
    this.load();
  }

  /**
   * 声明一个唯一约束。这是数据层兜底（FR-7 的去重键、租户唯一性等），
   * 不依赖调用方"记得判重"。
   */
  addUniqueKey(name: string, key: (item: T) => string | undefined): this {
    this.uniqueKeys.push({ name, key });
    return this;
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.items = [];
      return;
    }
    const raw = readFileSync(this.filePath, "utf-8").trim();
    this.items = raw ? (JSON.parse(raw) as T[]) : [];
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items, null, 2), "utf-8");
    renameSync(tmp, this.filePath); // 同一文件系统内 rename 是原子的
  }

  /** 把一次修改排入写队列，返回其结果。 */
  private enqueue<R>(fn: () => R): Promise<R> {
    const next = this.writeChain.then(() => {
      const result = fn();
      this.persist();
      return result;
    });
    // 即使某次写失败，也不能让整条链卡死
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private assertUnique(candidate: T, ignoreId?: string): void {
    for (const { name, key } of this.uniqueKeys) {
      const value = key(candidate);
      if (value === undefined) continue;
      const clash = this.items.find((i) => i.id !== ignoreId && key(i) === value);
      if (clash) {
        throw new UniqueConstraintError(name, value);
      }
    }
  }

  all(): T[] {
    return [...this.items];
  }

  find(pred: (item: T) => boolean): T | undefined {
    return this.items.find(pred);
  }

  filter(pred: (item: T) => boolean): T[] {
    return this.items.filter(pred);
  }

  byId(id: string): T | undefined {
    return this.items.find((i) => i.id === id);
  }

  insert(item: T): Promise<T> {
    return this.enqueue(() => {
      if (this.items.some((i) => i.id === item.id)) {
        throw new UniqueConstraintError("id", item.id);
      }
      this.assertUnique(item);
      this.items.push(item);
      return item;
    });
  }

  update(id: string, patch: Partial<T>): Promise<T> {
    return this.enqueue(() => {
      const idx = this.items.findIndex((i) => i.id === id);
      if (idx < 0) throw new Error(`No record found with id=${id}`);
      const merged = { ...this.items[idx]!, ...patch } as T;
      this.assertUnique(merged, id);
      this.items[idx] = merged;
      return merged;
    });
  }

  upsert(item: T): Promise<T> {
    return this.enqueue(() => {
      const idx = this.items.findIndex((i) => i.id === item.id);
      this.assertUnique(item, item.id);
      if (idx < 0) this.items.push(item);
      else this.items[idx] = item;
      return item;
    });
  }

  remove(id: string): Promise<boolean> {
    return this.enqueue(() => {
      const idx = this.items.findIndex((i) => i.id === id);
      if (idx < 0) return false;
      this.items.splice(idx, 1);
      return true;
    });
  }

  reset(items: T[] = []): Promise<void> {
    return this.enqueue(() => {
      this.items = [...items];
    });
  }
}

export class UniqueConstraintError extends Error {
  constructor(
    readonly constraintName: string,
    readonly value: string,
  ) {
    super(`Unique constraint violation (${constraintName}): ${value}`);
    this.name = "UniqueConstraintError";
  }
}
