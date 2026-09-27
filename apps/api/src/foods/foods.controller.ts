import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FREQUENT_FOOD_DEFAULTS } from '@qsh/core';

import type {
  BarcodeLookupResponse,
  FoodItem,
  LiveSearchResponse,
  TopFoodsResponse,
} from '@qsh/shared-types';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { ImportExternalDto } from './dto/import-external.dto';
import { LiveSearchDto } from './dto/live-search.dto';
import { SearchFoodsDto } from './dto/search-foods.dto';
import { FoodsService } from './foods.service';
import type { FoodSearchRankedResult, FoodSearchResult } from './foods.service';

/**
 * 食物库控制器（`/api/foods/**`，R3.1~R3.4 / R3.6）。
 *
 * 注意：静态子路径（`recent` / `favorites` / `categories` / `live-search`）
 * 声明在动态参数路径之前，避免被参数路由误捕获。
 *
 * 在线兜底端点（Phase C）额外按**登录用户**限流 20 次 / 分钟
 * （`UserThrottlerGuard`，避免 NAT 共享 IP 的用户互相误伤）：
 * 这些端点会访问外部 Open Food Facts，需防止被当作免费代理刷。
 */
@Controller('foods')
@UseGuards(JwtAuthGuard)
export class FoodsController {
  constructor(private readonly foodsService: FoodsService) {}

  /**
   * **相关度优先**搜索（阶段 2）：`GET /api/foods/search`。
   *
   * 与 `GET /api/foods` 的区别：按**相关度**排序（前缀 > 子串 > 仅别名，同档按 id 稳定分页），
   * 并给跨来源同物异名标出**区分词**（不合并、不按热量排序）。
   * 旧端点保持原契约不变（既有调用方与用例不受影响）。
   */
  @Get('search')
  searchRanked(
    @CurrentUser() userId: number,
    @Query() query: SearchFoodsDto,
  ): Promise<FoodSearchRankedResult> {
    return this.foodsService.searchRanked(userId, query);
  }

  /** 搜索 / 分类浏览（原契约，排序保持 `isVerified desc, id asc` 不变）。 */
  @Get()
  search(@CurrentUser() userId: number, @Query() query: SearchFoodsDto): Promise<FoodSearchResult> {
    return this.foodsService.search(userId, query);
  }

  /** 在线搜索（Open Food Facts 只读代理，Phase C-1）：本地无结果时的兜底。 */
  @Get('live-search')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  liveSearch(@CurrentUser() userId: number, @Query() query: LiveSearchDto): Promise<LiveSearchResponse> {
    return this.foodsService.liveSearch(userId, query);
  }

  /** 分类列表。 */
  @Get('categories')
  categories(@CurrentUser() userId: number): Promise<string[]> {
    return this.foodsService.categories(userId);
  }

  /** 最近吃过（去重）。 */
  @Get('recent')
  recent(@CurrentUser() userId: number): Promise<FoodItem[]> {
    return this.foodsService.recent(userId);
  }

  /**
   * **我的常吃榜**（R11.5 / AC-11.5.8）：近 `days` 天按出现天数降序的前 `limit` 项。
   *
   * 与 `recent`（时间倒序去重）**并列存在、互不影响**（D-3）：这里是「频次」口径。
   * 数据不足时返回 `items: []`，UI 整块隐藏（AC-11.5.2）。
   */
  @Get('top')
  top(
    @CurrentUser() userId: number,
    @Query('days', new DefaultValuePipe(String(FREQUENT_FOOD_DEFAULTS.days)), ParseIntPipe) days: number,
    @Query('limit', new DefaultValuePipe(String(FREQUENT_FOOD_DEFAULTS.limit)), ParseIntPipe) limit: number,
  ): Promise<TopFoodsResponse> {
    return this.foodsService.top(userId, days, limit);
  }

  /** 收藏列表。 */
  @Get('favorites')
  favorites(@CurrentUser() userId: number): Promise<FoodItem[]> {
    return this.foodsService.favorites(userId);
  }

  /** 条码查询（Phase C-2）：先本地后在线，命中即幂等入库返回。 */
  @Get('barcode/:code')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  barcode(@CurrentUser() userId: number, @Param('code') code: string): Promise<BarcodeLookupResponse> {
    return this.foodsService.findByBarcode(userId, code);
  }

  /** 导入在线食物（Phase C-1）：仅凭条码重新拉取，绝不采信请求体中的营养值。 */
  @Post('import-external')
  @HttpCode(HttpStatus.OK)
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  importExternal(@CurrentUser() userId: number, @Body() dto: ImportExternalDto): Promise<FoodItem> {
    return this.foodsService.importExternal(userId, dto.externalId);
  }

  /** 加入收藏。 */
  @Post(':id/favorite')
  @HttpCode(HttpStatus.OK)
  addFavorite(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) foodId: number,
  ): Promise<{ favorited: true }> {
    return this.foodsService.addFavorite(userId, foodId);
  }

  /** 取消收藏。 */
  @Delete(':id/favorite')
  removeFavorite(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) foodId: number,
  ): Promise<{ favorited: false }> {
    return this.foodsService.removeFavorite(userId, foodId);
  }
}
