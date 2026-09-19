# 数据许可与署名（Data License & Attribution）

本仓库的**代码**采用 [MIT 许可](./LICENSE)（`LICENSE` 文件仅覆盖代码，不含数据）。
但 `infra/db/seed/` 下的**食物营养数据**是混合来源，各部分许可不同，**不可整体按 MIT 使用**。

## 一览

| 数据文件 | 条数 | 来源 | 许可 | 使用要求 |
| --- | --- | --- | --- | --- |
| `food_items.seed.json` 中 `source: "builtin"` 的条目 | 57 | 本项目自建（依据《中国食物成分表》公开数值等公开资料整理） | **CC BY 4.0** | 署名「轻生活（qingshenghuo）项目」 |
| `food_items.seed.json` 中 `source: "openfoodfacts"` 的条目<br>`food_items.openfoodfacts.raw.json` | 258 | [Open Food Facts](https://world.openfoodfacts.org) | **ODbL 1.0**（Open Database License） | **必须署名**「© Open Food Facts contributors」<br>**衍生数据库须以 ODbL 1.0 同许可分发** |
| `food_items.seed.json` 中 `source: "usda"` 的条目<br>`usda_zh_map.json`、`food_items.usda.candidates.json` | 128 | [USDA FoodData Central — SR Legacy](https://fdc.nal.usda.gov) | **公有领域**（美国政府作品） | 无需授权；本项目另行完成中文译名与归类 |
| `met_activities.*.json`、`habit_templates.*.json` | — | 本项目自建（MET 值参考 Compendium of Physical Activities） | **CC BY 4.0** | 署名「轻生活（qingshenghuo）项目」 |

## 具体义务（重要）

### 1. Open Food Facts 衍生数据库（ODbL 1.0）

`food_items.openfoodfacts.raw.json` 与 `food_items.seed.json` 中的 `openfoodfacts` 条目构成
**由 Open Food Facts 数据库衍生的数据库**。ODbL 要求：

- **署名**：保留「© Open Food Facts contributors」署名与本许可说明（本文件即满足；程序内「关于/数据来源」页亦须展示）；
- **同许可（Share-Alike）**：若你对外分发**这个衍生数据库**（含改版后的 `food_items.seed.json`），
  必须以 **ODbL 1.0** 分发该数据库，且不得额外施加技术限制；
- **不覆盖代码**：ODbL 只约束数据库，不影响本项目 MIT 代码的许可。

> 实践含义：你可以自由使用本项目的代码；但**如果把种子数据一起对外分发**，
> 请保留 `infra/db/seed/README.md` 与 `DATA-LICENSE.md`，并保持数据部分为 ODbL。

### 2. USDA SR Legacy

属于美国政府作品，无版权（公有领域）。本项目对其中 128 条完成了**中文译名与中式归类**，
这部分翻译与归类的著作权归本项目（CC BY 4.0）。使用时不强制署名，但欢迎保留来源说明。

### 3. 医疗免责

本仓库中的任何营养数值与建议**不构成医疗建议**。产品免责声明见 [README](./README.md#免责声明)。

## 运行时在线获取（Phase C：在线食物库兜底 / 条码扫码）

除了随仓库分发的种子数据，后端还提供**在线兜底**能力：当本地食物库无匹配结果（或用户主动选择）
时，服务端会**只读代理** [Open Food Facts](https://world.openfoodfacts.org) 的公开 REST 接口：

- **发送内容最小化**：仅发送**搜索词**（`cgi/search.pl?search_terms=…`）或**条码**
  （`api/v2/product/{code}.json`）；**绝不**发送 `userId`、令牌、体重 / 健康等任何个人信息；
- **自定义 User-Agent**：请求带匿名 UA（`qingshenghuo/0.1 (…+https://world.openfoodfacts.org)`），
  这是 OFF 的礼貌抓取要求；
- **超时与降级**：单次请求 6s 超时；失败 / 超时 → 如实返回「在线暂时不可用」并回退到本地结果，
  不阻断用户（绝不 500）；
- **缓存**：命中结果在服务端内存缓存 10 分钟（上限 200 条），减少对 OFF 的请求；
- **落库**：当用户点「加入并记录」时，归一化后的记录写入本地 `food_items`
  表，`source = "openfoodfacts"`（与种子数据同源同库）。

**许可影响**：上述运行时写入使 `food_items` 表成为**由 Open Food Facts 派生的数据库**的一部分。
因此 ODbL 1.0 的**署名**与**同许可（Share-Alike）**义务同样适用于这份**含运行时 OFF 行的数据库**：

- 署名：保留「© Open Food Facts contributors」（本文件、程序内「数字是怎么来的 / 数据来源」页均已展示）；
- 分发含 OFF 行的 `food_items` 库时，须以 **ODbL 1.0** 分发该数据库，且不得额外施加技术限制。

> 实践含义：代码（MIT）不受影响；离线使用 / 自用无额外义务；
> **仅当你把 `food_items` 数据一起对外分发时**才需承担上述 ODbL 责任。

---

## 若你要替换掉 ODbL 数据

如果你希望整个仓库（含数据）都能以 MIT/闭源方式分发，只需删除
`food_items.openfoodfacts.raw.json`、`usda_zh_map.json` 等外部来源文件，
并把 `food_items.seed.json` 中 `source` 非 `builtin` 的条目移除后重新生成种子：

```bash
# 过滤出仅自建条目（builtin），其余来源按需替换为你自己的合规数据源
node -e "
const fs=require('fs');
const p='infra/db/seed/food_items.seed.json';
const d=JSON.parse(fs.readFileSync(p,'utf8'));
d.items=d.items.filter(i=>i.source==='builtin');
fs.writeFileSync(p,JSON.stringify(d,null,2));
console.log('剩余 builtin 条目：',d.items.length);
"
```

（注意：食物库会缩到 57 条，需自行补充数据源。）
