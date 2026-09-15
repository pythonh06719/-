import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

import { LOCAL_DATE_PATTERN_STRICT } from '../../common/utils/date.util';

/** `POST /api/water` 请求体（R6.3：一键 +250ml，可传其他量）。 */
export class CreateWaterDto {
  /** 水量 ml（缺省 250，1–2000） */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '水量需为整数 ml' })
  @Min(1, { message: '水量至少 1 ml' })
  @Max(2000, { message: '单次不超过 2000 ml' })
  amountMl?: number;

  /** 记录日期 `YYYY-MM-DD`（缺省 = 今天） */
  @IsOptional()
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '日期格式应为 YYYY-MM-DD' })
  loggedDate?: string;
}

/** `PATCH /api/water/goal` 请求体（自定义每日目标）。 */
export class UpdateWaterGoalDto {
  /** 每日目标 ml（500–8000） */
  @Type(() => Number)
  @IsInt({ message: '目标需为整数 ml' })
  @Min(500, { message: '目标至少 500 ml' })
  @Max(8000, { message: '目标不超过 8000 ml' })
  waterGoalMl!: number;
}
