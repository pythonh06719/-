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
  app.use(helmet());
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
  });
  app.enableShutdownHooks();

  await app.listen(config.port, '0.0.0.0');

  new Logger('Bootstrap').log(
    `「轻生活」API 已启动：http://localhost:${config.port}/api （环境：${config.nodeEnv}）`,
  );

  // 单 URL 部署：生产环境由 API 同源伺服前端 SPA（仅当 web 构建产物存在时启用）。
  // 注册顺序在 Nest 全部路由**之后**（listen 完成后追加），/api/* 与既有端点不受影响；
  // 其余路径命中静态文件，未命中回退 index.html（SPA 客户端路由）。
  if (config.nodeEnv === 'production') {
    // dist/apps/api/src/main.js → 上溯 4 级即仓库根；同时兜底 cwd 的两种常见取值
    // 候选（按运行时场景）：①编译产物相对（dist/apps/api/src 上溯 5 级 = 仓库根）
    // ②cwd = 仓库根（Render 的 startCommand 场景）③cwd = apps/api（本地冒烟场景）
    const webDistCandidates = [
      resolve(__dirname, '../../../../../../apps/web/dist'),
      resolve(process.cwd(), 'apps/web/dist'),
      resolve(process.cwd(), '../../apps/web/dist'),
    ];
    const webDist = webDistCandidates.find((candidate) => existsSync(join(candidate, 'index.html')));
    if (webDist !== undefined) {
      const expressApp = app.getHttpAdapter().getInstance() as import('express').Express;
      expressApp.use(express.static(webDist, { index: false }));
      expressApp.get(/^\/(?!api(\/|$)).*/, (_req, res) => {
        void res.sendFile(join(webDist, 'index.html'), (error) => {
          if (error && !res.headersSent) {
            res.status(404).end();
          }
        });
      });
      new Logger('Bootstrap').log(`SPA 静态伺服已启用：${webDist}（单 URL 部署模式）`);
    }
  }
}

void bootstrap();
