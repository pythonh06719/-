/**
 * 「上次份量记忆」口径（core/meal/last-portion.ts，D-1）—— **单一真源**（NFR-11 / K12）。
 *
 * ## 为什么要有这个模块
 *
 * 记录一餐时，选中一个**常吃的食物**，我们希望默认份量用**用户上次记这个食物用过的量**，
 * 而不是食物库的通用默认值。这条「从哪里取默认份量」的口径必须**只有一份**：
 * 判「哪条历史有效」与「怎么折成默认份量」若前后端各写一份，就会出现「同一件事两个数字」。
 *
 * 本模块把两件事下沉为纯函数：
 * 1. `hasUsablePortion`：一条历史记录**是否有可用份量**（快加卡记录的 `grams` 为 `null`，
 *    不能被当成「上次份量」—— 那会把用户上次吃的量抹成 0）；
 * 2. `resolveLastPortionServing`：把这条历史折成界面默认选中所需的 `{ unit, grams }`。
 *
 * ⚠️ **零 IO、零依赖**，且绝不 import `@qsh/shared-types`（K12）：入参只声明真正用到的字段
 * （最小投影），`MealLog` / `FoodItem` 等更宽的类型天然可传入。
 *
 * 🔴 无负罪感（PRD §7）：本模块**只做取值**，不产出任何「推荐 / 建议 / 评价」结论 ——
 * 它复现的是**用户自己上一次填的数字**，不是我们替他决定该吃多少。
 */

import { round1 } from '../calorie/rounding';

/** 没有任何命中单位时的默认份量单位（与前端既有口径一致）。 */
export const DEFAULT_PORTION_UNIT = '克';

/** 一条「上次份量」记录所需的最小投影。 */
export interface LastPortionLike {
  /** 选定克数（g）；快加卡 / 自定义条目为 `null` */
  grams?: number | null;
  /** 份量单位（个 / 碗 / 杯 / 片 / 袋…） */
  servingUnit?: string | null;
  /** 份量数量 */
  servingQty?: number | null;
}

/** 折出的默认份量（供前端份量确认区预填）。 */
export interface LastPortionServing {
  /** 展示单位（命中 `servingUnit` 时用它，否则 `克`） */
  unit: string;
  /** 克数（1 位小数） */
  grams: number;
}

/** 换算「份量单位 × 数量 → 克数」所需的最小食物投影。 */
export interface LastPortionFood {
  servingUnits?: readonly { unit: string; grams: number }[] | null;
}

/** 有效正数（NaN / Infinity / ≤ 0 一律视为「没填」）。 */
function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 一条历史记录**是否有可用份量**。
 *
 * 判定规则（与后端 SQL 过滤镜像，必须一致）：
 * - 有正的 `grams` → 有效；
 * - 否则，有非空 `servingUnit` **且** 有正的 `servingQty` → 有效（需借食物库单位表才能算出克数）；
 * - 其余（`grams`、`servingUnit`、`servingQty` 皆空 —— 快加卡 / 空白记录的形态）→ **无效**。
 *
 * @param portion 一条「上次份量」候选（可为 `null` / `undefined`）
 */
export function hasUsablePortion(portion: LastPortionLike | null | undefined): boolean {
  if (portion === null || portion === undefined) {
    return false;
  }
  if (isPositive(portion.grams)) {
    return true;
  }
  return (
    typeof portion.servingUnit === 'string' &&
    portion.servingUnit.trim().length > 0 &&
    isPositive(portion.servingQty)
  );
}

/**
 * 把「上次份量」折成界面默认选中：**优先克数，其次份量单位 × 数量**。
 *
 * 优先级（与 `resolveMealAmount` 的既有口径一致，不要在这里"优化"顺序）：
 * 1. **有正 `grams`** → 直接用该克数（单位取历史里的 `servingUnit`，缺省 `克`）——
 *    克数是**唯一可信的绝对量**，避免单位换算带来的漂移；
 * 2. 否则 **`servingUnit` × `servingQty`**，且该单位能在食物库单位表里命中 → 换算成克数；
 * 3. 都没有 → `null`（调用方回落到食物库默认份量，**行为与现状完全一致**）。
 *
 * @param portion 一条「上次份量」候选
 * @param food    食物（仅需份量单位表；缺省时无法完成第 2 条换算）
 * @returns 默认份量；无法给出时为 `null`
 */
export function resolveLastPortionServing(
  portion: LastPortionLike | null | undefined,
  food?: LastPortionFood | null,
): LastPortionServing | null {
  if (!hasUsablePortion(portion)) {
    return null;
  }
  const source = portion as LastPortionLike;

  if (isPositive(source.grams)) {
    const unit =
      typeof source.servingUnit === 'string' && source.servingUnit.trim().length > 0
        ? source.servingUnit.trim()
        : DEFAULT_PORTION_UNIT;
    return { unit, grams: round1(source.grams) };
  }

  // 到这里一定是「有单位 + 有数量、但没克数」：借食物库单位表换算（命中不了则回退 null）。
  const wanted = (source.servingUnit as string).trim();
  const qty = source.servingQty as number;
  const matched = (food?.servingUnits ?? []).find((item) => item.unit === wanted);
  if (matched !== undefined && isPositive(matched.grams)) {
    return { unit: matched.unit, grams: round1(matched.grams * qty) };
  }
  return null;
}
