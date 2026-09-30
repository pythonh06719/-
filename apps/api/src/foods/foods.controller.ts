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
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FREQUENT_FOOD_DEFAULTS } from '@qsh/core';

import type {
  BarcodeLookupResponse,
  FoodItem,
  LastPortionsResponse,
  LiveSearchResponse,
  TopFoodsResponse,
} from '@qsh/shared-types';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { CreateCustomFoodDto } from './dto/create-custom-food.dto';
import { ImportExternalDto } from './dto/import-external.dto';
import { LiveSearchDto } from './dto/live-search.dto';
import { SearchFoodsDto } from './dto/search-foods.dto';
import { UpdateCustomFoodDto } from './dto/update-custom-food.dto';
import { parseFoodIdCsv } from './foods.util';
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
   * **上次份量记忆**（D-1）：`GET /api/foods/last-portions?ids=1,2,3`。
   *
   * 返回若干食物「**最近一次有有效份量**的记录」，供前端在选食物前预填默认份量。
   * `ids` 为逗号分隔的正整数列表（去重、上限 50，脏值静默忽略）。
   *
   * ⚠️ **声明位置**：必须放在 `@Get(':id')` **之前**（本文件顶部注释已约定
   * 「静态子路径先于动态参数路由」）；否则 `/foods/last-portions` 会被 `:id` 抢先匹配，
   * `ParseIntPipe` 再把 `'last-portions'` 打成 400。
   *
   * 归属：`userId` 取自 JWT（`@CurrentUser`），**绝不接受客户端传入**。
   */
  @Get('last-portions')
  lastPortions(@CurrentUser() userId: number, @Query('ids') ids?: string): Promise<LastPortionsResponse> {
    return this.foodsService.lastPortions(userId, parseFoodIdCsv(ids));
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

  /**
   * **我的食物库**（C-4 第二步 / R3.6）：`GET /api/foods/mine` —— 列出**本人自建**的食物。
   *
   * 与「搜索 / 最近 / 收藏」不同：这里**只列自己存进库的**（`source=user_custom` 且
   * `createdByUserId=当前用户`），供用户在「我的食物库」页改 / 删。
   *
   * ⚠️ **声明位置**：必须放在 `@Get(':id')` **之前** —— 本文件顶部注释已约定
   * 「静态子路径先于动态参数路由」；否则 `/foods/mine` 会被 `:id` 抢先匹配，
   * `ParseIntPipe` 再把 `'mine'` 打成 400。
   */
  @Get('mine')
  listMine(@CurrentUser() userId: number): Promise<FoodItem[]> {
    return this.foodsService.listMine(userId);
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

  /**
   * **新建用户自定义食物**（C-4 第一步 / R3.6）：`POST /api/foods`。
   *
   * 把「快加卡」手填的食物存进个人食物库，使其**下次可直接搜到、可复用**
   * （此前只写 `meal_logs` 且 `foodItemId: null`，下一条记录还得重填一遍）。
   *
   * ⚠️ **声明位置**：必须放在 `@Get(':id')` / `@Post(':id/favorite')` 这些
   * 动态参数路由**之前**（本文件顶部注释已约定「静态路由先于动态参数路由」）。
   * 虽然 `POST /foods` 与 `GET /foods/:id` 方法不同、理论上不冲突，但保持
   * 「静态在前」的一致顺序，避免将来新增 `POST /foods/:something` 时踩坑。
   *
   * ⚠️ **归属与来源**：`source` 由服务端硬编码 `'user_custom'`、`createdByUserId`
   * 由服务端从 JWT（`@CurrentUser`）取 —— 请求体里的同名字段即便提交也会被
   * `whitelist` 剥离，无法伪装成内置食物、也无法挂到他人名下。
   *
   * 返回 `201 Created` + `FoodItem`（REST 语义：确实新建了一个资源）。
   */
  @Post()
  createCustom(@CurrentUser() userId: number, @Body() dto: CreateCustomFoodDto): Promise<FoodItem> {
    return this.foodsService.createCustom(userId, dto);
  }

  /**
   * 按 id 取单条食物（B3「改份量」用：编辑面板需要知道这条食物有哪些份量单位）。
   *
   * ⚠️ **必须声明在所有单段静态 GET 路由（`search`/`categories`/`recent`/`top`/`favorites`）之后**：
   * 否则 `/foods/favorites` 会被 `:id` 抢先匹配，`ParseIntPipe` 再把它打成 400。
   *
   * 不存在 / 对当前用户不可见 → 统一 404 `E_NOTFOUND_FOOD`（K7：不暴露存在性）。
   */
  @Get(':id')
  byId(@CurrentUser() userId: number, @Param('id', ParseIntPipe) id: number): Promise<FoodItem> {
    return this.foodsService.byId(userId, id);
  }

  /**
   * **修改本人自建食物**（C-4 第二步 / R3.6）：`PATCH /api/foods/:id`。
   *
   * 部分更新语义（`UpdateCustomFoodDto` 全字段可选，只改传入的）。越权判定用
   * **严格三条件**（`id` + `source='user_custom'` + `createdByUserId=当前用户`），
   * 否则 404 —— ⚠️ **绝不能**复用 `requireVisibleFood`（OR 语义），否则用户可改内置食物。
   *
   * `source` / `createdByUserId` / `isVerified` / `id` **不在 DTO 里**，提交也被 `whitelist` 剥离。
   */
  @Patch(':id')
  updateCustom(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCustomFoodDto,
  ): Promise<FoodItem> {
    return this.foodsService.updateCustom(userId, id, dto);
  }

  /**
   * **删除本人自建食物**（C-4 第二步 / R3.6）：`DELETE /api/foods/:id`。
   *
   * 越权判定同 `PATCH`（严格三条件，否则 404）。删除前在同一事务里把食物名快照写进
   * 引用它的 `meal_logs` / `meal_combo_items`（只补 `customName` 为空的行），避免历史记录
   * 因 `onDelete: SetNull` 退化成无名条目（详见 `FoodsService.removeCustom` 注释）。
   */
  @Delete(':id')
  removeCustom(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ deleted: true }> {
    return this.foodsService.removeCustom(userId, id);
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
