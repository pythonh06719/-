import { create } from 'zustand';
import type { UnitSystem, WeightUnit } from '@qsh/shared-types';
import { KJ_PER_KCAL, kcalToKj, kjToKcal } from '@qsh/core';
import { UNIT_PREFERENCE_KEY, WEIGHT_UNIT_PREFERENCE_KEY } from '@/lib/settings-storage';

/**
 * 全局单位切换（lib/units.ts）—— 两个互相独立的展示维度：
 *
 * - **热量**：kcal ↔ kJ，换算基准 1 kcal = 4.184 kJ（K6 / R2.11）；
 * - **体重**：kg ↔ 斤，换算基准 1 kg = 2 市斤（D-3）。
 *
 * 硬约束：热量换算一律调用 `@qsh/core` 的 `kcalToKj` / `kjToKcal`，**前端不重写公式**；
 * 体重换算是「×2 / ÷2」的等价显示换算（无标准库依赖），只影响展示与输入，**不改变存储**。
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
 * ⚠️ `settings-sync` 一律**动态 import**（见 `setUnit` / `setWeightUnit` / `hydrateUnitFromServer`）：
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

/** 体重单位偏好本地键（D-3）。 */
export const WEIGHT_UNIT_STORAGE_KEY = WEIGHT_UNIT_PREFERENCE_KEY;

// ---------------------------------------------------------------------------
// 热量单位（kcal ↔ kJ）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 体重单位（kg ↔ 市斤，D-3）
// ---------------------------------------------------------------------------

/**
 * 换算系数：**1 kg = 2 市斤**（中国市斤 = 500 g）。
 *
 * ⚠️ 刻意写成具名常量并在此注释，避免有人误用「1 斤 = 500 g」时写成 0.5 或 500
 * （两者都会让数值错一个数量级）。仅**展示与输入**换算使用，**不引入斤的存储**。
 */
export const JIN_PER_KG = 2;

/** 纯函数：kg → 斤（×2）。 */
export function kgToJin(kg: number): number {
  return kg * JIN_PER_KG;
}

/** 纯函数：斤 → kg（÷2）。 */
export function jinToKg(jin: number): number {
  return jin / JIN_PER_KG;
}

/**
 * 体重单位展示标签。
 *
 * ⚠️ 用「斤」而不是「市斤」：市斤是书面/计量语，日常口语与体重秤都写「斤」。
 */
export function weightLabel(unit: WeightUnit): string {
  return unit === 'jin' ? '斤' : 'kg';
}

/**
 * 纯函数：把内部统一存储的 kg 值换算为选定单位下的展示值。
 *
 * ⚠️ **刻意不在本函数取整**（与 `toDisplayEnergy` 不同）：热量按整数展示，
 * 而体重天然需要小数（kg 常用 1 位、斜率用 2 位）。若在这里统一取整，
 * 「4 周斜率 0.38 kg/周」会被抹成 0.4，属于真实的精度损失。
 * 故本函数只做等价换算（×2 / ÷2 在二进制浮点下是**精确**的，往返不丢精度），
 * 需要几位小数由各展示点的 `formatWeightNumber` / `toFixed` 决定。
 */
export function toDisplayWeight(kg: number, unit: WeightUnit): number {
  return unit === 'jin' ? kgToJin(kg) : kg;
}

/** 纯函数：把用户输入的选定单位数值换算回 kg（用于回写后端）。 */
export function fromDisplayWeight(value: number, unit: WeightUnit): number {
  return unit === 'jin' ? jinToKg(value) : value;
}

/**
 * 格式化体重数值（1 位小数）—— 与既有的 `kg.toFixed(1)` 口径一致；
 * 非有限值（`null` / `undefined` / `NaN`）返回 `'—'`，调用方无需自行判空。
 */
export function formatWeightNumber(kg: number | null | undefined, unit: WeightUnit): string {
  if (kg === null || kg === undefined || !Number.isFinite(kg)) {
    return '—';
  }
  return toDisplayWeight(kg, unit).toFixed(1);
}

/** 纯函数：格式化「数值 + 单位」，如 `59.8 kg` / `120.0 斤`。 */
export function formatWeight(kg: number, unit: WeightUnit): string {
  return `${formatWeightNumber(kg, unit)} ${weightLabel(unit)}`;
}

/**
 * 有符号体重数值（展示单位，默认 1 位小数），如 `-0.8` / `+0.3`。
 *
 * 用于「净变化 / 体重变化量」这类**差值**的展示：内部值仍是 kg，
 * 这里只做等价换算 + 加号（与 `lib/format.ts` 的 `formatSigned` 同构，但单位感知）。
 * 非有限值（`null` / `undefined` / `NaN`）返回 `'—'`。
 */
