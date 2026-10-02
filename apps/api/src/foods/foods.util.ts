import { Prisma } from '@prisma/client';

/**
 * 食物可见性过滤（R3.1 / 数据隔离）：
 * 内置 / 开放数据库（OFF / USDA / 中国食物成分表 cfcd）对所有人可见；
 * `user_custom` 仅创建者本人可见。
 */
export function visibleFoodWhere(userId: number): Prisma.FoodItemWhereInput {
  return {
    OR: [{ source: { in: ['builtin', 'openfoodfacts', 'usda', 'cfcd'] } }, { createdByUserId: userId }],
  };
}

/**
 * 食物身份投影（`mealLog.groupBy(foodItemId, customName, loggedDate)`）的行数上限 —— 纵深防御。
 *
 * 该投影是「常吃榜 / 多样性计数」的最小必要输入；理论上界 = 天数 × 每天的 distinct 食物数。
 * 正常情况下远达不到，但**没有上限的聚合**在 SQLite 下会把整个结果集收进内存，
 * 一个「365 天 × 上千种食物」的重度账号可能把它撑大。此上限取一个远超真实用量的值：
 * 正常用户不会触及；只有极端数据才会截断（截断只影响极端情形下的计数精度，不崩溃）。
 */
export const FOOD_IDENTITY_PROJECTION_LIMIT = 20_000;

/**
 * 相关度排序的候选扫描上限（纵深防御）。
 *
 * `GET /api/foods/search` 需要先取出关键词命中的候选，在内存里按相关度排序后再分页。
 * 当前食物库 1773 条（远小于此上限），整体进内存没有压力；此上限只用于堵住
 * 「未来库膨胀到十万级 + 极宽泛关键词（如单个『鸡』字）」时把整表读进内存的情况
 * —— 真到那时只会截断最靠后的候选，不会崩溃。
 */
export const FOOD_SEARCH_RANK_SCAN_LIMIT = 5_000;

/**
 * 「按食物反查历史」的**候选扫描上限**（D-5，`GET /api/foods/:id/history`）—— 纵深防御。
 *
 * ## 为什么需要上限
 *
 * 该查询要同时覆盖两类记录（见 `FoodsService.history` 注释）：
 * ① `foodItemId = :id` 的库内条目记录；② `foodItemId IS NULL` 的**快加卡**记录。
 * 第 ② 类**没有可用于 SQL 精确匹配的列** —— 归一口径（trim + 折叠空白 + 小写，见
 * `@qsh/core` 的 `normalizeFoodName`）无法下推到 SQL，只能把候选行取回内存后逐条
 * `foodIdentity()` 比对。若一个账号有 5 年、每天 5 条快加记录（≈9000 行），无上限的
 * `findMany` 会把整个候选集收进内存。
 *
 * 取一个远超真实用量的值：正常用户远达不到；只有极端数据才会截断，且截断只影响
 * 「极早期的那几天能不能被列出来」，**不影响日期倒序与条数上限的正确性**，更不会崩溃。
 */
export const FOOD_HISTORY_SCAN_LIMIT = 20_000;

/** 关键词模糊匹配条件（名称 / 拼音 / 别名）。 */
export function keywordWhere(keyword: string): Prisma.FoodItemWhereInput {
  return {
    OR: [
      { name: { contains: keyword } },
      { namePinyin: { contains: keyword } },
      { aliases: { contains: keyword } },
    ],
  };
}

/**
 * 「上次份量」批量查询的 id 列表上限（纵深防御）。
 *
 * 前端只会在**当前列表**（搜索分页 ≤ 20 / 常吃榜 ≤ 50）上预取，正常远小于此上限；
 * 该值仅用于堵住「一次传上千个 id」把请求放大成 N 次单点查询。
 */
export const LAST_PORTIONS_MAX_IDS = 50;

/**
 * 解析 `?ids=1,2,3` 形式的逗号分隔 id 列表（`GET /api/foods/last-portions`）。
 *
 * 健壮性（不信任客户端输入）：
 * - 去空白；非法 / 非正 / 非整数的片段被**静默忽略**（不抛错 —— 这是只读的展示增强，不该因脏参 400）；
 * - **去重**（同 id 只查一次）；超过 {@link LAST_PORTIONS_MAX_IDS} 的部分丢弃。
 *
 * 整数判定用纯数字正则（而非 `Number.parseInt`）—— 后者会把 `'2.5'` 解析成 `2`、
 * 把 `'7abc'` 解析成 `7`，把脏参「悄悄变成一个合法的另一个 id」，违背「脏值忽略」语义。
 *
 * @param raw `ids` 查询参数原文（可缺省）
 * @returns 规整后的正整数 id 数组（可能为空数组）
 */
export function parseFoodIdCsv(raw: string | null | undefined): number[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return [];
  }
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!/^\d+$/.test(trimmed)) {
      continue;
    }
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value) || value <= 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    ids.push(value);
    if (ids.length >= LAST_PORTIONS_MAX_IDS) {
      break;
    }
  }
  return ids;
}
