import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import type { ActivityLevel, Gender } from '@qsh/core';

import { LOCAL_DATE_PATTERN_STRICT } from '../../common/utils/date.util';
import { MacroRatioDto } from './macro-ratio.dto';

/**
 * `PATCH /api/profile` 请求体（R1.4 / TC-12）。
 *
 * 基础字段与 `@qsh/shared-types` 的 `UpdateProfileRequest` 对齐；
 * **额外**支持体重 / 目标类字段（`currentWeightKg` / `targetWeightKg` / `targetWeeks` / `macroRatio`），
 * 任一变更都会触发**服务端重算并落库**（TC-12）。均为可选，不影响原契约调用方。
 */
export class UpdateProfileDto {
  /** 性别 */
  @IsOptional()
  @IsIn(['male', 'female'], { message: '请选择性别' })
  gender?: Gender;

  /** 出生日期 `YYYY-MM-DD` */
  @IsOptional()
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '出生日期格式应为 YYYY-MM-DD' })
  birthDate?: string;

  /** 身高（cm） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '身高需为数字' })
  @Min(80, { message: '身高需在 80–250 cm 之间' })
  @Max(250, { message: '身高需在 80–250 cm 之间' })
  heightCm?: number;

  /** 活动量档位 */
  @IsOptional()
  @IsIn(['sedentary', 'light', 'moderate', 'high', 'athlete'], { message: '请选择活动量档位' })
  activityLevel?: ActivityLevel;

  /** 饮食偏好 */
  @IsOptional()
  @IsArray({ message: '饮食偏好需为数组' })
  @IsString({ each: true, message: '饮食偏好需为文本' })
  dietaryPreference?: string[];

  /** 常见疾病（敏感） */
  @IsOptional()
  @IsArray({ message: '常见疾病需为数组' })
  @IsString({ each: true, message: '常见疾病需为文本' })
  conditions?: string[];

  // --- 以下为契约扩展：变更即触发服务端重算（TC-12）---

  /** 当前体重（kg） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '体重需为数字' })
  @Min(20, { message: '体重需在 20–400 kg 之间' })
  @Max(400, { message: '体重需在 20–400 kg 之间' })
  currentWeightKg?: number;

  /** 目标体重（kg） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '目标体重需为数字' })
  @Min(1, { message: '目标体重需大于 0' })
  @Max(400, { message: '目标体重不能大于 400 kg' })
  targetWeightKg?: number;

  /** 目标期限（整数周） */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '目标期限需为整数周' })
  @Min(1, { message: '目标期限需在 1–260 周之间' })
  @Max(260, { message: '目标期限需在 1–260 周之间' })
  targetWeeks?: number;

  /** 宏量比例（三者和须 = 100） */
  @IsOptional()
  @ValidateNested()
  @Type(() => MacroRatioDto)
  macroRatio?: MacroRatioDto;
}
