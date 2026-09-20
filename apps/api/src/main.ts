import 'reflect-metadata';

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { getAppConfig } from './config/app-config';

/**
 * 应用引导（ARCHITECTURE §2 / §1.7）。
 *
 * - 全局前缀 `api`（对外即 `http://localhost:3000/api/*`）；
 * - `helmet()` 安全头；
 * - CORS 白名单（默认允许 `http://localhost:5173`）；
 * - 全局 `ValidationPipe` / `ResponseInterceptor` / `AllExceptionsFilter` 在 `AppModule`
 *   通过 `APP_*` 令牌注册（对 e2e 测试同样生效）；
 * - `enableShutdownHooks()` 优雅关闭（配合 `PrismaService.onModuleDestroy`）。
 */
async function bootstrap(): Promise<void> {
  const config = getAppConfig();

  // 生产环境 fail-fast（代码审查 #1）：禁止用仓库内公开的开发兜底密钥上生产
  const DEV_SECRET = 'dev-only-insecure-secret-change-me-0123456789abcdef';
  if (config.nodeEnv === 'production' && config.jwtSecret === DEV_SECRET) {
    throw new Error('JWT_SECRET 仍是开发兜底值 —— 生产环境必须在 .env 里设置强随机密钥后再启动');
  }

  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.setGlobalPrefix('api');
  /**
   * `helmet()` 的默认 CSP 是 `script-src 'self'` —— 会**连带拦掉** `apps/web/index.html` 里那段
   * 「首屏前预置深色主题」的内联脚本（它的唯一作用就是防深色用户看到浅色闪一下）。
   * 单 URL 部署下 HTML 由本服务伺服，CSP 因此生效；dev 模式 HTML 走 Vite，故本地开发看不出来。
   *
   * 修法用 **hash 白名单**而非 `'unsafe-inline'`：后者会让所有内联脚本放行，削弱 XSS 防护。
   * ⚠️ 该 hash 与 index.html 中那段脚本**逐字节绑定**（含换行与缩进）—— 改动那段脚本后必须重算，
   *    否则线上会再次静默拦掉。重算：`node apps/api/scripts/check-csp-hash.mjs --print`；
   *    一致性由同一脚本在 CI 里门禁（见 .github/workflows/ci.yml 的 backend job）。
   */
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'script-src': ["'self'", "'sha256-EwE7ng8Sn9jRAxvZU3s00JgGew5k7sheS3OiKHfU308='"],
        },
      },
    }),
  );
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
  });
  // 单 URL 部署：生产环境由 API 同源伺服前端 SPA（仅当 web 构建产物存在时启用）。
  // 须在 listen 前注册：/api/* 由 Nest 处理，其余 GET 回退 index.html（SPA 客户端路由）。
  if (config.nodeEnv === 'production') {
    // 候选路径：①编译产物相对（dist/apps/api/src 上溯 6 级 = 仓库根）
    // ②cwd = 仓库根（Render startCommand 场景）③cwd = apps/api（本地冒烟场景）
    const webDistCandidates = [
      resolve(__dirname, '../../../../../../apps/web/dist'),
      resolve(process.cwd(), 'apps/web/dist'),
      resolve(process.cwd(), '../../apps/web/dist'),
    ];
    const webDist = webDistCandidates.find((candidate) => existsSync(join(candidate, 'index.html')));
    if (webDist !== undefined) {
      const expressApp = app.getHttpAdapter().getInstance() as import('express').Express;
      expressApp.use(express.static(webDist, { index: false }));
      expressApp.use((req, res, next) => {
        if (req.method !== 'GET' || req.path.startsWith('/api')) {
          next();
          return;
        }
        void res.sendFile(join(webDist, 'index.html'), (error) => {
          if (error && !res.headersSent) {
            res.status(404).end();
          }
        });
      });
      new Logger('Bootstrap').log(`SPA 静态伺服已启用：${webDist}（单 URL 部署模式）`);
    }
  }
  app.enableShutdownHooks();

  await app.listen(config.port, '0.0.0.0');

  new Logger('Bootstrap').log(
    `「轻生活」API 已启动：http://localhost:${config.port}/api （环境：${config.nodeEnv}）`,
  );

}

void bootstrap();
