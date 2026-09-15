import {
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

import type { FoodItem } from '@qsh/shared-types';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SearchFoodsDto } from './dto/search-foods.dto';
import { FoodsService } from './foods.service';
import type { FoodSearchResult } from './foods.service';

/**
 * 食物库控制器（`/api/foods/**`，R3.1~R3.4）。
 *
 * 注意：静态子路径（`recent` / `favorites` / `categories`）声明在 `:id` 之前，
 * 避免被参数路由误捕获。
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
