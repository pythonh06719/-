import { create } from 'zustand';
import type { UnitSystem } from '@qsh/shared-types';
import { KJ_PER_KCAL, kcalToKj, kjToKcal } from '@qsh/core';
import { UNIT_PREFERENCE_KEY } from '@/lib/settings-storage';

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
 * 落库**失败不打断用户操作**（本地已生效），仅静默重试，绝不弹红；
 * 失败会记 dirty 标记，联网后由 `lib/settings-sync.ts` 补推最新值（P0-2）。
 *
 * ⚠️ `settings-sync` 一律**动态 import**（见 `setUnit` / `hydrateUnitFromServer`）：
 * `settings-sync → api → auth.store`，若此处静态 import，`auth.store.clear()` 反向依赖
 * `units` 时会形成循环。动态导入把这条边推迟到运行时，保证依赖图单向。
 */

/**
 * 本地存储键（单位偏好可跨会话保留）。
 *
 * 键名真源在 `lib/settings-storage.ts`（零依赖），此处 re-export ——
 * 便于 `auth.store.clear()` 在**不引入 units 运行时**的前提下清除它（避免循环依赖）。
 */
export const UNIT_STORAGE_KEY = UNIT_PREFERENCE_KEY;

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
  /** 登出时复位到默认值（不落库） */
  resetUnit: () => void;
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
    // 2) 服务端权威值：fire-and-forget 落库（失败静默并记 dirty，联网后补推）
    //    动态 import：避免 `auth.store.clear()` 反向依赖本模块时的循环（见文件头注释）
    void import('@/lib/settings-sync').then(({ pushSettings }) => pushSettings({ unit }));
  },
  toggle: () => {
    get().setUnit(get().unit === 'kj' ? 'kcal' : 'kj');
  },
  hydrateUnit: (unit) => {
    // 服务端校准：只覆盖本地，**不回写服务端**（避免校准引发一次多余 PATCH）。
    persistUnitLocally(unit);
    set({ unit });
  },
  resetUnit: () => {
    // 登出：回到默认值并从 localStorage 移除（键的物理清除由 clearPreferenceKeys 负责）。
    // 只重内存态，不落库（登出后不应再向服务端写任何东西）。
    set({ unit: 'kcal' });
  },
}));

/**
 * 登出时复位单位内存态（由 `auth.store.clear()` 动态调用）。
 *
 * 为什么需要：`clearPreferenceKeys()` 只清 `localStorage`；若不同步复位 zustand 内存态，
 * 已挂载的组件在本会话内仍会显示上个账号的单位，直到刷新页面。
 */
export function resetUnitPreference(): void {
  useUnitStore.getState().resetUnit();
}

/**
 * 登录后 / 启动时用服务端权威值校准单位。
 *
 * 时序（不阻塞首屏）：`useUnitStore` 的初始值在模块加载时即从 localStorage 同步读出
 * （首屏前），本函数在其后异步拉取服务端值并覆盖 —— 数据主权成立的关键一步：
 * 恢复备份后服务端 `unit` 变了，本地要跟上，导出的 JSON 才与之一致。
 *
 * ⚠️ **P0-2 不变量**：本地用户改动优先于服务端旧值。故**先补推 dirty**：
 * - 有 dirty 且推成功 → 可以安全校准（服务端此刻已是本地值，校准无副作用）；
 * - 有 dirty 但推不成功（仍离线）→ **不校准**，保住用户未同步的改动；
 * - 无 dirty → 正常校准。
 */
export async function hydrateUnitFromServer(): Promise<void> {
  const { fetchServerSettings, flushPendingSettings } = await import('@/lib/settings-sync');
  const pushed = await flushPendingSettings({ unit: useUnitStore.getState().unit });
  if (!pushed) {
    // 仍有未推送成功的本地改动：绝不用服务端旧值覆盖
    return;
  }
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
