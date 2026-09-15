import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

import type { WeightLogSource } from '@qsh/shared-types';

import { LOCAL_DATE_PATTERN_STRICT } from '../../common/utils/date.util';

/** `POST /api/weights` 请求体（R7.1；同日重复 = 覆盖，TC-34）。 */
export class CreateWeightDto {
  /** 记录日期 `YYYY-MM-DD`（缺省 = 服务端本地今天） */
  @IsOptional()
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '日期格式应为 YYYY-MM-DD' })
  loggedAt?: string;

  /** 体重 kg（0 < w < 500） */
  @Type(() => Number)
  @IsNumber({}, { message: '体重需为数字' })
  @Min(0.1, { message: '体重需大于 0' })
  @Max(499.9, { message: '体重需小于 500' })
  weightKg!: number;

  /** 备注（≤200 字） */
  @IsOptional()
  @IsString({ message: '备注需为文本' })
  @MaxLength(200, { message: '备注最多 200 字' })
  note?: string;

  /** 来源 */
  @IsOptional()
  @IsIn(['manual', 'import'], { message: '来源不正确' })
  source?: WeightLogSource;
}
