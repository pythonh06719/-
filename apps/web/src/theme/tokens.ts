/**
 * 设计令牌（theme/tokens.ts）。
 *
 * 单一真源：颜色 / 圆角 / 节奏在此声明，供组件与深色模式共用（ARCHITECTURE §2 `src/theme/**`）。
 * 硬性语气约束（PRD §7）：**不提供红色恐吓语义** —— 正向用 `brand`，中性提醒用 `coral`。
 */

/** 主题模式：跟随系统 / 显式浅色 / 显式深色。 */
export type ThemeMode = 'system' | 'light' | 'dark';

/** 解析后的实际主题（用于 `<html class>`）。 */
export type ResolvedTheme = 'light' | 'dark';

/** 本地存储键（手动切换持久化，R2 / NFR-8）。 */
export const THEME_STORAGE_KEY = 'qsh:theme';

/** 令牌字面量（与 tailwind.config.ts 的调色板保持一致）。 */
export const TOKENS = {
  /** 品牌主色（正向、温和） */
  brand: {
    50: '#f0f7f4',
    100: '#d9ede4',
    300: '#8cc9ab',
    400: '#4fbf94',
    500: '#2f9e78',
    600: '#248263',
    700: '#1c6a51',
  },
  /** 中性暖色（用于「接近安全下限」等中性提示，非警告红） */
  coral: {
    100: '#fbe3d9',
    300: '#eda184',
    500: '#c95f3b',
    700: '#853a23',
  },
  /** 进度环渐变（柔和过渡，避免突变引发焦虑） */
  progressGradient: ['#4fbf94', '#2f9e78', '#248263'] as const,
  /** 深色模式下的进度环渐变（保证 AA 对比度） */
  progressGradientDark: ['#8cc9ab', '#4fbf94', '#2f9e78'] as const,
  /** 圆角与阴影节奏 */
  radius: { sm: '0.5rem', md: '0.75rem', lg: '1rem', xl: '1.5rem' },
} as const;

/** 饮水单次快捷量（ml，TC-33 / US-16）。 */
export const WATER_QUICK_ADD_ML = 250;

/** 一杯水的容量（ml）——用于把毫升换算成「第几杯」的生活化表达。 */
export const WATER_ML_PER_CUP = 250;

/** 默认每日饮水目标（ml）。 */
export const DEFAULT_WATER_GOAL_ML = 1500;

/** 各餐次在每日预算中的参考占比（「每餐独立预算」，R3.8）。 */
export const MEAL_BUDGET_SHARE = {
  breakfast: 0.25,
  lunch: 0.35,
  dinner: 0.3,
  snack: 0.1,
} as const;

/**
 * 本地缓存的预算摘要（引导结果 / 看板兜底 / 每餐预算分母）。
 * 与 `DashboardResponse['budget']` 结构兼容，字段宽松以容忍部分缓存。
 */
export interface ThemeBudget {
  /** 建议摄入 kcal（唯一必填项） */
  intakeRecommended: number;
  /** 基础代谢 kcal（可选） */
  bmr?: number;
  /** 每日总消耗 kcal（可选） */
  tdee?: number;
}
