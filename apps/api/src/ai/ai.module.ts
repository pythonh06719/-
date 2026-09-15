import { Module } from '@nestjs/common';

import { MealsModule } from '../meals/meals.module';
import { UsersModule } from '../users/users.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

/**
 * AI 助手模块（三期，R9.1~R9.6 / R3.7）。
 *
 * key 仅服务端环境变量（R9.5，读 `config/app-config.ts`）；零新依赖（Node 原生 fetch）。
 */
@Module({
  imports: [UsersModule, MealsModule],
  controllers: [AiController],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
