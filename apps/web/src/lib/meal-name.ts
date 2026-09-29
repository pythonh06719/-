import type { MealLog } from '@qsh/shared-types';

/**
 * 饮食记录展示名的**统一口径**（lib/meal-name.ts）—— 修「食物 #45」显示缺陷。
 *
 * ## 背景
 *
 * 普通记录（选食物库条目）只落 `food_item_id`，`custom_name` 恒为 `null` ——
 * 契约里也没有名字字段，前端只能退化成「食物 #45」。服务端现已派生 `foodName`
 * （`food_items.name` 的快照，见 `@qsh/shared-types` 的 `MealLog.foodName`），
 * 本函数把「取哪个名字」这件事收敛到**唯一一处**，供日记列表（`DiaryPage`）、
 * 条目行 emoji（`MealItemRow`）、改份量面板（`MealPortionEditor`）、存套餐映射
 * （`combo-map`）共用，避免各写一遍取名字逻辑而漂移。
 *
 * ## 优先级（日记展示口径）
 *
 * 1. `customName`（用户显式改过的显示名 / 删除快照名）—— **优先**，尊重用户取的称呼；
 * 2. `foodName`（服务端从食物库反查的名字）；
 * 3. `fallback`（默认 `食物 #<foodItemId>`，兼容未带 `foodName` 的旧响应，绝不空白）。
 *
 * ⚠️ 与 `@qsh/core` 的 `displayFoodName` 的差别（**刻意**）：
 * `displayFoodName` 是「食物身份归一」口径（用于常吃榜 / 多样性去重，**foodName 优先**，
 * 目的是让「库内条目」与「同名快加条目」合并为同一种）。本函数是**面向用户的展示口径**
 * （customName 优先），二者服务不同目的，故不合并、不复用。
 *
 * ## 为什么放前端 `lib/` 而不是 `packages/core`
 *
 * - 这是**纯展示口径**，只有前端（日记）用得到；
 * - 需要 `MealLog` 契约类型，而 `packages/core` 明令**禁止 import `@qsh/shared-types`**（K12，防循环依赖）；
 * - 若放 core 只能收窄成 `(customName, foodName, foodItemId) => string` 这种丢类型的原始参数形式，
 *   既不复用 `MealLog`、又和 core 里已存在的 `displayFoodName` 撞概念 —— 得不偿失。
 */

/** 无名记录时的兜底前缀（沿用既有实现，避免 UI 文案漂移）。 */
export const MEAL_NAME_FALLBACK_PREFIX = '食物 #';

/**
 * 解析一条饮食记录的**展示名**。
 *
 * @param log      记录（只取 `customName` / `foodName` / `foodItemId` 三键，便于传入最小对象）
 * @param fallback 三者皆空时的兜底串；缺省走 `食物 #<foodItemId | —>`
 * @returns 非空展示名（**绝不返回空串**，空白输入一律走兜底）
 */
export function resolveMealLogName(
  log: Pick<MealLog, 'customName' | 'foodName' | 'foodItemId'>,
  fallback: string = `${MEAL_NAME_FALLBACK_PREFIX}${log.foodItemId ?? '—'}`,
): string {
  const custom = log.customName;
  if (typeof custom === 'string' && custom.trim() !== '') {
    return custom;
  }
  const food = log.foodName;
  if (typeof food === 'string' && food.trim() !== '') {
    return food;
  }
  return fallback;
}
