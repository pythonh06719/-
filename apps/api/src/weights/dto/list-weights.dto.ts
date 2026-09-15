import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** `GET /api/weights` 查询参数。 */
export class ListWeightsDto {
  /** 回溯天数（默认 90） */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '天数需为整数' })
  @Min(1, { message: '天数至少为 1' })
  @Max(3650, { message: '天数最多为 3650' })
  days?: number;
}
