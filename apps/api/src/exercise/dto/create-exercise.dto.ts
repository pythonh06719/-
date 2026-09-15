import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

import { MET_ACTIVITY_LIBRARY } from '@qsh/core';

import { LOCAL_DATE_PATTERN_STRICT } from '../../common/utils/date.util';

/** 合法活动编码（来自 core 内置 MET 表）。 */
const ACTIVITY_CODES = MET_ACTIVITY_LIBRARY.map((activity) => activity.code) as [string, ...string[]];

/** `POST /api/exercises` 请求体（R6.1）。 */
export class CreateExerciseDto {
  /** 记录日期 `YYYY-MM-DD`（缺省 = 今天） */
  @IsOptional()
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '日期格式应为 YYYY-MM-DD' })
  loggedDate?: string;

  /** 活动编码（`@qsh/core` 内置 MET 表） */
  @IsIn(ACTIVITY_CODES, { message: '请选择运动类型' })
  activityCode!: string;

  /** 时长（分钟，1–480） */
  @Type(() => Number)
  @IsInt({ message: '时长需为整数分钟' })
  @Min(1, { message: '时长至少 1 分钟' })
  @Max(480, { message: '单次时长不超过 480 分钟' })
  minutes!: number;

  /** 备注（≤200 字） */
  @IsOptional()
  @IsString({ message: '备注需为文本' })
  @MaxLength(200, { message: '备注最多 200 字' })
  note?: string;
}

/** `POST /api/exercises/estimate` 请求体（不落库，仅试算）。 */
export class EstimateExerciseDto {
  /** 活动编码 */
  @IsIn(ACTIVITY_CODES, { message: '请选择运动类型' })
  activityCode!: string;

  /** 体重 kg（服务端用档案体重优先） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '体重需为数字' })
  @Min(20, { message: '体重需在 20–400 kg 之间' })
  @Max(400, { message: '体重需在 20–400 kg 之间' })
  weightKg?: number;

  /** 时长（分钟） */
  @Type(() => Number)
  @IsInt({ message: '时长需为整数分钟' })
  @Min(1, { message: '时长至少 1 分钟' })
  @Max(480, { message: '单次时长不超过 480 分钟' })
  minutes!: number;
}
