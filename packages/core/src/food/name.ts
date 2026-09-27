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
 *
 * ## 两套口径：去重 ≠ 展示（**不要合并这两者**）
 *
 * - **去重口径**（`foodQualifiers` / `foodDedupKey`）：尽量**保守**，品牌**必须保留** ——
 *   `婴儿配方奶粉(力多精1，雀巢)` 与 `婴儿配方奶粉(爱儿乐，惠氏)` 是**不同产品**，
 *   若把品牌也算作「无区分意义」，`merge-seeds` 会把它们归一成一条、**丢数据**。
 * - **展示口径**（`foodDisplayQualifiers`）：在去重结果之上再滤掉**对用户没有区分意义**的
 *   品牌 / 营养声称 / 产地补充 —— 把 `力多精1`、`无糖`、`高钙`、`日本种` 当作中性标签
 *   展示给用户是误导（它们不是形态/口味/部位规格）。
 *
 * 因此本模块同时提供两个入口；`GET /api/foods/search` 的 `qualifier` 走**展示口径**。
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
 * **品牌 / 产品线** token（**仅用于展示口径**）。
 *
 * 出现这些时，括号内容标识的是厂商或系列（`力多精1` / `安儿宝A+` / `帕玛拉特`…），
 * 对用户判断「这是不是我要的那份食物」没有帮助，不应作为中性区分标签展示。
 *
 * ⚠️ 与 `isMeaninglessQualifier`（去重口径）**故意分开**：去重时品牌必须保留
 * （否则 `merge-seeds` 会把不同品牌奶粉归一成一条、丢数据）。详见模块头部说明。
 */
const DISPLAY_BRAND_TOKENS = new Set<string>([
  '力多精',
  '爱力大',
  '美素力',
  '美素乐',
  '美素高',
  '爱儿乐',
  '健儿乐',
  '爱儿素',
  '安儿宝',
  '安儿健',
  '安婴宝',
  '安婴儿',
  '安婴乐',
  '适体健',
  '帕玛拉特',
  '百乐宝',
]);

/** 品牌 / 产品线的**阶段 / 型号后缀**（`力多精1`→`力多精`、`安儿宝A+`→`安儿宝`、`美素力H`→`美素力`）。 */
const DISPLAY_MODEL_SUFFIX = /(?:[0-9]+|[A-Za-z]\+?)$/;

/**
 * **营养声称 / 强化** token（如 `无糖` / `無加糖` / `高钙` / `高蛋白` / `强化锌` / `低钠`）。
 *
 * 这些是营销 / 强化语义，不是食物的形态/口味/部位规格，展示时不标注。
 * ⚠️ 不包含 `脱脂` / `部分脱脂` / `全脂` / `加糖` —— 它们是**配方规格**（`脱脂牛乳` 与
 * `全脂牛乳` 热量差异很大），是有区分意义的，必须保留（避免过度收紧）。
 */
const DISPLAY_NUTRITION_CLAIM = new Set<string>([
  '无糖',
  '無加糖',
  '无加糖',
  '無添加糖',
  '无添加糖',
  '高钙',
  '高蛋白',
  '高钙高铁',
  '强化锌',
  '强化钙',
  '强化铁',
  '低钠',
  '钙',
  '锌',
  '铁',
  '硒',
]);

/** **产地 / 品种来源**补充（如 `日本种`）：与食物形态无关，展示时不标注。 */
const DISPLAY_ORIGIN = new Set<string>(['日本种']);

/**
 * 判断一个 token 是否属于**展示噪声**（品牌 / 营养声称 / 产地补充）。
 *
 * 仅用于**展示口径**：`foodQualifiers` 已先滤掉「去重口径」的无区分意义词，
 * 本判断在其结果之上再做一次「值不值得给用户看」的过滤。
 *
 * @param token 单个括号限定词
 * @returns `true` = 展示噪声（不应作为区分标签）；`false` = 有展示价值
 */
export function isDisplayNoiseQualifier(token: string): boolean {
  const t = String(token).trim();
  if (t === '') {
    return true;
  }
  // 品牌带型号后缀（力多精1 / 安儿宝A+ / 美素力H）：去掉后缀再比对（只看品牌，不改原 token）。
  const stripped = t.replace(DISPLAY_MODEL_SUFFIX, '');
  return (
    DISPLAY_BRAND_TOKENS.has(t) ||
    (stripped !== '' && stripped !== t && DISPLAY_BRAND_TOKENS.has(stripped)) ||
    DISPLAY_NUTRITION_CLAIM.has(t) ||
    DISPLAY_ORIGIN.has(t)
  );
}

/**
 * 提取食物名里**值得展示**的区分词（展示口径）。
 *
 * 在 `foodQualifiers`（去重口径）结果之上，再滤掉品牌 / 营养声称 / 产地补充 ——
 * 保留形态 (`干`/`鲜`/`煮`)、口味 (`香辣味`)、部位规格 (`袋装`/`脱脂`/`全能装`)。
 *
 * 例：
 * - `婴儿配方奶粉(力多精1，雀巢)` → `[]`（品牌，无展示价值）
 * - `幼儿奶粉(美素高，袋装)` → `['袋装']`（品牌去掉，规格保留）
 * - `牛乳(脱脂，帕玛拉特)` → `['脱脂']`（规格保留，品牌去掉）
 * - `蘑菇(干)` → `['干']`（形态保留）
 *
 * @param name 食物名
 * @returns 展示用区分词数组（按出现顺序；无则为 `[]`）
 */
export function foodDisplayQualifiers(name: string): string[] {
  return foodQualifiers(name).filter((token) => !isDisplayNoiseQualifier(token));
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