export function formatSignedWeight(
  kg: number | null | undefined,
  unit: WeightUnit,
  fractionDigits = 1,
): string {
  if (kg === null || kg === undefined || !Number.isFinite(kg)) {
    return '—';
  }
  const value = toDisplayWeight(kg, unit);
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(fractionDigits)}`;
}

/**
 * 体重的**口语单位名**（用于读屏 / `aria-label` 这类需要念出来的场合）。
 *
 * `kg` 口语念「公斤」而非字母「kg」；`斤` 本身就是口语词。
 */
export function weightSpokenLabel(unit: WeightUnit): string {
  return unit === 'jin' ? '斤' : '公斤';
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

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

function readStoredWeightUnit(): WeightUnit {
  if (typeof window === 'undefined') {
    return 'kg';
  }
  try {
    return window.localStorage.getItem(WEIGHT_UNIT_STORAGE_KEY) === 'jin' ? 'jin' : 'kg';
  } catch {
    return 'kg';
  }
}

interface UnitState {
  /** 当前展示的热量单位 */
  unit: UnitSystem;
  /** 当前展示的体重单位（D-3） */
  weightUnit: WeightUnit;
  /** 设置热量单位并持久化（localStorage 快路径 + 服务端落库） */
  setUnit: (unit: UnitSystem) => void;
  /** 在 kcal / kJ 间切换 */
  toggle: () => void;
  /** 用服务端权威值校准热量单位（登录后调用；不触发回写服务端） */
  hydrateUnit: (unit: UnitSystem) => void;
  /** 登出时复位热量单位到默认值（不落库） */
  resetUnit: () => void;
  /** 设置体重单位并持久化（localStorage 快路径 + 服务端落库） */
  setWeightUnit: (unit: WeightUnit) => void;
  /** 在 kg / 斤 间切换 */
  toggleWeightUnit: () => void;
  /** 用服务端权威值校准体重单位（登录后调用；不触发回写服务端） */
  hydrateWeightUnit: (unit: WeightUnit) => void;
  /** 登出时复位体重单位到默认值（不落库） */
  resetWeightUnit: () => void;
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

/** 只写 localStorage（快路径），不触发服务端回写。 */
function persistWeightUnitLocally(unit: WeightUnit): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(WEIGHT_UNIT_STORAGE_KEY, unit);
    }
  } catch {
    // 存储不可用时仅本次会话生效
  }
}

export const useUnitStore = create<UnitState>((set, get) => ({
  unit: readStoredUnit(),
  weightUnit: readStoredWeightUnit(),
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
  setWeightUnit: (weightUnit) => {
    persistWeightUnitLocally(weightUnit);
    set({ weightUnit });
    void import('@/lib/settings-sync').then(({ pushSettings }) => pushSettings({ weightUnit }));
  },
  toggleWeightUnit: () => {
    get().setWeightUnit(get().weightUnit === 'jin' ? 'kg' : 'jin');
  },
  hydrateWeightUnit: (weightUnit) => {
    persistWeightUnitLocally(weightUnit);
    set({ weightUnit });
  },
  resetWeightUnit: () => {
    set({ weightUnit: 'kg' });
  },
}));

/**
 * 登出时复位单位内存态（由 `auth.store.clear()` 动态调用）。
 *
 * 为什么需要：`clearPreferenceKeys()` 只清 `localStorage`；若不同步复位 zustand 内存态，
 * 已挂载的组件在本会话内仍会显示上个账号的单位，直到刷新页面。
 *
 * 同时复位**热量单位与体重单位**两个维度（D-3）。
 */
export function resetUnitPreference(): void {
  useUnitStore.getState().resetUnit();
  useUnitStore.getState().resetWeightUnit();
}

/**
 * 登录后 / 启动时用服务端权威值校准单位（热量 + 体重）。
 *
 * 时序（不阻塞首屏）：`useUnitStore` 的初始值在模块加载时即从 localStorage 同步读出
 * （首屏前），本函数在其后异步拉取服务端值并覆盖 —— 数据主权成立的关键一步：
 * 恢复备份后服务端 `unit` / `weightUnit` 变了，本地要跟上，导出的 JSON 才与之一致。
 *
 * ⚠️ **P0-2 不变量**：本地用户改动优先于服务端旧值。故**先补推 dirty**：
 * - 有 dirty 且推成功 → 可以安全校准（服务端此刻已是本地值，校准无副作用）；
 * - 有 dirty 但推不成功（仍离线）→ **不校准**，保住用户未同步的改动；
 * - 无 dirty → 正常校准。
 */
export async function hydrateUnitFromServer(): Promise<void> {
  const { fetchServerSettings, flushPendingSettings } = await import('@/lib/settings-sync');
  const state = useUnitStore.getState();
  const pushed = await flushPendingSettings({
    unit: state.unit,
    weightUnit: state.weightUnit,
  });
  if (!pushed) {
    // 仍有未推送成功的本地改动：绝不用服务端旧值覆盖
    return;
  }
  const settings = await fetchServerSettings();
  if (settings !== null) {
    useUnitStore.getState().hydrateUnit(settings.unit);
    useUnitStore.getState().hydrateWeightUnit(settings.weightUnit);
  }
}

/** 便捷：读取当前热量单位（非 React 环境）。 */
export function currentUnit(): UnitSystem {
  return useUnitStore.getState().unit;
}

/** 便捷：读取当前体重单位（非 React 环境）。 */
export function currentWeightUnit(): WeightUnit {
  return useUnitStore.getState().weightUnit;
}

export { KJ_PER_KCAL };
