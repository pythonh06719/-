/**
 * 食物搜索排序（**单一真源**：后端 `GET /api/foods/search` 与前端展示共用同一份规则）。
 *
 * ## 为什么要有这个模块
 *
 * 食物库从 443 条扩到 1773 条后，「先出来的是什么」决定了记录成功率：
 * - 跨来源同一食物（如 `蘑菇(干)` / `蘑菇(鲜蘑)` / `蘑菇（罐头）`）热量差异很大
 *   （干蘑菇 295 kcal / 100g vs 鲜蘑 24 kcal / 100g）；
 * - 旧排序 `orderBy: [{ isVerified: 'desc' }, { id: 'asc' }]` 是**退化排序**
 *   （`is_verified` 当前全为 0 → 实际就是按 id，等于「先入库的先出来」）。
 *
 * ## 排序口径：先结果相关，再结果完整，且不误导
 *
 * - 相关度（`ORDER_RANK`）：**前缀 > 子串 > 仅别名命中**；同档内按 `id` 升序（稳定分页）；
 * - 🔴 **红线：绝不按热量 / 任何营养字段排序** —— 排序里带营养高低就是变相的「好坏评价」，
 *   违反 PRD §7 无负罪感约束。本模块**不接收**营养字段，从类型上就排除了这种可能。
 * - 跨来源同物异名：**不合并**（各来源口径不同，合并即伪造数据），而是把
 *   **区分词**（形态 / 口味 / 部位规格，见 `food/name.ts`）标出来交给用户自己分辨。
 *
 * ## 为什么是纯函数
 *
 * 「排序」是纯计算：输入候选 + 关键词，输出有序 id 列表。放在 `packages/core`
 * 便于单测全覆盖，也保证前后端口径一致（NFR-11：同一套口径，不各写一份）。
 */

import { foodDisplayQualifiers } from './name';

/**
 * 相关度档位（**值越小越靠前**）。
 *
 * - `prefix`：名称 / 拼音**前缀**命中（最像「我要找的就是它」）；
 * - `substring`：名称 / 拼音**子串**命中（相关，但匹配位置靠后）；
 * - `alias`：只有**别名**命中（名称本身不含关键词，相关性最弱，排最后）。
 */
export const ORDER_RANK = {
  prefix: 0,
  substring: 1,
  alias: 2,
} as const;

/** 相关度档位类型。 */
export type FoodMatchRank = (typeof ORDER_RANK)[keyof typeof ORDER_RANK];

/** `GET /api/foods/search` 默认每页条数（前端「加载更多」按此步长翻页）。 */
export const FOOD_SEARCH_DEFAULT_PAGE_SIZE = 20;

/** 搜索参与排序的候选项（最小投影：排序只需要身份字段，不需要营养）。 */
export interface FoodSearchCandidate {
  /** 主键 */
  id: number;
  /** 食物名 */
  name: string;
  /** 拼音（可空） */
  namePinyin?: string | null;
  /** 别名（可空；DB 里是 JSON 数组，调用方负责解析） */
  aliases?: readonly string[] | null;
}

/** 排序结果（只带排序所需信息，**不含营养**，从接口上杜绝按热量排序）。 */
export interface FoodSearchRanked {
  /** 主键 */
  id: number;
  /** 相关度档位 */
  rank: FoodMatchRank;
  /** 区分词标注（展示口径，已滤除品牌/营养声称；如 `干` / `鲜蘑` / `烧烤`）；无区分词时为 `null` */
  qualifier: string | null;
}

/** 匹配前归一化：去所有空白 + 转小写（SQLite `LIKE` 与前端输入口径一致）。 */
function normalizeForMatch(value: string): string {
  return String(value).replace(/[\s\u3000]+/g, '').toLowerCase();
}

/**
 * 食物名的**区分词标注**：把有区分意义的括号限定词拼成展示串。
 *
 * 例：`蘑菇(干)`→`干`；`豆腐（南豆腐）`→`南豆腐`；`牛肉干（香辣味）`→`香辣味`；`苹果`→`null`。
 *
 * 走的是**展示口径**（`foodDisplayQualifiers`）：在去重口径之上再滤掉品牌 / 营养声称 / 产地
 * （如 `力多精1`、`无糖`、`日本种`），避免把厂商名或营销词当中性标签展示给用户。
 * 保留形态 / 口味 / 部位规格（`干` / `香辣味` / `脱脂` / `袋装`…）。
 *
 * @param name 食物名
 * @returns 区分词串；无展示用区分词时返回 `null`（UI 整块不渲染标签，不留无意义空格）
 */
export function foodQualifierLabel(name: string): string | null {
  const qualifiers = foodDisplayQualifiers(name);
  return qualifiers.length === 0 ? null : qualifiers.join('·');
}

/**
 * 计算单个候选对关键词的**相关度档位**（取所有信号里最好的一档）。
 *
 * 信号来源与档位：
 * - 名称前缀 / 拼音前缀 → `prefix`；
 * - 名称子串 / 拼音子串 → `substring`；
 * - 仅别名命中（名称、拼音都不含关键词）→ `alias`。
 *
 * ⚠️ 别名命中恒为 `alias` 档（即使别名是前缀匹配）：搜「番茄」时
 * `番茄炒蛋`（名称前缀）必须排在 `西红柿`（别名=番茄）前面。
 *
 * @param candidate 候选项
 * @param keyword 关键词（已 trim）
 * @returns 档位；关键词为空（浏览全部）时返回 `substring`（全部同级 → 由 id 兜底排序）；
 *          三个信号全不命中时返回 `alias`（排最后；调用方通常已用 SQL 过滤，理论上不出现）
 */
