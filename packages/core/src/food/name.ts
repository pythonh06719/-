/**
 * 食物名归一化与「区分词」提取 —— **单一真源**。
 *
 * 用途（两个场景共用同一份规则，避免各处各写一份导致漂移）：
 * 1. **跨源去重**（`infra/db/seed/merge-seeds.ts`）：判断两个条目是不是「同一条」；
 * 2. **搜索区分**（`GET /api/foods/search`）：跨来源同物异名时，把**区分词**标给用户看
 *    （如搜「蘑菇」→ 蘑菇(干) / 蘑菇(鲜蘑) / 蘑菇（罐头）），而不是三条都叫「蘑菇」只能靠热量猜。
 *
 * ## 核心概念：区分词（括号限定词）
 *
 * 中文食物名常把「形态 / 口味 / 部位 / 规格」写在括号里，这些**是不同食物**：
 * - 形态：`干` / `鲜` / `罐头` / `油浸` / `煮` / `蒸` / `生` / `浸`
 * - 口味：`烧烤` / `香辣` / `原味`
 * - 部位/规格：`北` / `南` / `内酯` / `白皮` / `红皮` / `土鸡` / `干切面` / `白` / `黄`
 *
 * 而另一些括号内容**没有区分意义**，比对时应丢弃：
 * - 统计标记：`均值` / `代表值` / `平均`
 * - 纯测量值：以数字开头（百分比 `38％`、温度 `150℃`、时长 `10分`、度数 `55度`）
 * - 品牌/产地补充说明：`…牌` 后缀，或 `雀巢` / `中国` 等
 *
 * ⚠️ 规则默认值是 **保留**（宁可多留，也不误杀）：
 * 只有明确命中「无区分意义」清单的才丢弃 —— 历史上曾因「把括号内容全部删掉」导致
 * `紫菜(干)` 与 `紫菜（鲜）` 归一为同名、干制品整类在库里搜不到。
 * 同时真同名（如 `苹果` 与 `苹果`）仍会归一，不会因为放宽而把真重复也收进来。
 */

/** 括号组（中/英/方括号，半/全角，开闭可混用）。 */
const BRACKET = /[（(［[]([^）)］\]]*)[）)］\]]/g;
/** 「无区分意义」：统计标记。 */
const MARKER_TOKEN = /^(代表值|均值|平均|平均值|mean|avg|约|大概|近似)$/i;
/** 「无区分意义」：纯测量值（以数字开头：38％ / 150℃ / 10分 / 55度）。 */
const MEASURE_TOKEN = /^\d/;
/** 「无区分意义」：品牌后缀（「可淇牌」「三元牌」）。 */
const BRAND_SUFFIX = /牌$/;
/** 「无区分意义」：常见品牌 / 产地补充说明（平台把这些写在括号里，与主体无区分意义）。 */
const BRAND_OR_ORIGIN = new Set<string>([
  '雀巢',
  '美赞臣',
  '肯德基',
  '惠氏',
  '亨氏',
  '阿香婆',
  '卡夫',
  '中国',
  '台湾',
  '以色列',
]);

/**
 * 判断一个括号限定词是否「无区分意义」（去重/比对时丢弃）。
 *
 * @param token 单个括号限定词
 * @returns `true` = 无区分意义（丢弃）；`false` = 有区分意义（保留）
 */
export function isMeaninglessQualifier(token: string): boolean {
  return (
    MARKER_TOKEN.test(token) ||
    MEASURE_TOKEN.test(token) ||
    BRAND_SUFFIX.test(token) ||
    BRAND_OR_ORIGIN.has(token)
  );
}

/**
 * 提取食物名里**有区分意义**的括号限定词（形态 / 口味 / 部位 / 规格）。
 *
 * 用于在 UI 上标注「区分词」，让用户自己分辨跨来源同物异名的条目 ——
 * 我们**不替用户合并**（不同来源口径不同，热量本就不同）。
 *
 * 例：`蘑菇(干)`→`['干']`；`豆腐（南豆腐）`→`['南豆腐']`；`苹果`→`[]`。
 *
 * @param name 食物名
 * @returns 区分词数组（按出现顺序；无括号或无区分词时为 `[]`）
 */
export function foodQualifiers(name: string): string[] {
  const raw = String(name);
  const qualifiers: string[] = [];
  for (const match of raw.matchAll(BRACKET)) {
    // 括号内容按中文/英文分隔符拆成多个限定词（如「草莓味，卡夫牌」→「草莓味」「卡夫牌」）
    for (const part of (match[1] ?? '').split(/[，,、/]/)) {
      const token = part.trim();
      if (token !== '' && !isMeaninglessQualifier(token)) {
        qualifiers.push(token);
      }
    }
  }
  return qualifiers;
}

/**
 * 归一化食物名（**跨源去重的比对键**）。
 *
 * 取「括号前主体 + **有区分意义**的括号限定词」，去空白与常用标点、转小写。
 * 例：`紫菜(干)`→`紫菜干`（**≠** `紫菜（鲜）`→`紫菜鲜`）；`苹果`→`苹果`（真同名仍归一）。
 *
 * ⚠️ 不要与 `food/identity.ts` 的 `normalizeFoodName` 混淆：那个是**显示名归一化**
 * （折叠空白 + 转小写，用于常吃榜 / 多样性计数的「同一种食物」判定），
 * 本函数是**跨源去重的比对键**（要处理括号区分词）。两者语义不同，各自独立。
 *
 * @param name 食物名
 * @returns 归一化后的比对键
 */
export function foodDedupKey(name: string): string {
  const raw = String(name);
  const base = (raw.split(/[（(［[]/)[0] ?? '').trim();
  return (base + foodQualifiers(raw).join(''))
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，,、。.·・\-—_/％%]/g, '')
    .toLowerCase();
}
