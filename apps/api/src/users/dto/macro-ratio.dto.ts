import { IsNumber, Max, Min } from 'class-validator';

import type { MacroRatio } from '@qsh/core';

/** 宏量营养素比例 DTO（三者和须 = 100，由引擎硬校验）。 */
export class MacroRatioDto implements MacroRatio {
  /** 蛋白质占比（%） */
  @IsNumber({}, { message: '蛋白质占比需为数字' })
  @Min(0, { message: '蛋白质占比不能小于 0' })
  @Max(100, { message: '蛋白质占比不能大于 100' })
  protein!: number;

  /** 脂肪占比（%） */
  @IsNumber({}, { message: '脂肪占比需为数字' })
  @Min(0, { message: '脂肪占比不能小于 0' })
  @Max(100, { message: '脂肪占比不能大于 100' })
  fat!: number;

  /** 碳水化合物占比（%） */
  @IsNumber({}, { message: '碳水占比需为数字' })
  @Min(0, { message: '碳水占比不能小于 0' })
  @Max(100, { message: '碳水占比不能大于 100' })
  carb!: number;
}