export function matchFoodRank(
  candidate: FoodSearchCandidate,
  keyword: string,
): FoodMatchRank {
  const kw = normalizeForMatch(keyword);
  if (kw === '') {
    // 无关键词 = 浏览全部：没有相关度可言，全部同档（`id` 升序兜底，稳定可分页）。
    return ORDER_RANK.substring;
  }

  const name = normalizeForMatch(candidate.name);
  const pinyin = normalizeForMatch(candidate.namePinyin ?? '');
  const aliases = (candidate.aliases ?? [])
    .map((alias) => normalizeForMatch(alias))
    .filter((alias) => alias !== '');

  let best: FoodMatchRank | null = null;
  const take = (rank: FoodMatchRank): void => {
    if (best === null || rank < best) {
      best = rank;
    }
  };

  if (name.startsWith(kw)) {
    take(ORDER_RANK.prefix);
  } else if (name.includes(kw)) {
    take(ORDER_RANK.substring);
  }

  if (pinyin.startsWith(kw)) {
    take(ORDER_RANK.prefix);
  } else if (pinyin.includes(kw)) {
    take(ORDER_RANK.substring);
  }

  // 别名：恒为最低优先档（见上方说明）。
  if (aliases.some((alias) => alias.startsWith(kw) || alias.includes(kw))) {
    take(ORDER_RANK.alias);
  }

  return best ?? ORDER_RANK.alias;
}

/**
 * 对候选集做**相关度排序**（纯函数、稳定）。
 *
 * 排序键：`rank` 升序 → `id` 升序。后者保证**稳定分页**：翻页不会漏条 / 重复条，
 * 也让同档内的顺序可预期（先入库的在前），避免每次搜索结果顺序抖动。
 *
 * @param candidates 候选项（应为 SQL 关键词过滤后的结果）
 * @param keyword 关键词
 * @returns 有序的排序结果（含区分词标注）
 */
export function rankFoodSearch(
  candidates: readonly FoodSearchCandidate[],
  keyword: string,
): FoodSearchRanked[] {
  const ranked: FoodSearchRanked[] = [];
  for (const candidate of candidates) {
    const rank = matchFoodRank(candidate, keyword);
    ranked.push({ id: candidate.id, rank, qualifier: foodQualifierLabel(candidate.name) });
  }
  // 稳定：先 rank 后 id（Array.prototype.sort 在 Node ≥ 11 稳定，但显式二级键更直白）。
  ranked.sort((a, b) => a.rank - b.rank || a.id - b.id);
  return ranked;
}

/**
 * 取排序结果里某一页的 id（供后端回表取完整行）。
 *
 * @param ranked `rankFoodSearch` 的输出
 * @param page 页码（从 1 开始）
 * @param pageSize 每页条数
 * @returns 该页 id 列表（顺序即展示顺序）
 */
export function pageFoodSearch(
  ranked: readonly FoodSearchRanked[],
  page: number,
  pageSize: number,
): number[] {
  const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const safeSize = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : FOOD_SEARCH_DEFAULT_PAGE_SIZE;
  const offset = (safePage - 1) * safeSize;
  return ranked.slice(offset, offset + safeSize).map((hit) => hit.id);
}

// ---------------------------------------------------------------------------
// 同名命中（C1「快速加卡重名温和提示」）
//
// 场景：用户手填「番茄炒蛋」，库里本来就有一条 `番茄炒蛋` ——
// 我们**只问一句**（提供选择，不是纠正错误），因此判定必须**极窄**：
// **同名**，或**去掉空白后同名**。不做拼音、不做模糊、不做编辑距离 ——
// 那会在 1773 条的库里对用户随手填的每一个名字都弹提示，等同轰炸。
//
// ⚠️ 刻意**不复用** `food/name.ts` 的 `foodDedupKey`：那是**跨源去重**口径，
// 会丢掉「无区分意义」的括号内容（`番茄炒蛋（均值）` 会与 `番茄炒蛋` 同键），
// 对「同名提示」来说太宽 —— 用户填的名字和那条并不一样。
// 本判定与搜索匹配**共用同一把归一化**（`normalizeForMatch`），不另起一套规则。
// ---------------------------------------------------------------------------

/** 同名判定的最小候选形状：只需要名字（不看营养、不看分类、也不看来源）。 */
export interface FoodNameCandidate {
  /** 食物名 */
  name: string;
}

/**
 * 「同名」比对键：**去掉所有空白（含全角空格）+ 转小写** —— 与搜索匹配同一把归一化。
 *
 * @example
 * foodNameMatchKey(' 番茄 炒蛋 ') === '番茄炒蛋'
 * foodNameMatchKey('Milk Tea') === 'milktea'
 */
export function foodNameMatchKey(name: string): string {
  return normalizeForMatch(name);
}

/**
 * 在候选里找**同名**（或去空白后同名）的那一条。
 *
 * 命中多条时返回**第一条**（调用方传入的顺序即服务端相关度顺序）；
 * 未命中 / 输入为空 / 输入非字符串 → `null`（调用方据此不提示）。
 *
 * 只做**相等**比较：不打分、不排序、不做模糊匹配，因此不存在「提示轰炸」。
 *
 * @param items 候选（通常是 `GET /api/foods/search?q=<手填名>` 的返回）
 * @param typedName 用户手填的食物名
 * @returns 同名条目；没有则 `null`
 */
export function findSameNameFood<T extends FoodNameCandidate>(
  items: readonly T[],
  typedName: string,
): T | null {
  if (typeof typedName !== 'string') {
    return null;
  }
  const key = foodNameMatchKey(typedName);
  if (key === '') {
    return null;
  }
  for (const item of items) {
    if (item !== null && typeof item.name === 'string' && foodNameMatchKey(item.name) === key) {
      return item;
    }
  }
  return null;
}
