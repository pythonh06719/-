import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { PrismaClient } from '@prisma/client';

import { loadEnv } from '../config/app-config';

/**
 * Prisma 客户端服务（连接生命周期托管）。
 *
 * - `onModuleInit` 建立连接；
 * - `onModuleDestroy` 断开连接（配合 `app.enableShutdownHooks()`）。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super();
    loadEnv();
  }

  /** 启动时连接数据库。 */
  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('数据库连接已建立');
  }

  /** 关闭时断开连接。 */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('数据库连接已断开');
  }
}
