import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 组件测试配置（vitest + @testing-library/react + jsdom，T04 DoD #3）。
 *
 * 独立于 `vite.config.ts`：测试无需 PWA / dev proxy，避免 Workbox 在测试环境注册。
 */
export default defineConfig({
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
  },
});
