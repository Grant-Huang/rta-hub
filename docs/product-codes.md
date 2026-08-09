# 产品编码：系统层语义（L0）

> **本文只描述平台通用约定**（售卖单元、后缀、组合件、独立件）。  
> **柜型前缀**（`B12` vs `DB12` vs `3DB12` vs `NW-B12`）属于**各厂商 CodingRules**，  
> 见 [KNOWLEDGE_LAYERS.md](./KNOWLEDGE_LAYERS.md)。不要把某厂前缀表写进本文当作全局真理。

---

## 1. 编码常见外形（描述性，非强制语法）

许多 RTA 厂的可读码接近：

```
{柜型段}{宽度}[{高度}][-{材质}][-{花色}][-{BOX|DOOR}]
```

但：

- 柜型段**各厂不同**；
- 有的厂不用材质/花色段，而用「逻辑型号 × 门板价格组」；
- 有的厂用完全不同的命名空间（如 `NW-B12`）。

系统解析时：**先看规格声明的 `sellUnit` / `ModuleType`，再看后缀启发式。**

---

## 2. 售卖单元（Sell Unit）—— 系统知识

| SellUnit | 含义 | 如何识别（启发式，可被规格声明覆盖） |
|----------|------|--------------------------------------|
| `box` | 仅柜体 | 码中**明确**带 `-BOX`（大小写不敏感） |
| `door` | 仅门板/抽屉面 | 码中**明确**带 `-DOOR` 或 `-door` |
| `combo` | 柜体 + 门的组合件 | **无**拆分后缀，且同时带有**柜体材质标识**与**门板花色标识**；或逻辑柜型按「型号×门板组」销售（默认） |
| `standalone` | 独立使用件 | `ModuleType` 为 filler / panel / toeKick / crown / leg，或规格声明 |

### 2.1 后缀规则（全平台一致）

| 后缀 | 含义 | 示例 |
|------|------|------|
| `-BOX` | 柜体（单独卖） | `B12-PLY-BOX` |
| `-DOOR` | 门板/柜门（单独卖） | `B12-MNW-DOOR` |
| 无上述后缀，且有材质 + 花色 | **组合件**（柜体和柜门组合） | `B12-PLY-MNW` |

> 用户原话落地：**明确说明 `-BOX` 的是柜体；明确标明 `-door`/`-DOOR` 的是门板；  
> 既有柜体材质、又有门板花色标识、又无拆分后缀的，是组合件。**

### 2.2 独立件（必须分开）

填缝条、踢脚、收口板、顶线、塑料地脚等：

- **不是** combo，也**不要**按 BOX/DOOR 规则去拆；
- 报价/BOM **单独成区**（REQUIREMENTS FR-6.1 / FR-6.2）；
- 识别优先靠 `ModuleType` / 能力 `trim`，不靠「猜前缀是不是 WF」。

---

## 3. 常用 token 表（系统常用词典，厂商可扩展）

厂商可在 `CompanyCodingRules.materialTokens` / `finishTokens` 覆盖或增补。  
下列仅作**默认词典**，用于启发式识别「有没有材质段 / 花色段」。

### 3.1 柜体材质（示例）

| 代码 | 含义 |
|------|------|
| PLY | 夹板 (Plywood) |
| PB | 刨花板 (Particle Board) |

### 3.2 门板花色（示例）

| 代码 | 含义 |
|------|------|
| MNW | Melamine Natural Wood |
| PGW | PET Glossy White |
| WSS | White Shaker |
| SSW | Slim Shaker White |

---

## 4. 柜型前缀 —— 不要写死在系统层

下列**仅作阅读文档时的行业口语举例**，**不是**平台权威映射：

- 有的厂：`B` 地柜、`W` 吊柜、`SB` 水槽、`3DB` 三抽……  
- 有的厂：`DB12` 才是抽屉地柜，与 `B12` 不同。  
- 有的厂：`NW-B12` / `BL-B12` 自带厂前缀。

**权威来源**：该 `companyId` 当前 `ProductSpecVersion` 的 `CodingRules` + 型号表。  
跨厂对齐只通过 **能力标签**（`ModuleCapabilities`），见 [CATALOG_MODEL.md](./CATALOG_MODEL.md)。

---

## 5. 与报价的关系（摘要）

- `combo`（含「逻辑型号 × 门板组」）：柜体行计价，门作从属明细「含在柜体价内」（FR-6.1）。  
- 目录里真实存在的 `box` / `door` SKU：按独立可售行处理；**禁止**用 PriceGroup 冒充 BOX/DOOR。  
- `standalone`：trim 区；箱体板材加价规则见 §3.5.5.1（地脚等可不加）。

完整架构：[KNOWLEDGE_LAYERS.md](./KNOWLEDGE_LAYERS.md)。
