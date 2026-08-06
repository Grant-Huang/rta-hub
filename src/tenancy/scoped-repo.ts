/**
 * 租户作用域数据访问 —— REQUIREMENTS 3.4、FR-9。
 *
 * 隔离要求是**双重防线**：
 *   第一道 = 应用层记得按 companyId 过滤；
 *   第二道 = 数据访问层**强制**加过滤条件，应用层忘了也漏不出去。
 *
 * 本文件是第二道。所有跨租户读写都必须经过 `TenantScope`，它在每次查询上
 * 强制附加 companyId 谓词，并在写入时校验 payload 的 companyId 与作用域一致。
 */

export class TenantIsolationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "TenantIsolationError";
  }
}

interface CompanyScoped {
  companyId: string;
}

/**
 * 一个绑定到具体 companyId 的数据视图。
 *
 * 拿到 TenantScope 就等于拿到「只能看见这家公司数据」的能力；
 * 没有任何方法能从中读出别家租户的数据。
 */
export class TenantScope {
  constructor(readonly companyId: string) {
    if (!companyId) {
      throw new TenantIsolationError("TenantScope 必须绑定非空 companyId", "EMPTY_TENANT");
    }
  }

  /** 过滤：强制附加 companyId 谓词，调用方的谓词只能进一步收窄。 */
  filter<T extends CompanyScoped>(items: readonly T[], pred: (item: T) => boolean = () => true): T[] {
    return items.filter((item) => item.companyId === this.companyId && pred(item));
  }

  find<T extends CompanyScoped>(items: readonly T[], pred: (item: T) => boolean): T | undefined {
    return items.find((item) => item.companyId === this.companyId && pred(item));
  }

  /** 按 id 取单条；命中了但属于别的租户，视为「不存在」而不是「无权限」。 */
  byId<T extends CompanyScoped & { id: string }>(items: readonly T[], id: string): T | undefined {
    return this.find(items, (i) => i.id === id);
  }

  /**
   * 写入前校验。payload 的 companyId 必须与作用域一致——
   * 防止「用 A 公司的会话写入一条标着 B 公司的数据」。
   */
  assertOwned<T extends CompanyScoped>(item: T, what = "记录"): T {
    if (item.companyId !== this.companyId) {
      throw new TenantIsolationError(
        `跨租户写入被拒绝：${what} 属于 ${item.companyId}，当前作用域为 ${this.companyId}`,
        "CROSS_TENANT_WRITE",
      );
    }
    return item;
  }

  /** 读取后校验（用于那些绕过 filter 直接拿到实体的路径）。 */
  assertReadable<T extends CompanyScoped>(item: T | undefined, what = "记录"): T {
    if (!item) {
      throw new TenantIsolationError(`${what}不存在`, "NOT_FOUND");
    }
    if (item.companyId !== this.companyId) {
      // 对外统一报「不存在」，不泄露「存在但属于别人」这一信息
      throw new TenantIsolationError(`${what}不存在`, "NOT_FOUND");
    }
    return item;
  }
}

/**
 * `Conversation` 对公司数据是**只读引用**，不会写入对方租户
 * （REQUIREMENTS 3.4 的单向读写规则）。
 *
 * 这个类型让「只读引用」在类型层面可见：拿到它只能读规格，不能写任何公司侧数据。
 */
export class ReadOnlyCompanyView {
  private readonly scope: TenantScope;
  constructor(companyId: string) {
    this.scope = new TenantScope(companyId);
  }
  get companyId(): string {
    return this.scope.companyId;
  }
  read<T extends CompanyScoped>(items: readonly T[], pred: (item: T) => boolean = () => true): T[] {
    return this.scope.filter(items, pred);
  }
  readById<T extends CompanyScoped & { id: string }>(items: readonly T[], id: string): T | undefined {
    return this.scope.byId(items, id);
  }
}
