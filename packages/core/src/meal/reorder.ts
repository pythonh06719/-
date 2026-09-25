/**
 * 餐次排序 / 跨餐移动（core/meal/reorder.ts）—— R3.8。
 *
 * 排序映射是**纯计算**：前端拖拽完要乐观更新本地缓存，服务端要落库，
 * 两端各写一份必然漂移（本项目已有 QA BUG-01 的前车之鉴），故下沉到 core 做唯一真源。
 *
 * 接口只描述「**目标餐次 + 该餐的完整期望顺序**」，不描述「从哪移到哪」——
 * 这样上移 / 下移 / 跨餐 / 拖拽**四种操作共用同一条接口**（D-1）。
 *
 * ⚠️ `core` **不得** import `@qsh/shared-types`（K12：会造成循环依赖），
 * 故用泛型 `T extends string` 承接 `MealType`。
 */

/** 一条记录的最小排序状态（来自 `meal_logs` 的 `id / meal_type / sort_order`）。 */
export interface ReorderItem<T extends string = string> {
  id: number;
  mealType: T;
  sortOrder: number;
}

/** 排序结果：可直接作为 Prisma update 的数据。 */
export interface ReorderUpdate<T extends string = string> {
  id: number;
  mealType: T;
  sortOrder: number;
}

/** `applyReorder` 的选项。 */
export interface ApplyReorderOptions {
  /**
   * 是否把**所有**餐次的 `sortOrder` 重排为 `0..n-1`（保持各自相对顺序）。
   *
   * 默认 `true`：消除跨餐移动后源餐留下的空洞（如 `0,2,3`），防止长期漂移。
   * 该操作是**幂等**的 —— 同一 payload 重复提交结果一致（AC-3.8.3）。
   */
  compact?: boolean;
}

/**
 * 计算「把 `orderedIds` 置为目标餐次、并按要求排序」后的新映射。
 *
 * 语义（严格）：
 * 1. `orderedIds` **去重**（保留首次出现位置）；
 * 2. 只处理 `items` 中存在的 id，**未知 id 静默忽略**
 *    （服务端另有 400 校验，core 保持宽容，便于离线乐观更新复用）；
 * 3. 被列出的记录：`mealType := targetMealType`，`sortOrder := 去重后下标`；
 * 4. 未被列出的记录保持原 `mealType`；
 * 5. `compact=true` 时，对每个餐次按「新相对顺序」重排为 `0..n-1`。
 *    相对顺序 = 被列出者的新下标在前（仅当该餐次就是目标餐次），
 *    其余按原 `sortOrder`、再按原输入顺序。
 *
 * @param items 当前该用户该日**全部**记录的最小状态
 * @param targetMealType 目标餐次
 * @param orderedIds 目标餐次的**完整期望顺序**
 * @returns 与 `items` 一一对应的新映射（**长度等于 `items.length`**）
 */
export function applyReorder<T extends string>(
  items: readonly ReorderItem<T>[],
  targetMealType: T,
  orderedIds: readonly number[],
  options: ApplyReorderOptions = {},
): ReorderUpdate<T>[] {
  const compact = options.compact !== false;

  const byId = new Map<number, ReorderItem<T>>();
  for (const item of items) {
    byId.set(item.id, item);
  }

  // ① 去重（保留首次出现位置）→ ② 只保留 items 中存在的 id（未知 id 静默忽略）
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const id of orderedIds) {
    if (!byId.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ordered.push(id);
  }

  // ③ 被列出者的新下标
  const newIndexOf = new Map<number, number>();
  ordered.forEach((id, index) => newIndexOf.set(id, index));

  // ④ 逐条计算「新餐次」与「新相对顺序键」
  const working = items.map((item, inputIndex) => {
    const listedIndex = newIndexOf.get(item.id);
    const isListed = listedIndex !== undefined;
    return {
      id: item.id,
      mealType: isListed ? targetMealType : item.mealType,
      sortOrder: item.sortOrder,
      listedIndex: isListed ? (listedIndex as number) : null,
      inputIndex,
    };
  });

  if (!compact) {
    // 源餐保留空洞：只有被列出者拿到新下标，其余原样不动。
    return working.map((row) => ({
      id: row.id,
      mealType: row.mealType,
      sortOrder: row.listedIndex === null ? row.sortOrder : row.listedIndex,
    }));
  }

  // ⑤ 按餐次分组 → 组内按「新相对顺序」重排为 0..n-1
  const groups = new Map<T, typeof working>();
  for (const row of working) {
    const bucket = groups.get(row.mealType);
    if (bucket === undefined) {
      groups.set(row.mealType, [row]);
    } else {
      bucket.push(row);
    }
  }

  const result: ReorderUpdate<T>[] = [];
  for (const [mealType, bucket] of groups) {
    const sorted = [...bucket].sort((left, right) => {
      const leftListed = left.listedIndex !== null && mealType === targetMealType;
      const rightListed = right.listedIndex !== null && mealType === targetMealType;
      if (leftListed && rightListed) {
        return (left.listedIndex as number) - (right.listedIndex as number);
      }
      if (leftListed !== rightListed) {
        return leftListed ? -1 : 1;
      }
      if (left.sortOrder !== right.sortOrder) {
        return left.sortOrder - right.sortOrder;
      }
      return left.inputIndex - right.inputIndex;
    });
    sorted.forEach((row, index) => {
      result.push({ id: row.id, mealType, sortOrder: index });
    });
  }

  // 与入参 `items` 一一对应（顺序也保持一致），便于调用方按 id 对齐
  const updateById = new Map<number, ReorderUpdate<T>>();
  for (const row of result) {
    updateById.set(row.id, row);
  }
  return items.map((item) => updateById.get(item.id) as ReorderUpdate<T>);
}
