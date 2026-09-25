import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 手写 Pointer Events 拖拽（pages/diary/usePointerReorder.ts，R3.8 / AC-3.8.6）。
 *
 * **为什么不用第三方拖拽库**：QR-7 已拍板禁止（零新增运行时依赖，AC-3.8.8）；
 * 项目已有「手写 SVG 图表替代 echarts」的先例，gzip 增量为 **0**。
 *
 * **为什么不用 HTML5 `draggable`**：移动端 WebKit / Android Chrome 支持不可靠，
 * 触屏必须走 Pointer Events。
 *
 * 时序（AC-3.8.6）：
 * - `pointerdown`（仅拖拽手柄）→ 记起点与 id、`setPointerCapture`、启动**长按计时器**；
 * - 计时器触发前移动 > `moveTolerance`（默认 8px）→ **取消**（判定为页面滚动）；
 * - 计时器触发 → 进入拖拽态，缓存各餐次容器的 rect 作为落区；
 * - `pointermove` → 命中检测（坐标落在哪个餐次 → 目标餐；餐内按指针 Y 与条目中点比较 → 目标 index）；
 * - `pointerup` / `pointercancel` → 计算 `nextIds` → `onCommit(nextIds, targetMealType)`。
 *
 * ⚠️ 本 hook 是**可选的增强**：不挂载它，{@link MealItemRow} 的降级控件（上移 / 下移 / 移动到某餐）
 * 也照常工作（AC-3.8.7 一票否决项）。
 *
 * ⚠️ 拖拽期间**不显示、不修改任何热量数字**（AC-3.8.2 / 无负罪感红线）。
 *
 * ## UI 规范自检（`docs/VISUAL-SYSTEM.md`）
 * - 无位移动画、无 `transition`：本 hook 只改 CSS 类（阴影 / 环色），
 *   `prefers-reduced-motion` 由 `theme/a11y.css` 全局规则兜底，无需额外分支；
 * - 焦点环不在此处定义，元素聚焦时仍走全局 2px + 2px 品牌环；
 * - 指针手势是**可选增强**：键盘 / 读屏用户走 {@link MealItemRow} 的降级控件（AC-3.8.7）。
 */

/** 一个餐次落区（由容器 `<section>` 的 `getBoundingClientRect()` 缓存而来）。 */
export interface DropZone {
  /** 目标餐次 */
  mealType: string;
  /** 落区矩形（视口坐标） */
  rect: DOMRect;
  /** 容器内各条目的中点 Y（升序，用于计算插入位置） */
  middles: number[];
}

/** hook 入参。 */
export interface UsePointerReorderOptions<T extends string> {
  /**
   * 当前的餐次分组（顺序即渲染顺序）。
   *
   * key = 餐次，value = 该餐的 `id` 列表（按当前展示顺序）。
   */
  groups: ReadonlyArray<{ mealType: T; ids: number[] }>;
  /** 提交：把目标餐次置为 `orderedIds` 的完整期望顺序 */
  onCommit: (orderedIds: number[], targetMealType: T) => void;
  /** 长按阈值（ms），默认 300（AC-3.8.6「≥300ms」）；测试可注入 0 绕过等待 */
  longPressMs?: number;
  /** 判定为「页面滚动」的移动容差（px），默认 8 */
  moveTolerance?: number;
  /**
   * 注册一个餐次容器，供命中检测缓存 rect。
   * 组件侧在 `<section ref={...}>` 上调用本函数。
   */
  registerZone?: (mealType: T, element: HTMLElement | null, itemElements: HTMLElement[]) => void;
}

/** hook 返回值。 */
export interface PointerReorderState<T extends string> {
  /** 是否处于拖拽态 */
  dragging: boolean;
  /** 正在拖拽的记录 id */
  draggingId: number | null;
  /** 命中检测得到的目标餐次 */
  targetMealType: T | null;
  /** 命中检测得到的目标插入下标 */
  targetIndex: number;
  /** 开始一次拖拽（绑定到拖拽手柄的 `onPointerDown`） */
  startDrag: (event: React.PointerEvent, id: number) => void;
  /** 注册餐次容器 ref */
  setZoneRef: (mealType: T) => (element: HTMLElement | null) => void;
  /** 注册单条记录的 ref（用于取各条中点） */
  setItemRef: (id: number) => (element: HTMLElement | null) => void;
}

