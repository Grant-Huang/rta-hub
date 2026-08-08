# 产品编码通用规则

## 编码结构

```
{柜型代码}{宽度}[{高度}]-{材质?}-{门板花色?}
```

## 后缀规则

| 后缀 | 含义 | 示例 |
|------|------|------|
| `-BOX` | 柜体（单独） | B12-PLY-BOX |
| `-DOOR` | 门板/柜门（单独） | B12-MNW-DOOR |
| 无后缀，有材质+花色 | 组合件（柜体+门板） | B12-PLY-MNW |

## 材质代码

| 代码 | 含义 |
|------|------|
| PLY | 夹板 (Plywood) |
| PB | 刨花板 (Particle Board) |

## 门板花色代码

| 代码 | 含义 |
|------|------|
| MNW | 胭脂木 (Melamine Natural Wood) |
| PGW | 高光白 (PET Glossy White) |
| WSS | 白Shaker (White Shaker) |
| SSW | 窄边Shaker (Slim Shaker White) |

## 柜型代码（各厂商不同，需查阅厂商文档）

常见前缀：
- `B` - 地柜 (Base)
- `W` - 吊柜 (Wall)
- `SB` - 水槽柜 (Sink Base)
- `3DB/2DB` - 抽屉地柜 (Drawer Base)
- `PC` - 高柜/储藏柜 (Pantry Cabinet)
- `BBC` - 转角柜 (Blind Corner Base)
- `BLS` - 旋转柜 (Lazy Susan)
- `WF` - 封板/收口条 (Filler)
- `TK` - 踢脚板 (Toe Kick)
