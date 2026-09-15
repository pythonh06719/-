import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, Max, Min, ValidateNested } from 'class-validator';

import { MacroRatioDto } from './macro-ratio.dto';

/**
 * `PATCH /api/goals` 请求体（与 `@qsh/shared-types` 的 `UpdateGoalRequest` 对齐）。
 * 任一变更都会追加 `weight_goal_history` 并重算落库。
 */
export class UpdateGoalDto {
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

  /** 宏量比例 */
  @IsOptional()
  @ValidateNested()
  @Type(() => MacroRatioDto)
  macroRatio?: MacroRatioDto;
}
