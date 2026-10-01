import { IsMonthKey } from '../../common/validators/month-key.validator';

/**
 * `GET /api/report/calendar` 查询参数（C-1 记录足迹日历）。
 *
 * ⚠️ `month` **必填**（不允许隐式默认当前月 —— 避免口径猜测，同 `/report/period` 的 `days`）；
 * 只接受严格的 `YYYY-MM`（`01~12` 两位月），非法 → 400。
 */
export class CalendarReportDto {
  /** 月份 `YYYY-MM`（必填）。 */
  @IsMonthKey({ message: '月份格式应为 YYYY-MM' })
  month!: string;
}
