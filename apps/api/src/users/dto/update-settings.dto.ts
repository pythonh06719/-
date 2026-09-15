import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

import type { UnitSystem } from '@qsh/shared-types';

/** `PATCH /api/settings` 请求体（与 `@qsh/shared-types` 的 `UpdateSettingsRequest` 对齐）。 */
export class UpdateSettingsDto {
  /** 单位制（kcal / kJ） */
  @IsOptional()
  @IsIn(['kcal', 'kj'], { message: '单位仅支持 kcal 或 kJ' })
  unit?: UnitSystem;

  /** 深色模式 */
  @IsOptional()
  @IsBoolean({ message: '深色模式需为布尔值' })
  darkMode?: boolean;

  /** 每日饮水目标（ml） */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '饮水目标需为整数毫升' })
  @Min(0, { message: '饮水目标不能为负数' })
  @Max(10_000, { message: '饮水目标不能超过 10000 ml' })
  waterGoalMl?: number;

  /** 断食开关（默认关闭，R8.1） */
  @IsOptional()
  @IsBoolean({ message: '断食开关需为布尔值' })
  fastingEnabled?: boolean;
}
