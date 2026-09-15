import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/** 常见断食窗口（R8.1）。 */
const PLANS = ['16:8', '18:6', '20:4', 'custom'] as const;

/** `PATCH /api/fasting/settings` 请求体（R8.1 / R8.2）。 */
export class UpdateFastingSettingsDto {
  /** 断食方案 */
  @IsOptional()
  @IsIn(PLANS, { message: '请选择常见断食窗口' })
  plan?: string;

  /** 目标断食小时数（1–36，custom 必填） */
  @IsOptional()
  @IsNumber({}, { message: '目标时长需为数字' })
  @Min(1, { message: '目标时长至少 1 小时' })
  @Max(36, { message: '目标时长不超过 36 小时' })
  targetFastHours?: number;

  /** 进食窗口起点 `HH:mm` */
  @IsOptional()
  @IsString({ message: '时间需为文本' })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: '时间格式应为 HH:mm' })
  eatWindowStart?: string;

  /** 是否启用（R8.4：默认关闭） */
  @IsOptional()
  @IsBoolean({ message: 'enabled 需为布尔值' })
  enabled?: boolean;

  /**
   * **内容警告确认时间**（R8.2 / TC-30）。
   * 服务端强制：把 `enabled` 置 true 时必须携带该字段 —— 首次开启必须先看到内容警告。
   */
  @IsOptional()
  @IsString({ message: '确认时间需为文本' })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, { message: '确认时间应为 ISO8601' })
  disclaimerAckAt?: string;
}
