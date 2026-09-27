import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

/**
 * `PATCH /api/meals/:id` 请求体（B3：改份量 / 改热量）。
 *
 * - **食物库条目**：改 `grams` 或 `servingUnit` + `servingQty`，热量由服务端按食物库**重算**；
 * - **快速加卡 / 自定义条目**（`foodItemId` 为空）：没有参照物，改的是 `kcal` 本身。
 *
 * 两类都允许只传其中一种；`kcal` 对食物库条目不生效（服务端重算时忽略它）。
 */
export class UpdateMealDto {
  /** 选定克数（g） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '克数需为数字' })
  @Min(0, { message: '克数不能为负数' })
  grams?: number;

  /** 份量单位（个 / 碗 / 杯 / 片 / 袋） */
  @IsOptional()
  @IsString({ message: '份量单位需为文本' })
  servingUnit?: string;

  /** 份量数量 */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '份量数量需为数字' })
  @Min(0, { message: '份量数量不能为负数' })
  servingQty?: number;

  /** 热量 kcal（仅快速加卡 / 自定义条目生效） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '热量需为数字' })
  @Min(0, { message: '热量不能为负数' })
  kcal?: number;

  /** 备注 */
  @IsOptional()
  @IsString({ message: '备注需为文本' })
  note?: string;
}
