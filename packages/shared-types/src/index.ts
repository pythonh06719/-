/**
 * `@qsh/shared-types` 统一导出面（ARCHITECTURE §1.6 / §2）。
 *
 * 本包为**纯类型包、零运行时依赖**：只提供 `interface` / `type` 与少量结构化常量，
 * 不含任何可执行逻辑，可同时被 `apps/web` 与 `apps/api` 引用。
 *
 * 引擎相关类型（`CalorieInput` / `CalorieResult` / `Gender` / `ActivityLevel` / `MacroRatio`
 * / `Validation*` …）**一律从 `@qsh/core` 重新导出**，不重复定义，确保前后端与引擎契约同源。
 */

// 实体（与 docs/SCHEMA.sql 逐表对应）
export * from './entities';

// API 契约（统一响应包装 + 各接口 DTO）
export * from './api';

// AI 助手契约（三期，R9.x / R3.7）
export * from './ai';

// 数据主权契约（PRD §9 导出/导入）
export * from './export';

// ---------------------------------------------------------------------------
// 复用引擎类型（唯一真源：@qsh/core）
// ---------------------------------------------------------------------------

export type {
  ActivityLevel,
  CalorieInput,
  CalorieResult,
  Gender,
  GoalForecastInput,
  GoalForecastPoint,
  MacroRatio,
  MacroResult,
  SafeCalorieResult,
  SafetyFlags,
  ValidationError,
  ValidationReport,
  ValidationWarning,
} from '@qsh/core';
