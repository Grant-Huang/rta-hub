/**
 * 运营工具（公司发现）用的类型。
 *
 * 业务领域实体在 src/domain/types.ts —— 这里只保留 src/ops/ 抓取管线需要的类型。
 * v0.3 的 EmailDraft / ChatMessage / DesignRequirements 已随群发功能一并移除
 * （见 REQUIREMENTS 第 10 节）。
 */

export interface Lead {
  id: string;
  companyName: string;
  contactName?: string;
  email: string;
  phone?: string;
  city?: string;
  province?: string;
  website: string;
  sourceUrl: string;
  foundAt: string;
}
