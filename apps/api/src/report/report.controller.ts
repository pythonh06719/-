import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ReportService } from './report.service';

/** 周报控制器（`/api/report/**`，R4.1 / R4.2 / R11.1）。 */
@Controller('report')
@UseGuards(JwtAuthGuard)
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  /** 近 7 天周报（`?endDate=YYYY-MM-DD`，缺省今天）。 */
  @Get('weekly')
  weekly(@CurrentUser() userId: number, @Query('endDate') endDate?: string) {
    return this.reportService.weekly(userId, endDate);
  }
}
