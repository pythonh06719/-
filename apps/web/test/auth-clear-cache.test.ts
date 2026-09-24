/**
 * 登出清缓存的安全回归测试。
 *
 * `clear()` 是「退出登录」（ProfilePage）与「401 自动登出」（App 的 UnauthorizedListener）
 * 两条路径的**共同入口**，所以清理必须放在这里才能一次覆盖两边。
 *
 * 为什么这是安全问题：`lib/local-cache.ts` 的键是「日期 + 资源」（如 `qsh:cache:meals:2026-09-24`），
 * **不含用户身份**。若退出登录时不清，同一浏览器换账号后，离线/慢网兜底会把**上一个账号**的
 * 饮食、体重、看板数据展示给新用户 —— 跨账号数据泄漏。
 * （Service Worker 那一层已于同期改为不缓存用户数据接口，两道防线缺一不可。）
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { CACHE_KEYS, cacheClearAll, cacheGet, cacheSet } from '@/lib/local-cache';
import { useAuthStore } from '@/lib/auth.store';

const DAY = '2026-09-24';

describe('登出时清空本地缓存（跨账号泄漏防护）', () => {
  beforeEach(() => {
    cacheClearAll();
    useAuthStore.getState().clear();
  });

  it('clear() 会清掉已写入的缓存', () => {
    cacheSet(CACHE_KEYS.meals(DAY), { groups: [], totalKcal: 0 });
    expect(cacheGet(CACHE_KEYS.meals(DAY))).not.toBeNull();

    useAuthStore.getState().clear();

    expect(cacheGet(CACHE_KEYS.meals(DAY))).toBeNull();
  });

  it('clear() 之后登录态归零', () => {
    useAuthStore.getState().clear();

    const state = useAuthStore.getState();
    expect(state.accessToken).toBeNull();
    expect(state.user).toBeNull();
    expect(state.status).toBe('anonymous');
  });

  it('清理是幂等的（重复登出不报错）', () => {
    cacheSet(CACHE_KEYS.meals(DAY), { groups: [], totalKcal: 0 });
    useAuthStore.getState().clear();
    expect(() => useAuthStore.getState().clear()).not.toThrow();
    expect(cacheGet(CACHE_KEYS.meals(DAY))).toBeNull();
  });
});
