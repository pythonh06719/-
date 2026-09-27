import { defineConfig } from 'vitest/config';

/**
 * `@qsh/core` 单测配置。
 *
 * - 覆盖率阈值（lines / functions / branches / statements ≥ 90%）作为**门禁**，
 *   低于阈值即让测试失败（对齐 NFR-5：热量引擎单元测试必须覆盖全部公式与边界）。
 * - 排除纯类型文件与统一导出面（无运行时代码，不应计入覆盖率分母）。
 */
export default defineConfig({
  // 缓存落在本 workspace 内（而非系统临时目录）：多 workspace 并行跑测试时，
  // 共用系统临时目录会争抢同一份依赖缓存（并发写 → EPERM），默认并行度下会随机丢测试文件。
  cacheDir: './node_modules/.vite',
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // 单进程串行跑文件（与 `apps/web` 同款处理）：并行 worker 并发写缓存目录会触发 EPERM，
    // 导致测试文件被静默跳过、覆盖率分母变小（甚至误报达标）。串行保证覆盖率门禁可信。
    fileParallelism: false,
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
