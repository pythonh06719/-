/**
 * 食物食用历史（core/food/history.ts）—— D-5「我什么时候吃过它」。
 *
 * ## 存在的理由
 *
 * 「上次是几月几号」此前只有**常吃榜**（R11.5）能回答，而常吃榜有门槛（窗口内 ≥ 3 天）
 * 且只列前 12 条 —— 用户在**搜索结果 / 最近 / 收藏**里问「这道菜我上次什么时候吃的」
 * 时无处可答。本模块给出那条链路的**纯函数**部分：把「本人记录」筛出属于某个食物身份的
 * 那些条，按日期倒序排好。
 *
 * ## 身份口径：**复用 `identity.ts`，不另发明**（K16）
 *
 * 命中判定是 `foodIdentity(row) === targetKey`，其中 `targetKey` 由调用方用**同一个函数**
 * 从目标食物（`foodItemId` + `foodName`）算出。库内条目与**同名快加条目**因此天然合并为
 * 1 种（与 D-4 / `rankFrequentFoods` 完全一致）—— 这正是「快加卡记过一次的东西，
 * 在食物库里也能查到它的历史」能成立的原因。
 *
 * ⚠️ **绝不可**在这里另写一套「名字去掉空格再比一遍」：那会让同一道菜在常吃榜里是 1 种、
 * 在历史里是 2 种，两个互相打架的数字正是 K16 要防的。
 *
 * ## 排序：只按日期（最新的在前）
 *
 * `loggedDate` 降序 → `id` 降序。`id` **只是同日并列时的稳定 tie-break**（后写的排前面），
 * **不构成任何第二排序维度**（与 `FoodsService.lastPortions` 的 `orderBy` 同款理由：
 * 同一道菜同一天记了两次时，界面顺序不该随机跳动）。
 *
 * ## 零汇总（QD-6）
 *
 * 本模块**只返回明细**，**不返回条数 / 天数 / 频次**。任何「共 N 天」都等于把明细
 * 重新包装成频次暗示，违反 QD-6 —— 调用方也不得自行 `entries.length` 后写「一共吃过 N 次」。
 *
 * 本模块**零 IO、零依赖**，且不得 import `@qsh/shared-types`（K12）。
 */

import { foodIdentity } from './identity';
import type { FoodRefRow } from './identity';

/**
 * 历史扫描行的最小投影（来自 `meal_logs.findMany` 的 `select`）。
 *
 * 继承 `FoodRefRow`（`foodItemId` / `customName` / `foodName`）—— 身份归一所需的三列
 * 一个不少，这是「能判断这条属不属于目标食物」的最小必要输入。
 */
export interface FoodHistoryRow extends FoodRefRow {
  /** `meal_logs.id`，**仅**用于同日并列时的稳定排序，不返回给前端 */
  id: number;
  /** `YYYY-MM-DD`（本地日期键） */
  loggedDate: string;
  /**
   * 餐次码（`breakfast` / `lunch` / `dinner` / `snack`）。
   *
   * core **不解释**这个值（K12：不得依赖 shared-types），原样透传给调用方，
   * 由前端用 `MEAL_TYPE_LABELS` 翻成「早餐 / 午餐 / …」。
   */
  mealType: string;
  /** 选定克数（g）；快加卡 / 空白记录为 `null` */
  grams: number | null;
  /** 份量单位（个 / 碗 / 杯 / 片 / 袋…）；无则 `null` */
  servingUnit: string | null;
  /** 份量数量；无则 `null` */
  servingQty: number | null;
}

/** 历史明细的一条（**只承载日期 + 餐次 + 份量**，零营养值、零汇总数字）。 */
export interface FoodHistoryEntry {
  /** `YYYY-MM-DD` */
  loggedDate: string;
  /** 餐次码（原样透传，core 不解释） */
  mealType: string;
  /** 选定克数（g）；无则 `null`（**不是 0** —— 「没记份量」与「记了 0g」不是一回事） */
  grams: number | null;
  /** 份量单位；无则 `null` */
  servingUnit: string | null;
  /** 份量数量；无则 `null` */
  servingQty: number | null;
}

/** `selectFoodHistoryEntries` 的选项。 */
export interface FoodHistoryOptions {
  /** 返回条数上限，默认 30；调用方负责把越界值夹到 `maxLimit` 以内 */
  limit?: number;
}

