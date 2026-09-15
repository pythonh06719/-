import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * 全局 Prisma 模块：`PrismaService` 可在任意模块注入，无需重复 import。
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
