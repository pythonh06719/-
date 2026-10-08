import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { IsLocalDateKey } from '../../common/validators/local-date-key.validator';

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

/**
 * `PATCH /api/habits/:id`（停用 / 恢复自定义习惯，GAP-11）。
 *
 * PATCH 的语义是「把这条资源改成什么」——因此 `isActive` **必填**：
 * - `false` → 停用（只是「这个阶段先不做」，历史打卡原样保留，不是删除）；
 * - `true`  → 恢复（「重新开始」）。
 *
 * ⚠️ 刻意**不设默认值**（不写成「不传就当 false」）：漏传时无法判断用户意图，
 * 危险默认会让一次手误变成静默停用；缺字段应直接 400。
 */
export class UpdateHabitDto {
  /** 目标状态：`false` 停用 / `true` 恢复 */
  @IsBoolean({ message: 'isActive 需为布尔值' })
  isActive!: boolean;
}

/** `POST /api/habits/:id/check`（打卡 / 取消，R7.3）。 */
export class CheckinDto {
  /** 打卡日期 `YYYY-MM-DD`（缺省 = 今天） */
  @IsOptional()
  @IsLocalDateKey({ message: '日期格式应为 YYYY-MM-DD' })
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
