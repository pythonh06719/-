import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 组件测试配置（vitest + @testing-library/react + jsdom，T04 DoD #3）。
 *
 * 独立于 `vite.config.ts`：测试无需 PWA / dev proxy，避免 Workbox 在测试环境注册。
 */
export default defineConfig({
  // 缓存落在本 workspace 内（而非系统临时目录）：便于本地隔离，减少与其它 workspace 的争抢。
  // ⚠️ 归因澄清：真正根治 EPERM 的是下面的 `fileParallelism: false`，**不是** 这个 cacheDir ——
  // 实测报错路径落在**系统临时目录**（`os.tmpdir()`，如 Windows 的 `%TEMP%`），改 cacheDir 并不消除它。
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
    // 单进程串行跑文件：默认并行度下多个 worker 进程会并发写**系统临时目录**（`os.tmpdir()`，
    // 如 Windows `%TEMP%`）中的中间文件，在受限/代理文件系统上表现为 `EPERM` →
    // 随机少跑测试文件、退出码非 0（结果不确定）。串行后不再有并发写，EPERM 随之消失。
    // 串行代价约 30s → 90s，换来的是「每次跑都是同一批用例、同一结果」，测试保护才成立。
    fileParallelism: false,
  },
});
