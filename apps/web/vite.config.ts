import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { CACHE_NAMES, APP_SHELL_GLOB_PATTERNS } from './src/pwa/service-worker';

/**
 * Web 构建配置（ARCHITECTURE §5.4 / §1.9 / §7 K1）。
 *
 * - `@/` → `apps/web/src`
 * - `@qsh/core` / `@qsh/shared-types` 直接指向源码（前后端共享同一份契约，C1）
 * - dev proxy：`/api` → `http://localhost:3000`（与 T03 固定契约一致）
 * - PWA：`autoUpdate`；应用壳预缓存 + 只读数据（食物库/历史）离线兜底（TC-47）
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // 由 `src/pwa/registerSW.ts` 显式注册，便于在 UI 中反馈「新版本已就绪」
      injectRegister: null,
      // 使用 `public/manifest.webmanifest`，不重复生成
      manifest: false,
      workbox: {
        globPatterns: [...APP_SHELL_GLOB_PATTERNS],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          // 食物库（只读）→ StaleWhileRevalidate + 离线兜底（NFR-4）
          {
            urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/api/foods'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: CACHE_NAMES.foods,
              expiration: { maxEntries: 300, maxAgeSeconds: 7 * 24 * 3600 },
            },
          },
          // 历史记录（饮食/体重/看板）→ NetworkFirst，未成功时回退缓存副本（TC-47）
          {
            urlPattern: ({ url }: { url: URL }) =>
              /^\/api\/(meals|weights|dashboard)/.test(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: CACHE_NAMES.history,
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 300, maxAgeSeconds: 14 * 24 * 3600 },
            },
          },
          // 敏感接口（导出/删除/AI/鉴权）→ 不缓存，仅联网可用（ARCHITECTURE §1.9）
          {
            urlPattern: ({ url }: { url: URL }) =>
              /^\/api\/(auth|onboarding|profile|data|ai)/.test(url.pathname),
            handler: 'NetworkOnly',
            options: { cacheName: CACHE_NAMES.sensitive },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      // 各包内 `@/` → `src/`（K1）
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 跨包引用一律用包名，直接指向源码（前后端共享同一份代码，C1）
      '@qsh/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@qsh/shared-types': fileURLToPath(
        new URL('../../packages/shared-types/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      // ★ 固定契约：后端监听 3000，全局前缀 api
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    // 生产产物不内联 sourcemap：
    // ① 减小体积、加快首屏（NFR-3）；② 避免把内部源码与注释（含跨包 `@qsh/shared-types` 源码）
    // 一并公开发布，符合「数据/源码最小暴露」的隐私取向。需要调试时用 `npm run dev`。
    sourcemap: false,
  },
});
