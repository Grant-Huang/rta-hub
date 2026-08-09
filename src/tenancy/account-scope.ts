/**
 * 客户账号作用域 —— 与 TenantScope 对称的需求侧第二道防线（FR-9）。
 *
 * Conversation / Quote / Estimate 等带 customerAccountId 的实体，
 * 查询必须经过本作用域，避免「记得按账号过滤」漏掉。
 */
import { TenantIsolationError } from "./scoped-repo.js";

interface AccountScoped {
  customerAccountId: string;
}

export class AccountScope {
  constructor(readonly accountId: string) {
    if (!accountId) {
      throw new TenantIsolationError("AccountScope 必须绑定非空 accountId", "EMPTY_ACCOUNT");
    }
  }

  filter<T extends AccountScoped>(
    items: readonly T[],
    pred: (item: T) => boolean = () => true,
  ): T[] {
    return items.filter((item) => item.customerAccountId === this.accountId && pred(item));
  }

  find<T extends AccountScoped>(
    items: readonly T[],
    pred: (item: T) => boolean,
  ): T | undefined {
    return items.find((item) => item.customerAccountId === this.accountId && pred(item));
  }

  byId<T extends AccountScoped & { id: string }>(
    items: readonly T[],
    id: string,
  ): T | undefined {
    return this.find(items, (i) => i.id === id);
  }

  assertOwned<T extends AccountScoped>(item: T, what = "记录"): T {
    if (item.customerAccountId !== this.accountId) {
      throw new TenantIsolationError(
        `跨账号写入被拒绝：${what} 属于 ${item.customerAccountId}，当前作用域为 ${this.accountId}`,
        "CROSS_ACCOUNT_WRITE",
      );
    }
    return item;
  }

  /** 对外统一报「不存在」，不泄露「存在但属于别人」。 */
  assertReadable<T extends AccountScoped>(item: T | undefined, what = "记录"): T {
    if (!item) {
      throw new TenantIsolationError(`${what}不存在`, "NOT_FOUND");
    }
    if (item.customerAccountId !== this.accountId) {
      throw new TenantIsolationError(`${what}不存在`, "NOT_FOUND");
    }
    return item;
  }
}
