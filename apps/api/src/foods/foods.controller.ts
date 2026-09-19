import {
  Body,
  Controller,
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

import type { BarcodeLookupResponse, FoodItem, LiveSearchResponse } from '@qsh/shared-types';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { ImportExternalDto } from './dto/import-external.dto';
import { LiveSearchDto } from './dto/live-search.dto';
import { SearchFoodsDto } from './dto/search-foods.dto';
import { FoodsService } from './foods.service';
import type { FoodSearchResult } from './foods.service';

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

  /** 搜索 / 分类浏览。 */
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
