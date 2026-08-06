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
pnpm test          # 135 passing
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

MVP-1 的**核心链路已实现并有测试覆盖**（135 个用例）：定价引擎（价格矩阵 / 折扣 / 运费 /
分省税）、规格版本化与报价价格快照、FR-8 硬校验与服务端发送闸门、线索计费的去重与争议、
租户隔离、确定性 `@` 路由、脸型文法渲染。

**尚未完成**（仍属 MVP-1）：FR-2 入驻规格录入会话、LLM 编排层、`EstimateDraft`、
真实邮件发送、持久化接线、邮件列表注册、数据留存任务。逐项进度与下一轮顺序见
[docs/DEV_PLAN.md](./docs/DEV_PLAN.md) 第 3 节。

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
