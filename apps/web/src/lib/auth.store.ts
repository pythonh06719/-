import { create } from 'zustand';
import type { AuthResponse, User } from '@qsh/shared-types';

/**
 * 登录态 Store（zustand）—— ARCHITECTURE §1.7「Access Token 内存保存」。
 *
 * ## 为什么 accessToken 只放内存（+ 可选 sessionStorage）
 *
 * 1. **安全**：`localStorage` 中的 token 会被任意同源脚本读取，一旦出现 XSS 即长期失窃；
 *    内存态在页面刷新后即失效，攻击面最小（ARCHITECTURE §1.7 明文约定「不落 localStorage」）。
 * 2. **可用性折中**：为保证「同一标签页内刷新不丢登录态」，本实现把 token **镜像**到
 *    `sessionStorage`（关闭标签页即清除，生命周期远短于 localStorage）。
 *    真正的长效登录由后端签发在 **HttpOnly Cookie** 中的 refreshToken 承担（前端不可读），
 *    刷新页面时通过 `GET /api/auth/me` 重新换取 accessToken。
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
