import { IsIn, IsOptional, Matches } from 'class-validator';

import type { MealType } from '@qsh/shared-types';

import { LOCAL_DATE_PATTERN_STRICT } from '../../common/utils/date.util';

/** `GET /api/meals` 查询参数（按日聚合）。 */
export class ListMealsDto {
  /** 指定日期 `YYYY-MM-DD` */
  @IsOptional()
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '日期格式应为 YYYY-MM-DD' })
  date?: string;

  /** 起始日期（可选） */
  @IsOptional()
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '日期格式应为 YYYY-MM-DD' })
  from?: string;

  /** 结束日期（可选） */
  @IsOptional()
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '日期格式应为 YYYY-MM-DD' })
  to?: string;

  /** 仅看某一餐（可选） */
  @IsOptional()
  @IsIn(['breakfast', 'lunch', 'dinner', 'snack'], { message: '请选择餐次' })
  mealType?: MealType;
}
