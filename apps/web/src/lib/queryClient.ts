import { QueryClient } from '@tanstack/react-query';
import { isNetworkError } from './api';

/**
 * React Query 客户端（lib/queryClient.ts）。
 *
 * 设计要点（ARCHITECTURE §1.9 离线策略 / §1.2 状态层选型）：
 * - `staleTime` 30s：饮食 / 体重等「当日会变」的数据不至于频繁重取，又不至于太陈旧；
 * - `gcTime` 30min：切页后短时间内返回可命中缓存（离线可看历史，TC-47）；
 * - `retry`：**网络层错误不重试**（后端未就绪时不无意义地打请求），其他错误最多重试 1 次；
 * - `networkMode: 'offlineFirst'`：断网时优先返回缓存副本，避免白屏；
 * - `refetchOnWindowFocus: false`：移动端切回前台不打断输入（记录流程友好）。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 30 * 60_000,
      networkMode: 'offlineFirst',
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (isNetworkError(error)) {
          return false;
        }
        return failureCount < 1;
      },
    },
    mutations: {
      networkMode: 'offlineFirst',
      retry: 0,
    },
  },
});

/** 常用查询键工厂（保证键名集中、避免拼写漂移）。 */
export const queryKeys = {
  me: ['auth', 'me'] as const,
  dashboard: (date: string) => ['dashboard', date] as const,
  meals: (date: string) => ['meals', date] as const,
  foodSearch: (keyword: string, category: string) => ['foods', 'search', keyword, category] as const,
  foodLiveSearch: (keyword: string) => ['foods', 'live-search', keyword] as const,
  foodCategories: ['foods', 'categories'] as const,
  foodRecent: ['foods', 'recent'] as const,
  foodFavorites: ['foods', 'favorites'] as const,
  combos: ['meal-combos'] as const,
  weightTrend: ['weights', 'trend'] as const,
  profile: ['profile'] as const,
  // 二期（T05）
  exerciseDay: (date: string) => ['exercises', date] as const,
  exerciseActivities: ['exercises', 'activities'] as const,
  waterDay: (date: string) => ['water', date] as const,
  habits: ['habits'] as const,
  weeklyReport: (endDate: string) => ['report', 'weekly', endDate] as const,
  fastingSettings: ['fasting', 'settings'] as const,
  fastingCurrent: ['fasting', 'current'] as const,
  // 三期（T05 三期）：AI 助手（结果按日期 / 问题缓存，敏感接口不落盘、仅内存）
  aiDailySummary: (date: string) => ['ai', 'daily-summary', date] as const,
  aiTodayPlan: (date: string) => ['ai', 'today-plan', date] as const,
  aiFreeAsk: (date: string, question: string) => ['ai', 'free-ask', date, question] as const,
  aiRecognizeFood: (description: string) => ['ai', 'recognize-food', description] as const,
} as const;
