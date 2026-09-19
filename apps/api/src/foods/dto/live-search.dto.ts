import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * `GET /api/foods/live-search` 查询参数（Phase C-1，在线食物库兜底）。
 *
 * - `q` 搜索词（仅此一项被转发给 Open Food Facts，绝不携带任何用户数据）；
 * - `limit` 期望条数（默认 10，1–20）。
 */
export class LiveSearchDto {
  /** 搜索词 */
  @IsOptional()
  @IsString()
  @MaxLength(80, { message: '搜索词太长了' })
  q?: string;

  /** 期望条数 */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '条数需为整数' })
  @Min(1)
  @Max(20)
  limit?: number;
}
