import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import {
  AgentAskDto,
  AgentConfirmDto,
  DailySummaryDto,
  FreeAskDto,
  RecognizeFoodDto,
  TodayPlanDto,
} from './dto/ai.dto';
import { AgentService } from './agent.service';
import { AiService } from './ai.service';

/**
 * AI 助手控制器（`/api/ai/**`，三期 R9.1~R9.6 / R3.7）。
 *
 * - 全部鉴权（`userId` 一律取 JWT，K7）；响应统一 `{ data, error }`（K2）；
 * - key 仅服务端（R9.5）：请求 / 响应中不出现任何 AI 凭据；
 * - 所有端点 POST + 200（与其他写端点一致，QA BUG-P2-2 同口径）。
 */
@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly agentService: AgentService,
  ) {}

  /** 每日总结（R9.1）：当日复盘 = 直接结论 + 依据 + 一条可执行建议。 */
  @Post('daily-summary')
  @HttpCode(HttpStatus.OK)
  dailySummary(@CurrentUser() userId: number, @Body() dto: DailySummaryDto) {
    return this.aiService.dailySummary(userId, dto);
  }

  /** 今日方案（R9.2）：据最近两日记录生成；数据未变则复用缓存（不计数）。 */
  @Post('today-plan')
  @HttpCode(HttpStatus.OK)
  todayPlan(@CurrentUser() userId: number, @Body() dto: TodayPlanDto) {
    return this.aiService.todayPlan(userId, dto);
  }

  /** 自由提问（R9.3）：医疗意图走固定就医回复（R9.6）。 */
  @Post('free-ask')
  @HttpCode(HttpStatus.OK)
  freeAsk(@CurrentUser() userId: number, @Body() dto: FreeAskDto) {
    return this.aiService.freeAsk(userId, dto);
  }

  /** 食物识别（R3.7）：文字描述 → 食物库候选；**不直接写 meal_logs**，需用户确认。 */
  @Post('recognize-food')
  @HttpCode(HttpStatus.OK)
  recognizeFood(@CurrentUser() userId: number, @Body() dto: RecognizeFoodDto) {
    return this.aiService.recognizeFood(userId, dto);
  }

  // ---------------------------------------------------------------------------
  // Agent（P0）：模型自主调用领域工具的**多步**执行循环
  // ---------------------------------------------------------------------------

  /**
   * Agent 提问（P0）：由模型决定调用哪些工具（查食物 / 看板 / 运动换算 / 周报）。
   * 写操作（记一餐）不直接执行 —— 返回 `status: 'need_confirm'` 与待办卡片，
   * 由前端引导用户确认后调用 `/ai/agent/confirm`。
   */
  @Post('agent')
  @HttpCode(HttpStatus.OK)
  agent(@CurrentUser() userId: number, @Body() dto: AgentAskDto) {
    return this.agentService.run(userId, dto.question, dto.date);
  }

  /** 确认并执行 Agent 的待办写操作（human-in-the-loop 第二半）。 */
  @Post('agent/confirm')
  @HttpCode(HttpStatus.OK)
  agentConfirm(@CurrentUser() userId: number, @Body() dto: AgentConfirmDto) {
    return this.agentService.confirm(userId, dto.traceId);
  }

  /** 查看自己的 Agent 执行轨迹（可观测性：工具链 / 耗时 / token）。 */
  @Get('agent/traces')
  agentTraces(@CurrentUser() userId: number, @Query('limit') limit?: string) {
    return this.agentService.listTraces(userId, Number(limit ?? 20) || 20);
  }
}
