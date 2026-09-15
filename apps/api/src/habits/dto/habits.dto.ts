import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

import { LOCAL_DATE_PATTERN_STRICT } from '../../common/utils/date.util';

/** `POST /api/habits`（创建自定义习惯，R7.3）。 */
export class CreateHabitDto {
  /** 稳定标识（如 water / early_sleep / steps / no_takeout） */
  @IsString({ message: '标识需为文本' })
  @MinLength(1, { message: '标识不能为空' })
  @MaxLength(40, { message: '标识最多 40 字符' })
  code!: string;

  /** 展示名 */
  @IsString({ message: '名称需为文本' })
  @MinLength(1, { message: '名称不能为空' })
  @MaxLength(30, { message: '名称最多 30 字' })
  name!: string;

  /** 图标（emoji，可空） */
  @IsOptional()
  @IsString({ message: '图标需为文本' })
  @MaxLength(8, { message: '图标过长' })
  icon?: string;

  /** 每日目标次数（1–99） */
  @IsOptional()
  @IsInt({ message: '目标需为整数' })
  @Min(1, { message: '目标至少 1 次' })
  @Max(99, { message: '目标最多 99 次' })
  targetPerDay?: number;
}

/** `POST /api/habits/:id/check`（打卡 / 取消，R7.3）。 */
export class CheckinDto {
  /** 打卡日期 `YYYY-MM-DD`（缺省 = 今天） */
  @IsOptional()
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '日期格式应为 YYYY-MM-DD' })
  loggedDate?: string;

  /** true = 打卡；false = 取消当日打卡 */
  @IsBoolean({ message: 'done 需为布尔值' })
  done!: boolean;

  /** 可选数值（如步数） */
  @IsOptional()
  @IsInt({ message: '数值需为整数' })
  @Min(0, { message: '数值不能为负' })
  @Max(1000000, { message: '数值过大' })
  value?: number;
}
