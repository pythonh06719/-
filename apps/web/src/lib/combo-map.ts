import type { MealComboItemInput, MealLog } from '@qsh/shared-types';

/**
 * 套餐明细映射（lib/combo-map.ts，R3.9 / GAP-2）。
 *
 * 这条链路只在**前端**做一件事：把「用户已经记好的某一餐」原样搬成套餐明细，
 * **不做任何计算** —— 克数、热量、营养素都是用户记录时服务端算好并落库的值，
 * 这里只是把字段名从 `MealLog` 挪到 `MealComboItemInput`。因此本模块**不产生任何新数字**
 * （NFR-11 可解释性：数字全部可溯源到既有链路）。
 *
 * ## 关键不变量
 * 1. `foodItemId === null` 的自定义条目（快加卡）**必须**带 `customName` 与 `kcal` ——
 *    后端 `prepareComboItem` 明确强校验：自定义条目缺名称 / 缺热量会被拒绝；
 * 2. 库内条目也一并带 `customName`（= 记录时的展示名），让套餐明细在任何时候都能显示人话名称，
 *    而不是退化成「食物 #42」；
 * 3. `sortOrder` 用**该餐内数组下标**，保证「照这个搭配再记一次」的顺序与用户看到的一致
 *    （AC-3.8.5：`applyCombo` 按 `sortOrder || id` 排）；
 * 4. `null` 字段**不写进对象**（用条件展开而非 `undefined` 占位）——
 *    DTO 里这些字段是 `@IsOptional` 的数字 / 字符串，传 `null` 会被当成非法值。
 */

/**
 * 把「某一餐已记录的条目」映射为套餐明细输入。
 *
 * @param logs 这一餐的记录（按其当前展示顺序，`sortOrder` 会自动按下标重排）
 * @returns 可直接作为 `POST /meal-combos` 请求体 `items` 的明细数组
 *
 * 纯函数、无副作用、不依赖 react-query / DOM —— 可被单测直接断言。
 */
export function mealLogsToComboItems(logs: readonly MealLog[]): MealComboItemInput[] {
  return logs.map((log, index) => {
    const item: MealComboItemInput = { sortOrder: index };

    // ① 库内条目：带上 foodId，让套餐能回到食物库（自定义条目则不带这个键）
    if (log.foodItemId !== null) {
      item.foodId = log.foodItemId;
    }

    // ② 名称：库内与自定义条目都带 —— 没有它套餐明细只能显示「食物 #id」
    if (log.customName !== null && log.customName.trim() !== '') {
      item.customName = log.customName;
    }

    // ③ 热量：**必传**。自定义条目靠它落库（后端强校验）；库内条目也一并带上，
    //    保证套餐在任何时候都有一份可展示的热量，不依赖二次查询。
    if (Number.isFinite(log.kcal)) {
      item.kcal = log.kcal;
    }

    // ④ 份量与营养素：非空才写键，`null` 一律省略
    if (log.grams !== null) {
      item.grams = log.grams;
    }
    if (log.servingUnit !== null) {
      item.servingUnit = log.servingUnit;
    }
    if (log.servingQty !== null) {
      item.servingQty = log.servingQty;
    }
    if (log.proteinG !== null) {
      item.proteinG = log.proteinG;
    }
    if (log.fatG !== null) {
      item.fatG = log.fatG;
    }
    if (log.carbG !== null) {
      item.carbG = log.carbG;
    }

    return item;
  });
}