/** 默认长按阈值（AC-3.8.6：≥ 300ms）。 */
export const DEFAULT_LONG_PRESS_MS = 300;

/** 默认移动容差（> 8px 判定为页面滚动）。 */
export const DEFAULT_MOVE_TOLERANCE_PX = 8;

/**
 * 手写 Pointer Events 拖拽。
 *
 * @returns 拖拽态与所需的 ref 绑定函数
 */
export function usePointerReorder<T extends string>(
  options: UsePointerReorderOptions<T>,
): PointerReorderState<T> {
  const { groups, onCommit, longPressMs = DEFAULT_LONG_PRESS_MS, moveTolerance = DEFAULT_MOVE_TOLERANCE_PX } = options;

  const [dragging, setDragging] = useState(false);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [targetMealType, setTargetMealType] = useState<T | null>(null);
  const [targetIndex, setTargetIndex] = useState(0);

  const zonesRef = useRef(new Map<T, { element: HTMLElement; items: Map<number, HTMLElement> }>());
  /** 进入拖拽态时**快照一次**的落区（避免每次 `pointermove` 都触发 `getBoundingClientRect`）。 */
  const snapshotRef = useRef<DropZone[]>([]);
  /** 当前手势挂在 window 上的监听器的**解绑函数**（`reset` 与卸载时都要调用）。 */
  const detachRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number; id: number } | null>(null);
  const draggingRef = useRef(false);
  const targetRef = useRef<{ mealType: T; index: number } | null>(null);
  // onCommit 用 ref 承接：避免父组件每次重渲染都让 hook 的回调身份变化
  const commitRef = useRef(onCommit);
  const groupsRef = useRef(groups);

  useEffect(() => {
    commitRef.current = onCommit;
    groupsRef.current = groups;
  }, [onCommit, groups]);

  /** 清理一次手势（计时器 + window 监听器 + 落区快照 + 状态）。 */
  const reset = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // ⚠️ 必须解绑：手势中途组件卸载时，残留的 window 监听会一直持有旧的闭包与 DOM 引用。
    if (detachRef.current !== null) {
      detachRef.current();
      detachRef.current = null;
    }
    snapshotRef.current = [];
    startRef.current = null;
    draggingRef.current = false;
    targetRef.current = null;
    setDragging(false);
    setDraggingId(null);
    setTargetMealType(null);
    setTargetIndex(0);
  }, []);

  useEffect(() => reset, [reset]);

  /** 缓存各餐次落区（进入拖拽态时调用一次，避免每帧 `getBoundingClientRect`）。 */
  const snapshot = useCallback((): DropZone[] => {
    const zones: DropZone[] = [];
    for (const [mealType, entry] of zonesRef.current) {
      const rect = entry.element.getBoundingClientRect();
      const middles: number[] = [];
      for (const id of groupsRef.current.find((group) => group.mealType === mealType)?.ids ?? []) {
        const el = entry.items.get(id);
        if (el !== undefined) {
          const itemRect = el.getBoundingClientRect();
          middles.push(itemRect.top + itemRect.height / 2);
        }
      }
      middles.sort((a, b) => a - b);
      zones.push({ mealType: mealType as string, rect, middles });
    }
    return zones;
  }, []);

  /** 命中检测：坐标 → 目标餐次 + 插入下标（读的是拖拽开始时的快照，不逐帧量 DOM）。 */
  const hitTest = useCallback(
    (x: number, y: number): { mealType: T; index: number } | null => {
      const zones = snapshotRef.current;
      for (const zone of zones) {
        const { rect } = zone;
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
          continue;
        }
        let index = zone.middles.length;
        for (let i = 0; i < zone.middles.length; i += 1) {
          const middle = zone.middles[i];
          if (middle !== undefined && y < middle) {
            index = i;
            break;
          }
        }
        return { mealType: zone.mealType as T, index };
      }
      return null;
    },
    [],
  );

  /**
   * 计算提交用的 `orderedIds`：把 `draggingId` 从原位置摘出，插到目标餐的目标下标。
   *
   * 结果 = **目标餐次的完整期望顺序**（D-1），上移 / 下移 / 跨餐 / 拖拽共用同一条接口。
   */
  const computeNextIds = useCallback(
    (id: number, mealType: T, index: number): number[] => {
      const source = groupsRef.current.find((group) => group.ids.includes(id));
      const target = groupsRef.current.find((group) => group.mealType === mealType);
      const targetIds = [...(target?.ids ?? [])].filter((item) => item !== id);
      const safeIndex = Math.max(0, Math.min(index, targetIds.length));
      const next = [...targetIds];
      next.splice(safeIndex, 0, id);
      void source; // 源餐的剩余项由服务端 compact 归零归一（D-2），前端无需表达
      return next;
    },
    [],
  );

  /** 拖拽手柄按下：启动长按计时器。 */
  const startDrag = useCallback(
    (event: React.PointerEvent, id: number): void => {
      // 只响应主键（鼠标左键 / 触摸 / 笔）：副键按下不该触发拖拽
      if (event.button > 0) return;
      const element = event.currentTarget as HTMLElement;
      startRef.current = { x: event.clientX, y: event.clientY, id };
      if (typeof element.setPointerCapture === 'function') {
        try {
          element.setPointerCapture(event.pointerId);
        } catch {
          // 某些环境（jsdom / 旧内核）不支持指针捕获，忽略即可
        }
      }

      /** 解绑本次手势挂在 window 上的全部监听（`reset` 与卸载共用）。 */
      const detach = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };

      const onMove = (moveEvent: PointerEvent): void => {
        const start = startRef.current;
        if (start === null) return;
        const dx = Math.abs(moveEvent.clientX - start.x);
        const dy = Math.abs(moveEvent.clientY - start.y);

        if (!draggingRef.current) {
          // 计时器触发前移动超过容差 → 判定为页面滚动，取消拖拽
          if (dx > moveTolerance || dy > moveTolerance) {
            reset();
          }
          return;
        }

        const hit = hitTest(moveEvent.clientX, moveEvent.clientY);
        const nextTarget = hit ?? targetRef.current;
        if (nextTarget !== null) {
          targetRef.current = nextTarget;
          setTargetMealType(nextTarget.mealType);
          setTargetIndex(nextTarget.index);
        }
        moveEvent.preventDefault();
      };

      const onUp = (): void => {
        const start = startRef.current;
        const target = targetRef.current;
        if (start !== null && draggingRef.current && target !== null) {
          const nextIds = computeNextIds(start.id, target.mealType, target.index);
          commitRef.current(nextIds, target.mealType);
        }
        reset();
      };

      detachRef.current = detach;
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);

      timerRef.current = window.setTimeout(() => {
        const start = startRef.current;
        if (start === null) return;
        draggingRef.current = true;
        // 落区只量一次：整段手势期间布局不变，逐帧 `getBoundingClientRect` 是纯浪费
        snapshotRef.current = snapshot();
        const hit = hitTest(start.x, start.y);
        targetRef.current = hit;
        setDragging(true);
        setDraggingId(start.id);
        if (hit !== null) {
          setTargetMealType(hit.mealType);
          setTargetIndex(hit.index);
        }
      }, longPressMs);
    },
    [computeNextIds, hitTest, longPressMs, moveTolerance, reset, snapshot],
  );

  /** 注册餐次容器。 */
  const setZoneRef = useCallback(
    (mealType: T) =>
      (element: HTMLElement | null): void => {
        if (element === null) {
          zonesRef.current.delete(mealType);
          return;
        }
        const existing = zonesRef.current.get(mealType);
        if (existing === undefined) {
          zonesRef.current.set(mealType, { element, items: new Map() });
        } else {
          existing.element = element;
        }
      },
    [],
  );

  /** 注册单条记录。 */
  const setItemRef = useCallback(
    (id: number) =>
      (element: HTMLElement | null): void => {
        if (element === null) {
          for (const entry of zonesRef.current.values()) {
            entry.items.delete(id);
          }
          return;
        }
        // 找到最近的餐次容器（向上冒泡到带 `data-meal-type` 的祖先）
        let node: HTMLElement | null = element.parentElement;
        while (node !== null) {
          const mealType = node.dataset?.mealType as T | undefined;
          if (mealType !== undefined) {
            for (const [key, entry] of zonesRef.current) {
              if (key === mealType) {
                entry.items.set(id, element);
                return;
              }
            }
            return;
          }
          node = node.parentElement;
        }
      },
    [],
  );

  return { dragging, draggingId, targetMealType, targetIndex, startDrag, setZoneRef, setItemRef };
}
