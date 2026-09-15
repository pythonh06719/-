import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
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
}

void bootstrap();
