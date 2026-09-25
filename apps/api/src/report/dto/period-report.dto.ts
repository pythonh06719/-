import { IsIn, IsOptional, Matches } from 'class-validator';

import type { PeriodDays } from '@qsh/shared-types';

import { LOCAL_DATE_PATTERN_STRICT } from '../../common/utils/date.util';

/**
 * `GET /api/report/period` 查询参数（R11.3）。
 *
 * ⚠️ `days` **缺省即 400**（不允许隐式默认 —— PM 拍板，避免口径猜测）；
 * 且只接受 30 / 365 两档（QR-3）。注意与 `endDate` 的规则**不同**：
 * `endDate` 可选（缺省今天），不要把两条规则写串（Q-4）。
 */
export class PeriodReportDto {
  /** 结束日期 `YYYY-MM-DD`；可选，缺省今天；晚于今天裁剪到今天 */
  @IsOptional()
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '日期格式应为 YYYY-MM-DD' })
  endDate?: string;

  /** 档位：30 / 365（必填） */
  @IsIn([30, 365], { message: '阶段回顾只支持近 30 天或近 365 天' })
  days!: PeriodDays;
}
