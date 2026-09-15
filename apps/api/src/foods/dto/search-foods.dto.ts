import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * `GET /api/foods` 查询参数（R3.1 / R3.4）。
 *
 * 兼容两种分页写法：`limit`/`offset`（契约）与 `page`/`pageSize`（`shared-types`）。
 * `q` 与 `keyword` 等价（均按名称 / 拼音 / 别名模糊匹配）。
 */
export class SearchFoodsDto {
  /** 关键词（名称子串） */
  @IsOptional()
  @IsString()
  q?: string;

  /** 关键词（别名，等价于 `q`） */
  @IsOptional()
  @IsString()
  keyword?: string;

  /** 分类 */
  @IsOptional()
  @IsString()
  category?: string;

  /** 每页条数（契约写法） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  /** 偏移量（契约写法） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  /** 页码，从 1 开始（shared-types 写法） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** 每页条数（shared-types 写法） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}
