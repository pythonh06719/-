import { Module } from '@nestjs/common';

import { DashboardModule } from '../dashboard/dashboard.module';
import { ExerciseModule } from '../exercise/exercise.module';
import { FoodsModule } from '../foods/foods.module';
import { MealsModule } from '../meals/meals.module';
import { ReportModule } from '../report/report.module';
import { UsersModule } from '../users/users.module';
import { AgentService } from './agent.service';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { chatWithTools, getAiRuntimeConfig, LLM_CHAT_WITH_TOOLS } from './llm.client';

/**
 * AI 助手模块（三期，R9.1~R9.6 / R3.7）+ Agent（P0）。
 *
 * key 仅服务端环境变量（R9.5，读 `config/app-config.ts`）；零新依赖（Node 原生 fetch）。
 *
 * `LLM_CHAT_WITH_TOOLS` 抽成 provider 的目的：让 e2e 测试能替换为脚本化桩，
 * 从而在**不联网、不花钱**的前提下确定性验证多步工具调用、写操作确认、降级等路径。
 */
@Module({
  imports: [UsersModule, MealsModule, FoodsModule, DashboardModule, ExerciseModule, ReportModule],
  controllers: [AiController],
  providers: [
    AiService,
    AgentService,
    {
      provide: LLM_CHAT_WITH_TOOLS,
      useValue: (messages: Parameters<typeof chatWithTools>[1], tools: Parameters<typeof chatWithTools>[2]) =>
        chatWithTools(getAiRuntimeConfig(), messages, tools),
    },
  ],
  exports: [AiService, AgentService],
})
export class AiModule {}
