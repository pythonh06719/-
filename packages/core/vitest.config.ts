import { defineConfig } from 'vitest/config';

/**
 * `@qsh/core` 单测配置。
 *
 * - 覆盖率阈值（lines / functions / branches / statements ≥ 90%）作为**门禁**，
 *   低于阈值即让测试失败（对齐 NFR-5：热量引擎单元测试必须覆盖全部公式与边界）。
 * - 排除纯类型文件与统一导出面（无运行时代码，不应计入覆盖率分母）。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/types.ts', '**/*.d.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
