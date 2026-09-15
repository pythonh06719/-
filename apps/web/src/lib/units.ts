import { create } from 'zustand';
import type { UnitSystem } from '@qsh/shared-types';
import { KJ_PER_KCAL, kcalToKj, kjToKcal } from '@qsh/core';

/**
 * 全局热量单位切换（lib/units.ts）—— kcal ↔ kJ，换算基准 1 kcal = 4.184 kJ（K6 / R2.11）。
 *
 * 硬约束：换算一律调用 `@qsh/core` 的 `kcalToKj` / `kjToKcal`，**前端不重写公式**。
 */

/** 本地存储键（单位偏好可跨会话保留）。 */
export const UNIT_STORAGE_KEY = 'qsh:unit';

/** 单位展示标签。 */
export function energyLabel(unit: UnitSystem): string {
  return unit === 'kj' ? 'kJ' : 'kcal';
}

/** 纯函数：把内部统一存储的 kcal 值换算为选定单位下的展示值（取整）。 */
export function toDisplayEnergy(kcal: number, unit: UnitSystem): number {
  return unit === 'kj' ? Math.round(kcalToKj(kcal)) : Math.round(kcal);
}

/** 纯函数：把用户输入的选定单位数值换算回 kcal（用于回写后端）。 */
export function fromDisplayEnergy(value: number, unit: UnitSystem): number {
  return unit === 'kj' ? Math.round(kjToKcal(value)) : Math.round(value);
}

/** 纯函数：格式化「数值 + 单位」，如 `1200 kcal` / `5021 kJ`。 */
export function formatEnergy(kcal: number, unit: UnitSystem): string {
  return `${toDisplayEnergy(kcal, unit)} ${energyLabel(unit)}`;
}

function readStoredUnit(): UnitSystem {
  if (typeof window === 'undefined') {
    return 'kcal';
  }
  try {
    return window.localStorage.getItem(UNIT_STORAGE_KEY) === 'kj' ? 'kj' : 'kcal';
  } catch {
    return 'kcal';
  }
}

interface UnitState {
  /** 当前展示单位 */
  unit: UnitSystem;
  /** 设置单位并持久化 */
  setUnit: (unit: UnitSystem) => void;
  /** 在 kcal / kJ 间切换 */
  toggle: () => void;
}

export const useUnitStore = create<UnitState>((set, get) => ({
  unit: readStoredUnit(),
  setUnit: (unit) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(UNIT_STORAGE_KEY, unit);
      }
    } catch {
      // 存储不可用时仅本次会话生效
    }
    set({ unit });
  },
  toggle: () => {
    get().setUnit(get().unit === 'kj' ? 'kcal' : 'kj');
  },
}));

/** 便捷：读取当前单位（非 React 环境）。 */
export function currentUnit(): UnitSystem {
  return useUnitStore.getState().unit;
}

export { KJ_PER_KCAL };
