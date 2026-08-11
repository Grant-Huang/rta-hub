# 厨房户型模板库 (Kitchen Layout Templates)

## 概述

本目录包含5种北美住宅常见厨房户型的标准模板，供客户参考和上传。所有模板均为手绘风格的户型图（floorplan），不含橱柜设计，仅标注房间结构。

## 模板列表

### 1. 单壁型 (One-Wall / Straight Kitchen)

**文件：** `one-wall-kitchen-floorplan.png`

**特点：**
- 单面墙布局，长度通常 144" (12'-0")
- 最节省空间，适合小户型
- 常见于：公寓 (Condo)、小型单元

**适用场景：**
- 开放式厨房
- 工作室/单身公寓
- 空间受限的厨房改造

**标注要求：**
- 墙长：144"
- 窗户：36" 宽，距西墙 48"
- 门：32" 宽
- 上下水/水槽：24" 宽，距西墙 72"
- 层高：96" (8'-0")

---

### 2. U 型 (U-Shaped Kitchen)

**文件：** `u-shaped-kitchen-floorplan.png`

**特点：**
- 三面墙形成U型
- 台面空间最大化
- 常见于：标准尺寸厨房 (10'x10' 或更大)

**适用场景：**
- Single Family House
- Townhouse
- 中大型厨房

**标注要求：**
- 北墙：144" (12'-0")
- 西墙：120" (10'-0")
- 东墙：120" (10'-0")
- 窗户：48" 宽，位于北墙中央
- 门：32" 宽，东墙距北 88"
- 上下水/水槽：24" 宽，东墙距北 36"
- 层高：96" (8'-0")

---

### 3. L 型 + 岛台 (L-Shape + Island Kitchen)

**文件：** `l-island-kitchen-floorplan.png`

**特点：**
- L型墙面 + 中央岛台
- 现代住宅最流行布局
- 岛台可用于备餐、用餐、收纳

**适用场景：**
- 开放式厨房
- 现代 Single Family House
- 需要社交空间的厨房

**标注要求：**
- 北墙：144" (12'-0")
- 东墙：120" (10'-0")
- 岛台：72" x 36"
- 岛台与墙面净距：≥42"（符合NKBA标准）
- 窗户：36" 宽，北墙距西 48"
- 门：32" 宽，东墙距北 88"
- 上下水/水槽：24" 宽，东墙距北 36"
- 层高：96" (8'-0")

---

### 4. 双排/走廊型 (Galley / Corridor Kitchen)

**文件：** `galley-kitchen-floorplan.png`

**特点：**
- 两面平行墙，中间留通道
- 高效利用窄长空间
- 工作三角形最紧凑

**适用场景：**
- Townhouse（联排别墅）
- 窄长型厨房
- 需要最大化存储空间

**标注要求：**
- 北墙：144" (12'-0") x 24" 深
- 南墙：144" (12'-0") x 24" 深
- 通道宽度：48" (最小 42")
- 窗户：36" 宽，北墙距西 48"
- 门：32" 宽，西端
- 上下水/水槽：24" 宽，北墙距西 96"
- 层高：96" (8'-0")

---

### 5. L 型标准 (L-Shaped Kitchen)

**文件：** `sample-floorplan.png` / `sample-floorplan-minimal.png`

**特点：**
- 两面墙形成L型
- 灵活度高，适应性强
- 可选是否加岛台

**适用场景：**
- 最通用的厨房布局
- 各种房型均适用

---

## 图例说明 (Legend)

所有模板使用统一图例：

- **窗户 (Window)**: ═══ (平行线)
- **门 (Door)**: ⌒ (弧线，显示开启方向)
- **上下水/水槽 (Plumbing/Sink)**: ○○ (两个圆圈)
- **岛台 (Island)**: ⟋⟋⟋ (斜线填充矩形)
- **墙体 (Wall)**: ▬▬ (粗黑线)
- **指北针 (North)**: ↑N (带方位标识)

## 尺寸标注规范

### 英寸与英尺
- 144" = 12'-0"
- 120" = 10'-0"
- 96" = 8'-0"

### 关键尺寸
- **墙长**: 通常 120"-180" (10'-15')
- **通道宽度**: 最小 42"，推荐 48"
- **门宽**: 标准 32"-36"
- **窗宽**: 标准 36"-48"
- **上下水**: 24" (水槽柜标准宽度)
- **岛台**: 常见 60"-84" 长，30"-42" 宽
- **层高**: 标准 96" (8'), 高层可达 108"-120"

## 使用说明

### 客户使用
1. 选择最接近自己厨房的户型模板
2. 在模板基础上标注实际尺寸
3. 手绘修改（如果尺寸不同）
4. 上传到系统进行户型识别

### 前端集成
```typescript
import { INTAKE_SAMPLES } from './samples/catalog.ts';

// 获取所有户型模板
const floorplanSamples = INTAKE_SAMPLES.filter(s => s.role === 'floorplan');

// 显示给用户选择
<SampleGallery samples={floorplanSamples} />
```

### 安全验证
- 所有文件名通过 `isAllowedSampleFile()` 白名单验证
- 禁止路径穿越攻击
- 仅允许 `/src/samples/` 目录下的文件

## NKBA 标准参考

所有模板遵循 NKBA (National Kitchen & Bath Association) 标准：

- **工作通道**: 最小 42"
- **工作三角**: 冰箱-水槽-灶台总距 12'-26'
- **水槽与洗碗机**: 距离 ≤36"
- **灶台净空**: 左右各 ≥12"
- **冰箱净空**: 开门后 ≥15"

## 文件清单

```
src/samples/
├── catalog.ts                        # 模板目录定义
├── one-wall-kitchen-floorplan.png    # 单壁型
├── u-shaped-kitchen-floorplan.png    # U型
├── l-island-kitchen-floorplan.png    # L型+岛台
├── galley-kitchen-floorplan.png      # 双排/走廊型
├── sample-floorplan.png              # L型标准（详细版）
├── sample-floorplan-minimal.png      # L型标准（简化版）
└── sample-design-sketch.jpg          # 设计想法草图示例
```

## 更新日志

### 2026-08-11
- ✅ 新增 4 种常见厨房户型模板
- ✅ 更新 catalog.ts，添加中英文标签和说明
- ✅ 统一手绘风格，符合现有 sample-floorplan.png 样式
- ✅ 所有模板通过白名单验证

---

## 贡献指南

### 新增模板要求
1. **风格一致**: 手绘风格，清晰可读
2. **标注完整**: 墙长、门窗、上下水、层高
3. **符合标准**: 遵循 NKBA 人体工程学标准
4. **文件命名**: `{type}-kitchen-floorplan.png`
5. **更新 catalog.ts**: 添加中英文标签

### 测试验证
```bash
# 类型检查
pnpm typecheck

# 白名单验证
import { isAllowedSampleFile } from './samples/catalog';
console.assert(isAllowedSampleFile('one-wall-kitchen-floorplan.png'));
```

---

**维护者**: RTA-Hub Team  
**最后更新**: 2026-08-11
