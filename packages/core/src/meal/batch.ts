/**
 * 「一餐多品项批量记录」的待记清单口径（core/meal/batch.ts，C-3）—— **单一真源**。
 *
 * ## 为什么要有这个模块
 *
 * 吃麻辣烫点十几样时，一样一样「搜 → 选份量 → 确认」要做几十次；用户的实际反应不是
 * 慢慢记，而是「记两样代表一下」甚至不记 —— 这直接击穿 G1（≤3 次点击记一餐）。
 * C-3 的解法是把这一段改成：**点一样 → 进待记清单（不入库）→ 可逐项调份量 / 移除
 * → 最后一次确认，全部写入同一餐次**。
 *
 * 清单是**前端状态机**，但里面有两件口径必须只有一份、且值得单测：
 * 1. **加一项的去重语义**：同一条食物重复点入清单**不产生第二条**（否则「宽粉」会
 *    在库里出现两行）。已在清单里就原样返回，**不重置用户已调好的份量**；
 * 2. **清单 → 入账请求**的映射：把「用户正在编辑的原始文本克数」解析成数字克数，
 *    并给出内部用的热量预估（见下）。
 *
 * ⚠️ **零 IO、零依赖**，且绝不 import `@qsh/shared-types`（K12）：入参只声明真正用到的
 * 字段（最小投影），`FoodItem` 等更宽的类型天然可传入。
 *
 * 🔴 **无负罪感（PRD §7）**：本模块**只做清单整理**，不产出、也不聚合任何「合计 / 超标 /
 * 超出预算」结论 —— `BatchMealItem.kcal` 是**逐条**的、仅供离线乐观展示内部使用，
 * 多选清单界面**不展示任何合计热量**（红线①）。
 */

/** 待记清单里的一项（前端状态机的元素）。 */
export interface PendingMealItem {
  /** 食物库条目 id（清单按它去重） */
  foodId: number;
  /** 展示名（快照，仅用于清单与本地乐观条目显示） */
  name: string;
  /**
   * 份量克数 —— **用户可编辑的原始输入文本**。
   *
   * 刻意存字符串而不是数字：输入框允许「清空 → 重填」的中间态（空串 / 半个数字），
   * 若存数字就会在清空时立刻回落、光标乱跳。合法性在**提交前**由
   * {@link isPendingListRecordable} 统一校验。
   */
  gramsText: string;
  /** 份量单位（个 / 碗 / 杯 / 克…），与既有记录口径一致 */
  servingUnit: string;
  /** 每 100g 热量 —— 仅供**内部**逐条预估（离线乐观更新），不在多选清单里展示合计 */
  kcalPer100g: number;
}

/** 一条可提交的批量入账项（清单 → 请求载荷）。 */
export interface BatchMealItem {
  /** 食物库条目 id */
  foodId: number;
  /** 展示名（离线乐观条目用，服务端不采信） */
  name: string;
  /** 解析后的克数（提交前已保证 > 0） */
  grams: number;
  /** 份量单位 */
  servingUnit: string;
  /**
   * 该条目按克数预估的热量（**逐条**，非合计）。
   *
   * ⚠️ 服务端对食物库条目**一律按食物库重算**（`scaleFoodNutrients`），此处只是
   * **离线乐观展示**的预估，与既有单条路径的 `computeKcalFromFood` 同公式（整数取整）。
   */
  kcal: number;
}

/** 克数文本是否合法（> 0 的有限数，空串按「没填」处理）。 */
function isPositiveGramsText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') {
    return false;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0;
}

/**
 * 逐条热量预估（整数 kcal）—— 与既有单条路径 `computeKcalFromFood` 同公式。
 *
 * 非法克数（≤ 0 / 非数）返回 0，绝不产生 `NaN`（`NaN` 会污染本地乐观合计）。
 */
function estimateKcal(kcalPer100g: number, grams: number): number {
  if (!Number.isFinite(grams) || grams <= 0 || !Number.isFinite(kcalPer100g)) {
    return 0;
  }
  return Math.round((kcalPer100g * grams) / 100);
}

/**
 * 把一个食物加入待记清单。
 *
 * **幂等**：同 `foodId` 已在清单里时**原样返回**（不新增、也不覆盖用户已改好的份量）——
 * 需求多样时用户会重复点到同一样，重复点不该变成库里两行「宽粉」。
 *
 * @param list 当前清单
 * @param item 待加入项
 * @returns 新清单（未改动时返回原引用，便于 React 跳过重渲染）
 */
export function addPendingItem(
  list: readonly PendingMealItem[],
  item: PendingMealItem,
): PendingMealItem[] {
  if (list.some((entry) => entry.foodId === item.foodId)) {
    return list as PendingMealItem[];
  }
  return [...list, item];
}

/**
 * 从待记清单移除一项（红线③：清单必须可逐项取消）。
 *
 * @param list    当前清单
 * @param foodId  要移除的食物 id
 * @returns 新清单（不存在时按原样返回）
 */
export function removePendingItem(
  list: readonly PendingMealItem[],
  foodId: number,
): PendingMealItem[] {
  return list.filter((entry) => entry.foodId !== foodId);
}

/**
 * 改某一项的份量文本（逐项调份量）。
 *
 * @param list      当前清单
 * @param foodId    目标食物 id
 * @param gramsText 新的克数文本（原样存，不做即时校验）
 * @returns 新清单（目标不存在时按原样返回）
 */
export function setPendingItemGramsText(
  list: readonly PendingMealItem[],
  foodId: number,
  gramsText: string,
): PendingMealItem[] {
  return list.map((entry) => (entry.foodId === foodId ? { ...entry, gramsText } : entry));
}

/**
 * 清单当前是否**可以提交**：非空，且每项的克数都填了合法正数。
 *
 * 供提交按钮的可用性判断与一句中性提示共用（避免「按钮能点、点了报错」）。
 */
export function isPendingListRecordable(list: readonly PendingMealItem[]): boolean {
  return list.length > 0 && list.every((entry) => isPositiveGramsText(entry.gramsText));
}

/**
 * 清单 → 批量入账项（解析克数 + 逐条热量预估）。
 *
 * ⚠️ 调用方应先以 {@link isPendingListRecordable} 确认可提交；本函数对非法克数
 * 解析为 `0` 而不抛错（纯函数不抛），由服务端做最终校验。
 *
 * @param list 待记清单（非空）
 */
export function toBatchItems(list: readonly PendingMealItem[]): BatchMealItem[] {
  return list.map((entry) => {
    const grams = Number(entry.gramsText.trim());
    return {
      foodId: entry.foodId,
      name: entry.name,
      grams,
      servingUnit: entry.servingUnit,
      kcal: estimateKcal(entry.kcalPer100g, grams),
    };
  });
}
