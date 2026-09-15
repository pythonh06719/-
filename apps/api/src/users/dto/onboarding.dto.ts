import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
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
 * `POST /api/onboarding` 请求体（R1.3 / US-03）。
 *
 * 字段与 `@qsh/shared-types` 的 `OnboardingRequest` 对齐；额外支持用 `age`（周岁）替代 `birthDate`，
 * 二者至少提供一个（服务层校验），其余字段语义完全一致。
 * ⚠️ **不含 `userId`**：服务端一律从 JWT 取 `sub`（K7 / TC-42）。
 */
export class OnboardingDto {
  /** 性别 */
  @IsIn(['male', 'female'], { message: '请选择性别' })
  gender!: Gender;

  /** 出生日期 `YYYY-MM-DD` */
  @IsOptional()
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '出生日期格式应为 YYYY-MM-DD' })
  birthDate?: string;

  /** 周岁（14–100），`birthDate` 缺省时使用 */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '年龄需为整数' })
  @Min(14, { message: '年龄需在 14–100 之间' })
  @Max(100, { message: '年龄需在 14–100 之间' })
  age?: number;

  /** 身高（cm） */
  @Type(() => Number)
  @IsNumber({}, { message: '请输入身高' })
  @Min(80, { message: '身高需在 80–250 cm 之间' })
  @Max(250, { message: '身高需在 80–250 cm 之间' })
  heightCm!: number;

  /** 当前体重（kg） */
  @Type(() => Number)
  @IsNumber({}, { message: '请输入当前体重' })
  @Min(20, { message: '体重需在 20–400 kg 之间' })
  @Max(400, { message: '体重需在 20–400 kg 之间' })
  currentWeightKg!: number;

  /** 目标体重（kg） */
  @Type(() => Number)
  @IsNumber({}, { message: '请输入目标体重' })
  @Min(1, { message: '目标体重需大于 0' })
  @Max(400, { message: '目标体重不能大于 400 kg' })
  targetWeightKg!: number;

  /** 目标期限（整数周） */
  @Type(() => Number)
  @IsInt({ message: '目标期限需为整数周' })
  @Min(1, { message: '目标期限需在 1–260 周之间' })
  @Max(260, { message: '目标期限需在 1–260 周之间' })
  targetWeeks!: number;

  /** 活动量档位 */
  @IsIn(['sedentary', 'light', 'moderate', 'high', 'athlete'], { message: '请选择活动量档位' })
  activityLevel!: ActivityLevel;

  /** 饮食偏好（可空） */
  @IsOptional()
  @IsArray({ message: '饮食偏好需为数组' })
  @IsString({ each: true, message: '饮食偏好需为文本' })
  dietaryPreference?: string[];

  /** 常见疾病（**敏感**，D3；可空） */
  @IsOptional()
  @IsArray({ message: '常见疾病需为数组' })
  @IsString({ each: true, message: '常见疾病需为文本' })
  conditions?: string[];

  /** 自定义宏量比例（可空，缺省 25/25/50） */
  @IsOptional()
  @ValidateNested()
  @Type(() => MacroRatioDto)
  macroRatio?: MacroRatioDto;

  /** 是否已确认免责声明（US-04 / R1.5） */
  @IsOptional()
  @IsBoolean({ message: '免责声明确认需为布尔值' })
  disclaimerAccepted?: boolean;
}
