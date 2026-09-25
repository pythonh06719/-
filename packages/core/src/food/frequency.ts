/**
 * 常吃榜排名（core/food/frequency.ts）—— R11.5。
 *
 * **计数口径是「出现天数」（distinct `loggedDate`），不是出现次数（QR-1）**：
 * 同一天记两次不应让它在榜上翻倍 —— 「常」说的是日子，不是次数。
 *
 * 排名必须**完全确定**（同样的输入永远得到同样的输出），故用三级 tie-break：
 * `dayCount` 降序 → `lastLoggedDate` 降序 → `key` 升序。
 *
 * 本模块**零 IO、零依赖**，且不得 import `@qsh/shared-types`（K12）。
 */

import { displayFoodName, foodIdentity } from './identity';
import type { FoodRefRow } from './identity';

/** 频次统计的输入行（最小投影：`groupBy([foodItemId, customName, loggedDate])` 的产物）。 */
export interface FrequentFoodRow extends FoodRefRow {
  /** `YYYY-MM-DD` */
  loggedDate: string;
}

/** 常吃榜条目。 */
export interface FrequentFood {
  /** 身份键（与 `distinctFoodKeys` 同源） */
  key: string;
  /** 展示名称（首次出现时的显示名） */
  name: string;
  /** 食物库条目 id；纯快加条目为 `null` */
  foodItemId: number | null;
  /** **出现天数**（distinct `loggedDate`），QR-1 拍板口径 */
  dayCount: number;
  /** 最近一次出现的日期（tie-break 用，也供 UI 展示） */
  lastLoggedDate: string;
}

/** `rankFrequentFoods` 的选项。 */
export interface RankFrequentFoodsOptions {
  /** 统计窗口（天，含今天），默认 90 */
  days?: number;
  /** 展示上限，默认 12 */
  limit?: number;
  /** 最低展示门槛（出现天数 < 该值一律不进榜），默认 3 */
  minDays?: number;
}

/** 常吃榜默认口径（AC-11.5.1 / AC-11.5.2）。 */
export const FREQUENT_FOOD_DEFAULTS = {
  /** 统计窗口（天，含今天） */
  days: 90,
  /** 展示上限 */
  limit: 12,
  /** 最低展示门槛：出现天数 < 3 一律不进榜 */
  minDays: 3,
} as const;

/** 一组身份的累计状态（内部）。 */
interface Bucket {
  key: string;
  name: string;
  foodItemId: number | null;
  dates: Set<string>;
}

/** 一天 = 86 400 000 ms（用于纯字符串日期键的加减，避免 Date 时区抖动）。 */
const MS_PER_DAY = 86_400_000;

/**
 * 计算统计窗口的起始日期键（含端点）。
 *
 * 窗口末端取**输入中最新的 `loggedDate`**，而不是运行时的「今天」——
 * 这样纯函数不需要注入 `now`，结果与调用方 SQL 过滤的窗口一致（调用方已按今天过滤）。
 */
function windowStart(rows: readonly FrequentFoodRow[], days: number): string | null {
  let maxDate: string | null = null;
  for (const row of rows) {
    if (typeof row?.loggedDate !== 'string' || row.loggedDate.length < 10) {
      continue;
    }
    if (maxDate === null || row.loggedDate > maxDate) {
      maxDate = row.loggedDate;
    }
  }
  if (maxDate === null) {
    return null;
  }
  const parts = maxDate.slice(0, 10).split('-').map((part) => Number(part));
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    year === undefined ||
    month === undefined ||
    day === undefined
  ) {
    return null;
  }
  const end = Date.UTC(year, month - 1, day);
  const start = new Date(end - (days - 1) * MS_PER_DAY);
  const mm = String(start.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(start.getUTCDate()).padStart(2, '0');
  return `${start.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * 常吃榜排名：按**出现天数**降序取前 N。
 *
 * 规则（严格）：
 * 1. 身份归一沿用 `core/food/identity.ts`（显示名称优先，缺失回落 `food:<id>`）；
 * 2. 同一身份同一天出现多次只算 **1 天**；
 * 3. 出现天数 < `minDays`（默认 3）的**一律不进榜**（UI 据此整块隐藏，不展示「还不够」）；
 * 4. 排序：`dayCount` 降序 → `lastLoggedDate` 降序 → `key` 升序（完全确定）；
 * 5. 时间窗外的记录不计入（窗口由 SQL 层过滤，core 再按 `days` 兜一层，双保险）。
 *
 * @returns 已排序、已截断的榜单；数据不足时为 `[]`（**不是 null**）
 */
export function rankFrequentFoods(
  rows: readonly FrequentFoodRow[],
  options: RankFrequentFoodsOptions = {},
): FrequentFood[] {
  const days =
    typeof options.days === 'number' && Number.isFinite(options.days) && options.days > 0
      ? Math.floor(options.days)
      : FREQUENT_FOOD_DEFAULTS.days;
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit >= 0
      ? Math.floor(options.limit)
      : FREQUENT_FOOD_DEFAULTS.limit;
  const minDays =
    typeof options.minDays === 'number' && Number.isFinite(options.minDays) && options.minDays >= 0
      ? Math.floor(options.minDays)
      : FREQUENT_FOOD_DEFAULTS.minDays;

  if (rows.length === 0) {
    return [];
  }

  const from = windowStart(rows, days);
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    const loggedDate = row?.loggedDate;
    if (typeof loggedDate !== 'string' || loggedDate.length < 10) {
      continue;
    }
    const dateKey = loggedDate.slice(0, 10);
    // 时间窗兜底：窗外记录不计入（与调用方 SQL 过滤同口径）。
    // `from` 由输入中最新的 loggedDate 反推，故只需比较下界。
    if (from !== null && dateKey < from) {
      continue;
    }

    const key = foodIdentity(row);
    if (key === null) {
      continue;
    }

    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        key,
        name: displayFoodName(row),
        foodItemId: typeof row.foodItemId === 'number' && Number.isFinite(row.foodItemId) ? row.foodItemId : null,
        dates: new Set<string>(),
      };
      buckets.set(key, bucket);
    } else if (bucket.foodItemId === null) {
      // 同一身份既被快加记过、又命中过食物库条目时，补齐可反查的 id（供 UI 走份量确认）。
      const foodItemId = row.foodItemId;
      if (typeof foodItemId === 'number' && Number.isFinite(foodItemId)) {
        bucket.foodItemId = foodItemId;
      }
    }
    bucket.dates.add(dateKey);
  }

  const ranked: FrequentFood[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.dates.size < minDays) {
      continue;
    }
    let lastLoggedDate = '';
    for (const date of bucket.dates) {
      if (date > lastLoggedDate) {
        lastLoggedDate = date;
      }
    }
    ranked.push({
      key: bucket.key,
      name: bucket.name,
      foodItemId: bucket.foodItemId,
      dayCount: bucket.dates.size,
      lastLoggedDate,
    });
  }

  ranked.sort((left, right) => {
    if (right.dayCount !== left.dayCount) {
      return right.dayCount - left.dayCount;
    }
    if (right.lastLoggedDate !== left.lastLoggedDate) {
      return right.lastLoggedDate < left.lastLoggedDate ? -1 : 1;
    }
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });

  return ranked.slice(0, limit);
}