/**
 * D-5 默认口径。
 *
 * `limit = 30` 覆盖了绝大多数用户「一道菜一个月内吃过几次」的真实需求量；
 * 它**只是展示窗口**，不是任何统计口径 —— 响应里不存在「总数」这个字段。
 */
export const FOOD_HISTORY_DEFAULTS = {
  /** 默认返回条数 */
  limit: 30,
  /** 允许的最大条数（服务端校验用；超出按非法入参 400，不静默截断） */
  maxLimit: 100,
} as const;

/**
 * `loggedDate` 的**形状**校验：`YYYY-MM-DD`。
 *
 * ⚠️ 只验形状、**不验真实性**（`'2026-13-45'` 形状对但月份 13）。
 * 这是刻意的：core 零 IO、不依赖 `Date`，而真实性由**写入侧**保证
 * （`loggedDate` 全部由服务端 `todayLocalKey()` 之类的本地日期键生成）。
 * 本函数只负责挡掉「明显不是日期键」的脏值 —— 那种值一旦混进排序就会排在最前面，
 * 比缺一条更糟。
 */
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 是否是形状合法的日期键。 */
function isDateKeyShaped(value: unknown): value is string {
  return typeof value === 'string' && DATE_KEY_PATTERN.test(value);
}

/**
 * 从扫描行里挑出属于 `targetKey` 的记录，按日期倒序取前 `limit` 条。
 *
 * 规则（严格）：
 * 1. **身份归一沿用 `identity.ts`**：`foodIdentity(row) === targetKey` 才算这条食物的记录
 *    —— 库内条目与同名快加条目自动合并为同一条序列（D-4），且与常吃榜口径一致（K16）；
 * 2. `loggedDate` **不是合法 `YYYY-MM-DD`** 的行**跳过**：脏日期参与字符串排序会污染整个
 *    顺序，界面上也无法呈现（`formatMonthDay` 会渲染出 `NaN月NaN日`）——
 *    宁可漏一条，也不给一个看不懂的日期。
 *    ⚠️ 判据是**形状**（4 位年 + `-` + 2 位月 + `-` + 2 位日），**不是长度**：
 *    早先只判 `length >= 10`，结果 `'not-a-date'`（正好 10 个字符）被放行、
 *    排到了所有合法日期前面 —— 这类「差一点就够严」的守卫比没有守卫更危险，
 *    因为它看起来是防住了的；
 * 3. 排序：`loggedDate` 降序 → `id` 降序（`id` 仅为同日稳定 tie-break，非第二维度）；
 * 4. 截断到 `limit`（`<= 0` 视为 0，返回空数组 —— 绝不返回「未截断的全量」）。
 *
 * @param rows      `meal_logs` 的最小投影（调用方须已按 `userId` 过滤）
 * @param targetKey 目标食物的身份键（由调用方用 `foodIdentity()` 从食物条目算出）
 * @returns 已过滤、已排序、已截断的明细；无历史 → `[]`（**不是 null、不是缺字段**）
 */
export function selectFoodHistoryEntries(
  rows: readonly FoodHistoryRow[],
  targetKey: string,
  options: FoodHistoryOptions = {},
): FoodHistoryEntry[] {
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : FOOD_HISTORY_DEFAULTS.limit;

  if (limit === 0 || typeof targetKey !== 'string' || targetKey.length === 0) {
    return [];
  }

  const matched: FoodHistoryRow[] = [];
  for (const row of rows) {
    if (!isDateKeyShaped(row?.loggedDate)) {
      continue;
    }
    // 身份归一走 core 唯一实现（K16）—— 不在这里另写一套名字比较。
    if (foodIdentity(row) !== targetKey) {
      continue;
    }
    matched.push(row);
  }

  matched.sort((left, right) => {
    if (left.loggedDate !== right.loggedDate) {
      return left.loggedDate < right.loggedDate ? 1 : -1;
    }
    // 同日并列：后写入的排前面（确定性 tie-break，与 lastPortions 同款）。
    return right.id - left.id;
  });

  return matched.slice(0, limit).map((row) => ({
    loggedDate: row.loggedDate,
    mealType: row.mealType,
    grams: row.grams,
    servingUnit: row.servingUnit,
    servingQty: row.servingQty,
  }));
}
