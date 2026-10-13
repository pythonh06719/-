import { create } from 'zustand';
import type { AuthResponse, User } from '@qsh/shared-types';
import { cacheClearAll } from './local-cache';
import { clearPreferenceKeys } from './settings-storage';

/**
 * 登录态 Store（zustand）—— ARCHITECTURE §1.7「Access Token 内存保存」。
 *
 * ## 为什么 accessToken 只放内存（+ 可选 sessionStorage）
 *
 * 1. **安全**：`localStorage` 中的 token 会被任意同源脚本读取，一旦出现 XSS 即长期失窃；
 *    内存态在页面刷新后即失效，攻击面最小（ARCHITECTURE §1.7 明文约定「不落 localStorage」）。
 * 2. **可用性折中**：为保证「同一标签页内刷新不丢登录态」，本实现把 token **镜像**到
 *    `sessionStorage`（关闭标签页即清除，生命周期远短于 localStorage）。
 *    ⚠️ 现实口径（上线前全检 F-004 校正）：后端**没有** refreshToken / HttpOnly Cookie
 *    —— accessToken 有效期 2h（`JWT_EXPIRES_IN`），过期后需重新用验证码登录；
 *    `GET /api/auth/me` 只返回资料，**不换发新 token**。服务端令牌吊销同样未实现，
 *    因此「登出」= 前端清空本 store（见 `clear()`），服务端不感知。
 *    要做真正的长效登录，需要先在后端补 refresh 轮换 + 吊销（见 F-004 剩余项）。
 * 3. **可关闭**：`MIRROR_TO_SESSION` 为 `false` 时退化为纯内存，安全性最高。
 */

/** 是否把 accessToken 镜像到 sessionStorage（默认开启，见上文理由 2）。 */
export const MIRROR_TO_SESSION = true;

/** sessionStorage 键名。 */
const TOKEN_STORAGE_KEY = 'qsh:accessToken';

/** 登录态阶段：`unknown` 表示尚未初始化（等 `/auth/me` 结果）。 */
export type AuthStatus = 'unknown' | 'anonymous' | 'authenticated';

interface AuthState {
  /** 访问令牌（内存优先，见文件头注释） */
  accessToken: string | null;
  /** 当前用户（`/auth/me` 或登录响应） */
  user: User | null;
  /** 是否已完成引导问卷（决定落地页 → `/onboarding` 或 `/dashboard`） */
  onboardingCompleted: boolean;
  /** 登录态阶段 */
  status: AuthStatus;
  /** 写入新会话（登录 / 刷新令牌成功） */
  setSession: (payload: Pick<AuthResponse, 'accessToken' | 'user' | 'onboardingCompleted'>) => void;
  /** 更新用户信息（如重置引导状态） */
  setUser: (user: User) => void;
  /** 标记引导完成状态 */
  setOnboardingCompleted: (done: boolean) => void;
  /** 清空会话（登出 / 401 自动清理） */
  clear: () => void;
}

/** 读取镜像的 token（环境不支持 sessionStorage 时返回 null）。 */
function readMirroredToken(): string | null {
  if (!MIRROR_TO_SESSION || typeof window === 'undefined') {
    return null;
  }
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** 写入 / 清除镜像 token。 */
function mirrorToken(token: string | null): void {
  if (!MIRROR_TO_SESSION || typeof window === 'undefined') {
    return;
  }
  try {
    if (token === null) {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    }
  } catch {
    // 存储不可用时仅内存生效
  }
}

const initialToken = readMirroredToken();

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: initialToken,
  user: null,
  onboardingCompleted: false,
  status: initialToken === null ? 'anonymous' : 'unknown',

  setSession: ({ accessToken, user, onboardingCompleted }) => {
    mirrorToken(accessToken);
    set({ accessToken, user, onboardingCompleted, status: 'authenticated' });
  },

  setUser: (user) => {
    set({ user });
  },

  setOnboardingCompleted: (onboardingCompleted) => {
    set({ onboardingCompleted });
  },

  clear: () => {
    mirrorToken(null);
    // 退出登录 / 401 自动登出时**必须清空本地缓存**：
    // localStorage 的 `qsh:cache:*`（饮食、体重、看板、预算）是按「日期 + 资源」存的，
    // **不含用户身份** —— 留着它们，同浏览器换账号后离线兜底会把上一个账号的数据展示出来。
    // 这个 `clear()` 是登出与 401 两条路径的共同入口，放在这里才能一次覆盖。
    cacheClearAll();
    // GAP-4 复核修复 · P0-1：单位（`qsh:unit`）与深色（`qsh:theme`）是**跟账号走的偏好**，
    // 不属 `qsh:cache:*` 语义，故不在 `cacheClearAll()` 内清除。若不清，登出换账号后
    // 若 `fetchServerSettings()` 失败（离线），校准静默跳过 → **新账号看到上个账号的偏好**。
    // 清掉后本地回到默认值（kcal / system），下个账号登录后由 SettingsCalibrator 从服务端校准。
    // 从零依赖的 `settings-storage` 引入（而非 units/tokens），避免 store 层的循环依赖。
    clearPreferenceKeys();
    // 同步复位**内存态**：`clearPreferenceKeys()` 只清 localStorage，若不复位 zustand / React 态，
    // 已挂载组件在本会话内仍显示上个账号的单位与深色，直到刷新页面。
    // 动态 import：units / useTheme 会（间接）依赖本模块，静态引入会形成循环。
    void import('@/lib/units').then(({ resetUnitPreference }) => resetUnitPreference());
    void import('@/theme/useTheme').then(({ resetThemePreference }) => resetThemePreference());
    // 待同步标记（dirty）属**账号 A 的未推改动**，不得带到账号 B：
    // 否则 B 登录后会把 A 的残留值当成「待同步本地值」补推给 B 的账号 —— 更难发现的跨账号污染。
    void import('@/lib/settings-sync').then(({ clearPendingSettings }) => clearPendingSettings());
    set({ accessToken: null, user: null, onboardingCompleted: false, status: 'anonymous' });
  },
}));

/** 读取当前 token（供非 React 环境 / fetch 封装使用）。 */
export function getAccessToken(): string | null {
  return useAuthStore.getState().accessToken;
}

/** 是否已登录。 */
export function isAuthenticated(): boolean {
  return useAuthStore.getState().accessToken !== null;
}
