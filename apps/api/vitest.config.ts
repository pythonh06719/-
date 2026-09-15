import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

/**
 * `apps/api` 端到端测试配置（vitest + supertest）。
 *
 * ⚠️ 关键：被测应用**不经过 vitest 的 esbuild 转换** —— 测试通过 Node 原生 `require`
 * 加载 `nest build`（tsc）产出的 `dist/**` 制品。原因是 esbuild 不生成 NestJS 依赖注入
 * 所需的装饰器元数据 `design:paramtypes`（见 `test/api.e2e.test.ts` 顶部说明）；
 * tsc 产物才带有该元数据，且与生产运行的是同一份代码。
 *
 * 因此这里**不再需要** `esbuild.tsconfigRaw.emitDecoratorMetadata`（esbuild 本就不支持）。
 * `@qsh/core` 别名仅作兜底（若测试改回以 ESM 方式 import 源码时仍可用）。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@qsh/core': resolve(__dirname, '../../packages/core/src/index.ts'),
      '@qsh/shared-types': resolve(__dirname, '../../packages/shared-types/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
    // 首次执行前会 `nest build`（tsc + 别名改写），编译本身可能需要十几秒，故放宽超时。
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
