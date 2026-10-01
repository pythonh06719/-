import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import type { PeriodDays, PeriodReport, ReportCalendarResponse, WeeklyReport } from '@qsh/shared-types';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CalendarReportDto } from './dto/calendar-report.dto';
import { PeriodReportDto } from './dto/period-report.dto';
import { WeeklyReportDto } from './dto/weekly-report.dto';
import { ReportService } from './report.service';

/** 周报 / 阶段回顾 / 记录足迹控制器（`/api/report/**`，R4.1 / R4.2 / R11.1 / R11.3 / R11.7 / C-1）。 */
@Controller('report')
@UseGuards(JwtAuthGuard)
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  /** 近 7 天周报（`?endDate=YYYY-MM-DD`，缺省今天）。R11.7：响应新增多样性三字段（向后兼容）。 */
  @Get('weekly')
  weekly(@CurrentUser() userId: number, @Query() query: WeeklyReportDto): Promise<WeeklyReport> {
    return this.reportService.weekly(userId, query.endDate);
  }

  /**
   * 阶段回顾（`?endDate=&days=30|365`，R11.3）。
   * `days` 缺省 / 非 30|365 → 400（不允许隐式默认，见 `PeriodReportDto`）。
   */
  @Get('period')
  period(@CurrentUser() userId: number, @Query() query: PeriodReportDto): Promise<PeriodReport> {
    return this.reportService.period(userId, query.days as PeriodDays, query.endDate);
  }

  /**
   * 记录足迹日历（`?month=YYYY-MM`，C-1）。
   * `month` 缺省 / 非法 → 400（不允许隐式默认，见 `CalendarReportDto`）。
   */
  @Get('calendar')
  calendar(@CurrentUser() userId: number, @Query() query: CalendarReportDto): Promise<ReportCalendarResponse> {
    return this.reportService.calendar(userId, query.month);
  }
}
