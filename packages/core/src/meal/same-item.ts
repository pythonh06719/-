/**
 * 「这一餐里是不是已经有它了」的温和觉察口径（core/meal/same-item.ts，D-2）—— **单一真源**。
 *
 * ## 为什么要有这个模块
 *
 * 用户记了一餐、过了一会儿忘了又记一次同一份东西，当天热量就会**虚高**，
 * 而他完全不知道 —— 这是「数字可信」（G2）里最隐蔽的一种数据质量损耗。
 *
 * ## 但这件事的**第一原则是默认放行**
 *
 * 这可能**真的不是重复**：用户可能就是又吃了一碗饭。因此本模块只回答一个问题 ——
 * 「同一个 `loggedDate` + 同一个 `mealType` 里，是不是已经有一条**同一样**的食物」，
 * 它**不下任何结论、不抛任何错、不做任何拦截**。判定结果唯一的用途是让界面显示一句
 * 中性小字（「今天这餐好像已经有它了，接着记也没问题」），把判断权留给用户。
 *
 * 措辞红线（在 `lib/copy.ts` 集中把关，不在本模块）：不出现「重复 / 记错了 / 请勿 /
 * 确定要再记一次吗」这类指责式说法 —— 那是在说用户记错了。这里只做**极窄的相等判定**。
 *
 * ## 判定口径（**极窄**，避免提示轰炸）
 *
 * - **食物库条目**：`foodItemId` **完全相同**（数值相等）；
 * - **快加卡 / 自定义条目**：`customName` **同名**，复用搜索那一把归一化
 *   （{@link foodNameMatchKey}：去所有空白 + 转小写）。不做拼音、不做模糊、不做编辑距离；
 * - **作用域**：只比同 `loggedDate` + 同 `mealType` 的行 —— 早餐记过的米饭，午餐再记
 *   **不该提示**（那本来就是正常的），昨天的记录也不该提示。
 *
 * ## 为什么是纯函数、为什么放 core
 *
 * 「同一天同一餐里是否已有该食物」是纯计算：输入已有记录 + 候选，输出是否命中。
 * 放 `packages/core` 便于单测全覆盖，也保证判定只有一份实现（NFR-11）。
 *
 * ⚠️ 零 IO、零依赖，且绝不 import `@qsh/shared-types`（K12）：入参只声明真正用到的
 * 四个字段（最小投影），`MealLog` 等更宽的类型天然可传入。
 */

import { foodNameMatchKey } from '../food/search';

/**
 * 一条已有饮食记录的**最小投影**（判定只需要这四个字段）。
 *
 * `MealLog` 天然满足本接口（多出的字段被忽略），故调用方可直接投影真实记录。
 */
export interface MealItemIdentity {
  /** 记录所属本地日期 `YYYY-MM-DD` */
  loggedDate: string;
  /** 餐次（`breakfast` / `lunch` / `dinner` / `snack`）—— 用 `string` 以免引入 shared-types */
  mealType: string;
  /** 食物库条目 id；快加卡 / 自定义条目为 `null` */
  foodItemId: number | null;
  /** 自定义（快加）名称；食物库条目为 `null` */
  customName: string | null;
}

/**
 * 「查看某一天某一餐里是否已有某一样」的查询条件。
 *
 * `foodItemId` 与 `customName` 二选一（或都给：先按 id 比、再按名字比），
 * 两者都没有时视为**没有可比对的身份** → 判定恒为「未命中」，从不误报。
 */
export interface SameMealQuery {
  /** 目标日期 `YYYY-MM-DD` */
  loggedDate: string;
  /** 目标餐次 */
  mealType: string;
  /** 候选食物库条目 id（食物库来源） */
  foodItemId?: number | null;
  /** 候选自定义名称（快加卡来源；按同名归一化比对） */
  customName?: string | null;
}

/**
 * 在「已有记录」里找**同一天 + 同一餐 + 同一样**的那一条。
 *
 * 命中时返回**该条记录**（调用方通常只关心是否存在，故另有 {@link hasSameMealItem}
 * 的布尔入口）；未命中 / 日期餐次不符 / 候选没有可用身份 → `null`。
 *
 * 只做**相等**比较：不打分、不排序、不做模糊匹配，因此不存在「提示轰炸」。
 *
 * @param existing 已有记录（通常传「这一天的全部记录」；函数自身按 `loggedDate` + `mealType` 过滤）
 * @param query    候选身份（日期 + 餐次 + 食物 id 或自定义名）
 * @returns 命中的那一条；没有则 `null`
 */
export function findSameMealItem(
  existing: readonly MealItemIdentity[],
  query: SameMealQuery,
): MealItemIdentity | null {
  if (query === null || typeof query !== 'object') {
    return null;
  }
  const { loggedDate, mealType } = query;
  if (typeof loggedDate !== 'string' || typeof mealType !== 'string') {
    return null;
  }

  const wantFoodId = typeof query.foodItemId === 'number' ? query.foodItemId : null;
  const wantNameKey =
    typeof query.customName === 'string' ? foodNameMatchKey(query.customName) : '';

  // 两个身份都没有 → 无从比对（绝不误报）。
  if (wantFoodId === null && wantNameKey === '') {
    return null;
  }

  for (const item of existing) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    // 作用域：只比同一天、同一餐（早餐记过的，午餐再记不该提示）。
    if (item.loggedDate !== loggedDate || item.mealType !== mealType) {
      continue;
    }
    if (wantFoodId !== null && item.foodItemId === wantFoodId) {
      return item;
    }
    if (
      wantNameKey !== '' &&
      typeof item.customName === 'string' &&
      foodNameMatchKey(item.customName) === wantNameKey
    ) {
      return item;
    }
  }
  return null;
}

/**
 * {@link findSameMealItem} 的布尔入口 —— 语义更直白的「已经有它了吗」。
 *
 * @param existing 已有记录
 * @param query    候选身份
 * @returns 同一天同一餐里已经有同一样时为 `true`
 */
export function hasSameMealItem(
  existing: readonly MealItemIdentity[],
  query: SameMealQuery,
): boolean {
  return findSameMealItem(existing, query) !== null;
}
