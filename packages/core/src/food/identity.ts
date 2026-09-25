/**
 * 食物身份归一（core/food/identity.ts）—— R11.5 常吃榜 / R11.7 多样性的**唯一口径**。
 *
 * ⚠️ 本模块是「食物身份」的**单一实现**（K16）：`/foods/top`、未来的周报多样性计数与阶段回顾
 * 必须调用这里的同一个函数，任何一侧都不得自行实现一套去重逻辑 ——
 * 否则「周报 7 天」与「回顾 365 天」会给出两个互相打架的数字（违反 NFR-11 的一致性要求）。
 *
 * **口径（D-4）**：归一化后的**显示名称优先**，缺失时回落 `food:<foodItemId>`。
 * 理由：「种类」是用户的语言，用户认识的是名字；库内条目与同名快加条目应合并为同一种。
 *
 * 本模块**零 IO、零依赖**，且不得 import `@qsh/shared-types`（K12）。
 */

/** 食物身份的输入行（**最小投影**，来自 SQL `groupBy` + 名称反查）。 */
export interface FoodRefRow {
  /** `meal_logs.food_item_id`，快加条目为 `null` */
  foodItemId?: number | null;
  /** `meal_logs.custom_name`，库内条目可为 `null` */
  customName?: string | null;
  /** 由 `food_items.name` 反查得到的显示名（仅 `foodItemId` 非空时提供） */
  foodName?: string | null;
}

/** 身份归一结果（去重后的展示名集合）。 */
export interface DistinctFoodsResult {
  /** 去重后的**展示名称**，按「最早出现日期」升序（= 输入顺序） */
  names: string[];
  /** 去重后总数（**截断前**的真实值） */
  count: number;
  /** 是否因 `limit` 被截断（UI 据此追加「已经很多啦，先显示这些」） */
  truncated: boolean;
}

/** `distinctFoodKeys` 的选项。 */
export interface DistinctFoodsOptions {
  /** 返回条数上限，默认 200 */
  limit?: number;
}

/** 默认展示上限（AC-11.7.4：清单最多渲染 200 条）。 */
export const DISTINCT_FOOD_LIMIT = 200;

/**
 * 归一化食物名称：trim + 折叠内部空白（含换行与制表符）+ 小写。
 *
 * 空串 / 非字符串输入返回 `''`（调用方据此走 `foodItemId` 回落分支）。
 *
 * @example
 * normalizeFoodName('  番茄\n炒蛋  ') === '番茄 炒蛋'
 * normalizeFoodName('Milk Tea') === 'milk tea'
 */
export function normalizeFoodName(name: string): string {
  if (typeof name !== 'string') {
    return '';
  }
  // `\s+` 覆盖空格 / 制表符 / 换行 / 全角以外的各类空白，统一折叠为单个半角空格。
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 解析一行的**身份键**。
 *
 * - 显示名称（`foodName ?? customName`）归一后非空 → 用归一后的名称；
 * - 否则回落 `food:<foodItemId>`；
 * - 两者皆无 → `null`（该行不计数，避免把「无名无 id」的脏数据算成一种）。
 */
export function foodIdentity(row: FoodRefRow): string | null {
  const display = displayFoodName(row);
  const normalized = normalizeFoodName(display);
  if (normalized.length > 0) {
    return normalized;
  }
  const foodItemId = row?.foodItemId;
  if (typeof foodItemId === 'number' && Number.isFinite(foodItemId)) {
    return `food:${foodItemId}`;
  }
  return null;
}

/**
 * 取一行的**展示名称**（未经归一化，供 UI 直接渲染）。
 *
 * `foodName`（食物库反查）优先于 `customName`（快加快照），与 `foodIdentity` 的口径一致。
 */
export function displayFoodName(row: FoodRefRow): string {
  const foodName = row?.foodName;
  if (typeof foodName === 'string' && foodName.trim().length > 0) {
    return foodName.trim();
  }
  const customName = row?.customName;
  if (typeof customName === 'string' && customName.trim().length > 0) {
    return customName.trim();
  }
  return '';
}

/**
 * 去重：返回展示名称数组 + 真实总数 + 是否截断。
 *
 * - 按输入顺序（= 最早出现日期顺序）保留**首次**出现的展示名；
 * - `count` 为截断**前**的真实种类数（UI 可写「共 N 种」）；
 * - 空输入 → `{ names: [], count: 0, truncated: false }`。
 */
export function distinctFoodKeys(
  rows: readonly FoodRefRow[],
  options: DistinctFoodsOptions = {},
): DistinctFoodsResult {
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : DISTINCT_FOOD_LIMIT;

  const names: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const key = foodIdentity(row);
    if (key === null || seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (names.length < limit) {
      names.push(displayFoodName(row));
    }
  }

  return { names, count: seen.size, truncated: seen.size > names.length };
}
