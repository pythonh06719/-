import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';

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
}
