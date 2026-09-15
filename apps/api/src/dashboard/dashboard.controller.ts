import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import type { DashboardResponse } from '@qsh/shared-types';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DashboardService } from './dashboard.service';
import { DashboardQueryDto } from './dto/dashboard-query.dto';

/** 看板控制器（`/api/dashboard`，US-05）。`userId` 一律取自 JWT（K7）。 */
@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /** 今日看板（`?date=YYYY-MM-DD` 缺省为今天）。 */
  @Get()
  get(@CurrentUser() userId: number, @Query() query: DashboardQueryDto): Promise<DashboardResponse> {
    return this.dashboardService.get(userId, query.date);
  }
}
