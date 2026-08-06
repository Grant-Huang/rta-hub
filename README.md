# RTA-Hub

多租户橱柜设计与报价市场平台。

这个项目原来是 [let-it-flow](https://github.com/Grant-Huang/let-it-flow) 里的一个 demo
（`examples/cabinet-quotes-scraper`），现在独立成主项目：**以 npm 包的方式依赖
`@meso.ai/let-it-flow`，不再内置在 let-it-flow 仓库里。**

## 这是什么

客户在一个对话框里跟系统讨论厨房橱柜设计，可以 `@` 任意一家已入驻的橱柜公司——每家公司背后是
绑定自己产品规格库的独立 Agent。客户上传户型图后，系统自动排布方案、生成正视/俯视（地柜层、
顶柜层）/侧视四张视图，客户在会话里改到满意后确认，系统把报价单发到该公司登记的报价邮箱。

平台是两维多租户的：

- **供给侧**：橱柜公司租户，`companyId` 严格隔离，各自维护产品规格与定价规则。
- **需求侧**：消费者账号（`consumer`）与专业/建商账号（`trade`），后者支持多项目并行与贸易价可见性。

冷启动阶段，尚无公司入驻时客户仍能基于平台共享的 `GenericCatalog` 拿到一份通用预估
（`EstimateDraft`）——它没有 `companyId`，因此在结构上就不可能被发送给任何公司。

## 文档

需求与场景是当前阶段的主交付物，开发按这两份文档推进：

- [docs/REQUIREMENTS.md](./docs/REQUIREMENTS.md) —— 需求说明书 v0.4（架构、定价模型、版本化与可追溯、数据模型、FR-1~13、商业模式）
- [docs/SCENARIOS.md](./docs/SCENARIOS.md) —— 场景走查 A–I（公司入驻、冷启动、@ 路由、四视图、比价发送、贸易账号、销售信号、招商引流）
- [docs/COMPANY_DISCOVERY.md](./docs/COMPANY_DISCOVERY.md) —— 公司发现与招商引流的合规路径（爬虫定位、社媒获客、CASL/邮件列表）
- [docs/RENDERING.md](./docs/RENDERING.md) —— 二维视图渲染方案（脸型文法、模板清单、SKU 规则匹配、规范文档核实结果）
- [docs/PRE_LAUNCH_CHECKLIST.md](./docs/PRE_LAUNCH_CHECKLIST.md) —— 上线前检查清单（税率核验、FR-2 抽样量、合规、安全、计费）
- [docs/DEV_PLAN.md](./docs/DEV_PLAN.md) —— MVP-1 开发计划与进度（已完成 / 未完成 / 下一轮顺序）
- `rta-generic-spec/` —— 北美 RTA 橱柜通用规范参考（尺寸/编码/构造/替代逻辑），核实结果见 RENDERING.md 附录

## 运行

```bash
pnpm install
cp .env.example .env
pnpm test          # 330 passing
pnpm typecheck
pnpm dev           # 打开 http://localhost:8790
```

试点数据：`Maple Ridge Cabinetry`（31 个型号，别名 `枫岭橱柜`/`Maple Ridge`/`MRC`）。
演示账号通过 `X-Account-Id` 头传入：`ca_demo_consumer`（消费者）、`ca_demo_trade`（贸易）。

运营工具（公司发现，手动触发）：

```bash
pnpm ops:prospects help
```

## 当前代码状态

**MVP-1 与 MVP-2 均已完成**，294 个测试用例覆盖。端到端可跑：

聊需求 → `@` 公司问规格 → 上传户型图 → 补齐尺寸 → **自动排布出四视图** →
生成报价（含税/运费/折扣/有效期）→ **多公司比价** → 发送前披露 → 确认 →
**HTML 邮件发送**（CID 内嵌四视图）→ 计费。

- **定价**：(型号 × 门板价格组) 价格矩阵 + 修饰项 + 折扣 + 运费 + 分省税，整数分运算
- **排布**：1/4 英寸整数 DP 装箱，只用该公司真实存在的离散尺寸。目标函数分三类处理——
  **硬约束**（NKBA 人体工程与安全：落台区、洗碗机距离、工作三角）否决方案不参与权衡；
  **软约束**（宽度节奏、避免凑数窄柜、上下对缝、对称性、填缝条位置）进目标函数；
  **成本**（柜数、浪费）是其中一项而非全部。水槽对齐窗中心、高频区用抽屉柜、
  支持按墙段局部重算
- **渲染**：声明式脸型文法 → 绝对英寸坐标 → SVG，四视图带尺寸标注；
  面框/无框与门板覆盖方式是渲染参数
- **可追溯**：规格版本化（发布后不可变）+ 报价价格快照 + 审计事件（含内容哈希）
- **FR-8**：LLM 产出的任何价格字段一律丢弃；6 项硬校验；发送闸门是服务端状态机
- **FR-2**：模板导入 + 入驻会话（待确认队列，零静默失败）+ 8 项量化验收；
  第二家试点公司完全通过导入路径建立，验证"新公司上线不需要改代码"
- **合规**：CASL（身份、退订在发送路径强制校验）+ PIPEDA（同意、披露、留存、数据主体权利）
- **多租户**：`companyId` 作用域在数据访问层强制，有跨租户负向测试

尚未做的（属 MVP-3）：PDF 报价单、trade 多项目界面、计费争议运营界面、
户型与方案的持久化。详见 [docs/DEV_PLAN.md](./docs/DEV_PLAN.md)。

原先的"搜索公司列表 → 勾选 → 群发询价"功能**已删除**（与 CASL 冲突）；抓取能力保留为
运营侧的公司发现工具（`src/ops/`，手动触发），用途见
[docs/COMPANY_DISCOVERY.md](./docs/COMPANY_DISCOVERY.md)。

## 关于发送邮件（请先读这段）

- **发送闸门有两道，且第一道在服务端。**
  1. 报价必须由客户显式确认，`Quote.status` 经服务端状态机迁移到 `confirmed` 才可发送——
     **请求体里带 `confirm: true` 不起任何作用**（旧实现的这个做法等于把闸门交给调用方）。
  2. `.env` 里 `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` 任一为空，发送即为 dry-run，
     不发起任何网络请求。
- 发送前会向客户列出**将要提供给该公司的全部信息**（PIPEDA 意义上的第三方披露，见 FR-13）。
- **这不是营销邮件群发工具。** 客户端的多选群发功能已删除。加拿大 CASL 对商业电子消息有
  严格的同意与身份披露要求；向抓取来的地址批量发推广邮件通常不合规。合法获客路径是
  「社媒广告 → 企业主动注册邮件列表」，见 [docs/COMPANY_DISCOVERY.md](./docs/COMPANY_DISCOVERY.md)。
