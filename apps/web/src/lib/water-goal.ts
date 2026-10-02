import { DEFAULT_WATER_GOAL_ML, isValidWaterGoalMl } from '@qsh/core';
import { WATER_GOAL_PREFERENCE_KEY } from '@/lib/settings-storage';

/**
 * 每日饮水目标的本地快路径（lib/water-goal.ts）—— GAP-3。
 *
 * ## 为什么需要本机记住这个值
 *
 * 「每日饮水目标」是服务端权威设置（`user_settings.water_goal_ml`），写入走
 * `PATCH /users/settings`（`lib/settings-sync.ts`）。但服务端权威值有两个前提：
 *
 * 1. **离线时要能显示**：断网时 `GET /water` 拿不到，若本机不留一份，用户会看到
 *    默认 2000 而不是自己设的值；
 * 2. **离线改动要能补推**：离线时改目标 → `pushSettings` 失败 → 记 dirty；
 *    联网后 `registerSettingsOnlineFlush(getCurrent)` 补推时**要从本机读到当前值**
 *    （`flushPendingSettings` 是按「最后值语义」推本地最新值的，见其注释）。
 *    没有这份本机值，`getCurrent` 就凑不出含 `waterGoalMl` 的补推载荷。
 *
 * 因此这里沿用项目既有的「双层结构」——localStorage 快路径 + 服务端权威值
 * （与 `lib/units.ts` / `theme/useTheme.ts` 同构），而不是新造一套机制。
 *
 * ## 键与清理
 *
 * 键名真源在零依赖的 `lib/settings-storage.ts`（此处 re-export），登出时由
 * `clearPreferenceKeys()` 一并清除，避免跨账号残留（理由同单位 / 深色）。
 *
 * ## 读取口径
 *
 * 只接受 500–8000 的整数毫升（`@qsh/core` 的 `isValidWaterGoalMl`）；坏值视为「未设置」，
 * 由调用方回退服务端值或默认 2000。
 */

/** 饮水目标偏好本地键（真源在 `lib/settings-storage.ts`，此处 re-export 供本模块与测试使用）。 */
export const WATER_GOAL_STORAGE_KEY = WATER_GOAL_PREFERENCE_KEY;

/** 读取本机记住的饮水目标；未设置 / 坏值时返回 `undefined`（与「设为 0」区分）。 */
export function readStoredWaterGoalMl(): number | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  try {
    const raw = window.localStorage.getItem(WATER_GOAL_STORAGE_KEY);
    if (raw === null) {
      return undefined;
    }
    const parsed = Number(raw);
    return isValidWaterGoalMl(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 记住当前饮水目标（本地快路径）。
 *
 * 静默：`localStorage` 不可用（隐私模式）时忽略，不抛错、不阻断主流程 ——
 * 与 `lib/units.ts` 的 `persistUnitLocally` 同一容错口径。
 */
export function persistWaterGoalMl(ml: number): void {
  if (typeof window === 'undefined' || !isValidWaterGoalMl(ml)) {
    return;
  }
  try {
    window.localStorage.setItem(WATER_GOAL_STORAGE_KEY, String(ml));
  } catch {
    // 存储不可用时仅本次会话生效
  }
}

/**
 * 解析「当前该显示/回填的饮水目标」——**本机值优先**。
 *
 * 优先级：`本机记住的值 > 服务端值（GET /water 的 goalMl）> 默认 2000`。
 *
 * ⚠️ **本机值优先是刻意的**（与 `settings-sync` 的 P0-2 不变量一致）：
 * 用户刚改的目标可能还没推成功（dirty），若这里让服务端旧值优先，
 * 用户会看到自己刚设的值又被打回去 —— 本地改动在推送成功前必须胜出。
 * 服务端值只在「本机还没有值」（如新设备、登出后）时兜底。
 *
 * @param serverGoalMl `GET /water` 的 `goalMl`（可能缺省：未加载 / 离线）
 */
export function resolveWaterGoalMl(serverGoalMl: number | undefined): number {
  const stored = readStoredWaterGoalMl();
  if (stored !== undefined) {
    return stored;
  }
  return isValidWaterGoalMl(serverGoalMl) ? serverGoalMl : DEFAULT_WATER_GOAL_ML;
}
