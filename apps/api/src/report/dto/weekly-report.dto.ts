import { IsOptional } from 'class-validator';

import { IsLocalDateKey } from '../../common/validators/local-date-key.validator';

/**
 * `GET /api/report/weekly` 查询参数（R4.1 / R11.7）。
 *
 * ⚠️ 此前 `endDate` 是裸 `@Query('endDate')`，**完全未经校验**：`?endDate=2026-02-31`
 * 会被 `addDays` 静默运算成 3 月（日期错位）。改为 DTO + `@IsLocalDateKey`，
 * 与 `/report/period` 口径一致（非法日期 → 400，而不是悄悄算成别的日期）。
 */
export class WeeklyReportDto {
  /** 结束日期 `YYYY-MM-DD`；可选，缺省今天。 */
  @IsOptional()
  @IsLocalDateKey({ message: '日期格式应为 YYYY-MM-DD' })
  endDate?: string;
}
