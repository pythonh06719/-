import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 组件测试配置（vitest + @testing-library/react + jsdom，T04 DoD #3）。
 *
 * 独立于 `vite.config.ts`：测试无需 PWA / dev proxy，避免 Workbox 在测试环境注册。
 */
export default defineConfig({
  // 缓存落在本 workspace 内（而非系统临时目录）：并行 worker 争抢系统临时目录缓存会触发 EPERM。
  cacheDir: './node_modules/.vite',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@qsh/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@qsh/shared-types': fileURLToPath(
        new URL('../../packages/shared-types/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    css: false,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    // 单进程串行跑文件：默认并行度下多个 worker 进程会并发写同一份 vite 缓存，
    // 在受限/代理文件系统上表现为 `EPERM` → 随机少跑测试文件、退出码非 0（结果不确定）。
    // 串行代价约 30s → 90s，换来的是「每次跑都是同一批用例、同一结果」，测试保护才成立。
    fileParallelism: false,
  },
});
