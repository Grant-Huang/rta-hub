# 橱柜公司发现与管理 —— 设计讨论记录（v0.1）

## 背景

初期需要获取加拿大橱柜公司的联系信息，用于平台的冷启动和商务引流。`leads.ts` 提供了网络爬虫能力，但原本被设计成"消费者群发工具"——让用户直接给爬来的公司群发询价——这在 CASL（加拿大反垃圾邮件法）上不合规。

经讨论，重新定位为**运营数据管理工具**。

---

## 合规分析

### 原方案的问题（已否决）

**消费者直接群发给爬来的邮箱**
- ❌ CASL 违规：未经同意的商业电子信息
- ❌ 公司未知道平台存在
- ❌ 影响平台信誉

### 合法方案（已确认）

**社媒广告 → 企业主动注册 → 平台发邮件**
```
社媒广告（LinkedIn/Facebook）
  ↓ 企业主动点击
平台邮件列表注册表
  ↓ 企业主动填写、checkbox 同意
EmailSubscription { email, companyName, consentDate, consentChannel }
  ↓ 有明确同意记录
平台发邮件邀约入驻（合法）
```

CASL 要求满足：
- ✅ Express Consent：企业主动注册
- ✅ 同意记录可追溯：注册日期、IP、用户代理
- ✅ 每封邮件都有取消订阅链接

---

## 爬虫的重新定位

**不再用于**：消费者群发数据源

**改为用于**：
1. **社媒广告的受众定向**
   - 知道市场有 ~500 家橱柜公司
   - 在 Facebook/LinkedIn 上创建 Lookalike Audience
   - 按地理位置精准投放

2. **销售线索数据源**（CompanyMentionSignal）
   - 用户对话里 `@` 了一个未入驻公司 → 记录 CompanyMentionSignal
   - 销售查询：这个公司在我们市场库里吗？
   - 如果有 → 直接联系（已知渠道）
   - 如果没有 → 标记为"新发现机会"

3. **市场情报**
   - 橱柜行业有多少个玩家
   - 地区分布（哪些城市有多少家）
   - 用于投放策略调整

---

## 数据模型

### CompanyProspect（平面文件存储）

```json
{
  "companies": [
    {
      "id": "prospect_001",
      "name": "Maple Cabinetry Inc",
      "email": "sales@maple-cab.com",
      "website": "https://maple-cab.com",
      "phone": "+1-416-555-0123",
      "city": "Toronto",
      "province": "ON",
      "sourceType": "web_scrape",
      "importedAt": "2026-08-10T14:30:00Z",
      "lastUpdated": "2026-08-10T14:30:00Z",
      "status": "prospect",
      "notes": "RTA-style modular cabinets, mid-range pricing"
    },
    ...
  ]
}
```

**status 取值**：
- `prospect` —— 已发现，未接触
- `contacted` —— 已通过社媒/邮件列表接触
- `subscribed` —— 已主动注册邮件列表
- `archived` —— 停业/不适合

---

## 功能需求

> 本节是 [REQUIREMENTS.md](./REQUIREMENTS.md) **FR-12（公司发现与邮件列表）** 的展开，
> 编号与之对应：FR-12.1 ~ FR-12.4。端到端走查见 [SCENARIOS.md](./SCENARIOS.md) 场景 I。

### FR-12.1　爬虫导入（管理员后台）

- 管理员可手动触发爬虫：`pnpm run cli:import-companies`
- 爬虫检测重复（按 email）：
  - 已存在 → 更新 `lastUpdated`，保留原 `importedAt`
  - 新发现 → 创建新条目
- 爬取结果保存到 `data/companies.json`（平面文件）

### FR-12.2　公司库的 CRUD（管理员后台）

**查看**：
- 列表视图：过滤 by city / province / status
- 详情视图：公司完整信息 + 操作历史

**增加**：
- 手工录入新公司信息
- 来源标记为 `manual`

**修改**：
- 更新联系方式、备注等
- 记录修改时间 + 修改人

**删除**：
- 标记为 `archived` 而不是真删除
- 保留历史记录用于 CompanyMentionSignal 回溯

### FR-12.3　CompanyMentionSignal 回溯

- 用户对话里 `@` 了一个公司
- 系统自动查询 CompanyProspect 库
- 如果找到 → 记录该公司的 id 和渠道信息
- 如果没找到 → 标记为"新发现"，销售需跟进

### FR-12.4　社媒广告的数据导出

- 导出公司列表（CSV / JSON）用于：
  - Facebook Custom Audience（上传邮箱）
  - LinkedIn Sales Navigator（导入账户信息）
  - 地理位置统计表

---

## 实现优先级与时间表

### MVP-1（核心）
- ✅ 爬虫能工作（`pnpm run cli:import-companies`）
- ✅ `data/companies.json` 持久化
- ✅ CompanyMentionSignal 回溯查询

### MVP-2（运营便利）
- 🟡 管理员后台基础 UI（查看列表、增删改查）
- 🟡 导出功能（CSV for 社媒投放）

### MVP-3（优化）
- 🔵 导入/导出 UI
- 🔵 去重预览（导入前展示哪些是新、哪些是更新）
- 🔵 操作日志

---

## 与 REQUIREMENTS.md 的关系

**原 FR-10（冷启动通用层）**保持不变：
- 消费者可以不 @ 任何已入驻公司，获得 EstimateDraft

**新增的是商务流程**（不在原需求里）：
1. 平台运营用社媒广告引流
2. 企业主动访问平台 + 注册邮件列表 → 获得合法同意
3. 平台发邮件邀约入驻 FR-2
4. 公司入驻时 opt-in "接收消费者询价" → billingPlan.leadFeeEnabled = true

**不再涉及**：
- ❌ 消费者直接群发给任何邮箱列表
- ❌ 冷邮件营销

---

## CASL 合规清单

- ✅ 社媒广告是营销工具，不违规
- ✅ 企业主动点击 = 主动发起接触
- ✅ 邮件列表注册有明确 checkbox
- ✅ 注册表记录同意时间/IP/来源
- ✅ 每封邮件有取消订阅链接
- ✅ 不做任何冷邮件群发
- ✅ 退订请求 10 个工作日内处理

---

## 后续可能的演化方向

1. **数据库代替平面文件**（商家规模增长时）
   - CompanyProspect → 数据库表
   - 支持全文搜索、高级过滤

2. **自动邮件投递**（邮件列表集成）
   - 企业注册 → 自动发送欢迎邮件
   - 定时发送产品更新

3. **Webhook 集成**（CRM 同步）
   - 导出到 Salesforce / HubSpot
   - 销售在 CRM 里追踪这些 prospect

4. **API 透明度**（给销售赋能）
   - 销售可以查询某个公司的状态
   - 销售可以备注接触记录
