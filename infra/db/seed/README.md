# 食物库种子数据（`infra/db/seed/`）

本目录存放**食物库种子** `food_items.seed.json`，由 `apps/api/prisma/seed.ts` 幂等载入数据库表 `food_items`。

> ⚠️ **数字必须可溯源**：本样例集**不虚构成千条数据**。仅收录「数值广为人知、可公开溯源」的常见中式食物，
> 用于打通数据链路与本地联调；**扩充到 ≥500 条需由客户提供有授权的数据集**（见下文）。

---

## 1. 当前样例集

| 项 | 说明 |
| --- | --- |
| 条数 | **57 条**（可覆盖主食 / 家常菜 / 外卖常见 / 饮品 / 零食 / 水果 / 蔬菜 / 蛋白 八大类） |
| 计量口径 | 每 **100g 可食部**：`kcalPer100g`（kcal）、`protein`/`fat`/`carbs`/`fiber`/`sugar`（g）、`sodium`（mg） |
| 份量单位 | `servingUnits` 提供「个/碗/杯/片/袋/块/根/只…」等自然份量 + 每单位克数（结构见 §3） |
| 落库映射 | 种子 `source: "local"`（来源标记）→ 数据库 `food_items.source = 'builtin'` |

### 数据来源性质

- 数值为**面向大众公开、被广泛引用的中国食物成分参考值**（《中国食物成分表》体系常见条目）
  与**常见连锁餐饮公开营养信息**的**四舍五入近似值**，**非官方逐条抄录**。
- 所有数值均为**估算口径**。不同烹饪方式、品牌、配比差异可达 **±20%**。

### 精度使用建议（重要）

- 本数据集**仅用于日常饮食记录与趋势参考**。
- **不得**作为医疗、营养诊断、处方或任何临床决策依据。
- 产品内相应位置需保留免责声明（对应 PRD US-04 / R1.5）。

### 当前样例集的已知缺口

- **未覆盖**微量营养素全字段（`calcium`/`iron`/`potassium`/`vitamin_d`/`b12`/`magnesium`）——留空，待二期按需补全。
- **未覆盖**条形码（`barcode`）——二期扫码功能依赖 Open Food Facts 等授权数据源。

---

## 2. 扩充到 ≥500 条所需的数据源与授权要求

对应架构文档 **D6** 与 PRD **Q8**。落地前需客户确认：

1. **数据来源**（择一或组合）：
   - 采购/授权《中国食物成分表》相关**标准版数据**；
   - 取得权威开放数据集（如 Open Food Facts，注意其 **ODbL** 许可与署名义务）的授权；
   - 由客户自有营养团队依据标准方法自建。
2. **授权形式**：需明确**商用授权范围**、署名要求、二次分发限制。
3. **字段完备性**：批量数据集应至少提供每 100g 的 `kcal / protein / fat / carb`，理想提供微量营养素与份量单位。
4. **可溯源要求**：每条数据建议保留来源标识（可写入 `source` 字段或新增来源列），便于审计。
5. **导入方式**：扩充数据可直接替换/追加到 `food_items.seed.json` 的 `items[]`，或新增同结构文件后由载入脚本读取。

> **红线**：禁止为了凑数而编造营养数值。宁可样例集小，也不引入不可溯源的数字。

---

## 3. `serving_units` 字段写法示例

`serving_units` 是 JSON 数组，元素结构（对应架构 §3.3）：

```jsonc
{
  "unit": "碗",        // 必填：份量单位（个/碗/杯/片/袋/份/支…），1–10 字
  "grams": 300,        // 必填：该单位对应克数（> 0）
  "isDefault": true,   // 可选：默认选中单位（每项至多 1 个 true）
  "label": "一中碗"    // 可选：展示别名，≤20 字
}
```

**换算规则**（引擎 / 服务端统一）：

```text
kcal = kcal_per_100g × (选定克数 ÷ 100)
选定克数 = 该单位默认克数（grams）或用户自定义克数
```

**示例**：

```json
[
  { "unit": "个", "grams": 60 },
  { "unit": "碗", "grams": 300, "isDefault": true, "label": "一中碗" },
  { "unit": "片", "grams": 20 }
]
```

`default_serving_grams` 会由载入脚本自动取「`isDefault: true`（缺省取第一个）」的 `grams`，冗余一份便于排序与快捷默认。

---

## 4. 载入方式

```bash
# 载入（幂等，可反复执行）
npm run db:seed -w @qsh/api
```

载入脚本以 `(name, source='builtin', created_by_user_id IS NULL)` 为业务键做 `findFirst → update/create`，
重复执行不会产生重复行。

---

## 5. 版权与许可

- 本样例集由项目组整理，随项目代码一并发布（与仓库许可一致）。
- 若后续引入第三方数据集，请在**本文件追加**：数据集名称、来源链接、许可类型、署名文本、获取日期。

## 6. 第三方数据集署名（2026-09-12 引入）

### 6.1 Open Food Facts（182 条，source='openfoodfacts'）

- 来源：https://world.openfoodfacts.org （官方 API v2，区域=中国大陆/中国香港/中国台湾）
- 许可：**Open Database License (ODbL) 1.0**
- 署名文本：数据 © Open Food Facts contributors，ODbL 1.0 许可
- 义务：对外发布使用本库的产品需注明来源，并以同许可开放衍生数据库
- 获取日期：2026-09-12；采集脚本：`fetch-off-items.mjs`（原始数据存 `food_items.openfoodfacts.raw.json`）

### 6.2 USDA FoodData Central SR Legacy（128 条精选，source='usda'）

- 来源：https://fdc.nal.usda.gov （FDC API，SR Legacy 数据集）
- 许可：**Public Domain**（美国联邦政府作品，无署名义务，仍建议注明）
- 署名文本：数据来源 USDA FoodData Central (SR Legacy)
- 获取日期：2026-09-12 ~ 09-15（分三轮扩量）；采集脚本：`fetch-usda-items.mjs` / `fetch-usda-round2.mjs` / `fetch-usda-round3.mjs`，
  精选与中文翻译映射：`usda_zh_map.json`（人工挑选 + 人工翻译，营养数值原样保留）

### 6.3 数据引入纪律

- 严禁从《中国食物成分表》（人民卫生出版社，版权作品）批量复制数据
- 严禁编造营养数值；所有引入数据必须可溯源到上述来源之一，并在 `_meta.sources` 中登记
- 三源合并脚本：`merge-seeds.mjs`（幂等，本地样例优先级最高）
