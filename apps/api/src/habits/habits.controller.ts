import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CheckinDto, CreateHabitDto } from './dto/habits.dto';
import { HabitsService } from './habits.service';

/**
 * 习惯控制器（`/api/habits/**`，R7.3 / R7.4）。
 * 无负罪感设计：只返回连续/最佳两个数字，**不发惩罚性提醒**。
 */
@Controller('habits')
@UseGuards(JwtAuthGuard)
export class HabitsController {
  constructor(private readonly habitsService: HabitsService) {}

  /** 全部习惯 + 今日状态 + 连续天数。 */
  @Get()
  list(@CurrentUser() userId: number) {
    return this.habitsService.list(userId);
  }

  /** 创建自定义习惯。 */
  @Post()
  @HttpCode(HttpStatus.OK)
  create(@CurrentUser() userId: number, @Body() dto: CreateHabitDto) {
    return this.habitsService.create(userId, dto);
  }

  /** 打卡 / 取消（`?id` 习惯）。 */
  @Post(':id/check')
  @HttpCode(HttpStatus.OK)
  checkin(@CurrentUser() userId: number, @Param('id', ParseIntPipe) id: number, @Body() dto: CheckinDto) {
    return this.habitsService.checkin(userId, id, dto);
  }

  /**
   * 停用自定义习惯（GAP-11）。
   *
   * 选用 `PATCH /habits/:id`（而非 `DELETE /habits/:id`，也不是 `PATCH /habits/:id/deactivate`）：
   * - **不做真删除**：`HabitCheckin.habitId` 外键是 `onDelete: Cascade`，真删会级联清空该习惯的
   *   全部历史打卡，进而让历史周报的 `habitsDone` / `habitsTotal` 数字**发生变化**，也违背
   *   「无负罪感」原则（用户想「不再做了」不等于「抹掉过去」）。停用只置 `isActive=false`，
   *   历史打卡原样保留，`report.service` 的 `isActive: true` 过滤会自动把它移出统计。
   * - 用 `PATCH /:id` 而非 `/:id/deactivate`：语义是「更新这条资源」，为将来「重新启用」
   *   （再置 `isActive=true`）留出同一路由，不必新增端点。
   *
   * 仅允许操作**本人**的习惯：他人记录与 `userId=null` 的内置模板一律 404（项目惯例越权返回 404）。
   * 幂等：对已停用的习惯重复调用仍返回成功。
   */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  deactivate(@CurrentUser() userId: number, @Param('id', ParseIntPipe) id: number) {
    return this.habitsService.deactivate(userId, id);
  }
}
