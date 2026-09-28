import { create } from 'zustand';
import type { UnitSystem } from '@qsh/shared-types';
import { KJ_PER_KCAL, kcalToKj, kjToKcal } from '@qsh/core';
import { pushSettings } from '@/lib/settings-sync';

/**
 * 全局热量单位切换（lib/units.ts）—— kcal ↔ kJ，换算基准 1 kcal = 4.184 kJ（K6 / R2.11）。
 *
 * 硬约束：换算一律调用 `@qsh/core` 的 `kcalToKj` / `kjToKcal`，**前端不重写公式**。
 *
 * ## 双层持久化（GAP-4 修复）
 *
 * - **localStorage（快路径）**：跨会话保留、首屏前可读，避免单位切换闪烁；
 * - **服务端（权威值）**：`PATCH /users/settings` 落库，使导出的 JSON 备份
 *   「可完整恢复」的承诺真正成立（登录后由 `hydrateUnitFromServer` 校准本地）。
 *
 * 落库**失败不打断用户操作**（本地已生效），仅静默重试，绝不弹红。
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
  /** 设置单位并持久化（localStorage 快路径 + 服务端落库） */
  setUnit: (unit: UnitSystem) => void;
  /** 在 kcal / kJ 间切换 */
  toggle: () => void;
  /** 用服务端权威值校准本地（登录后调用；不触发回写服务端） */
  hydrateUnit: (unit: UnitSystem) => void;
}

/** 只写 localStorage（快路径），不触发服务端回写。 */
function persistUnitLocally(unit: UnitSystem): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(UNIT_STORAGE_KEY, unit);
    }
  } catch {
    // 存储不可用时仅本次会话生效
  }
}

export const useUnitStore = create<UnitState>((set, get) => ({
  unit: readStoredUnit(),
  setUnit: (unit) => {
    // 1) 本地快路径：立即生效，UI 无延迟、无闪烁
    persistUnitLocally(unit);
    set({ unit });
    // 2) 服务端权威值：fire-and-forget 落库（失败静默，不打断操作）
    void pushSettings({ unit });
  },
  toggle: () => {
    get().setUnit(get().unit === 'kj' ? 'kcal' : 'kj');
  },
  hydrateUnit: (unit) => {
    // 服务端校准：只覆盖本地，**不回写服务端**（避免校准引发一次多余 PATCH）。
    persistUnitLocally(unit);
    set({ unit });
  },
}));

/**
 * 登录后 / 启动时用服务端权威值校准单位。
 *
 * 时序（不阻塞首屏）：`useUnitStore` 的初始值在模块加载时即从 localStorage 同步读出
 * （首屏前），本函数在其后异步拉取服务端值并覆盖 —— 数据主权成立的关键一步：
 * 恢复备份后服务端 `unit` 变了，本地要跟上，导出的 JSON 才与之一致。
 */
export async function hydrateUnitFromServer(): Promise<void> {
  const { fetchServerSettings } = await import('@/lib/settings-sync');
  const settings = await fetchServerSettings();
  if (settings !== null) {
    useUnitStore.getState().hydrateUnit(settings.unit);
  }
}

/** 便捷：读取当前单位（非 React 环境）。 */
export function currentUnit(): UnitSystem {
  return useUnitStore.getState().unit;
}

export { KJ_PER_KCAL };
