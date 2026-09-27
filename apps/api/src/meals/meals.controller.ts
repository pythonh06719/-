import {
  Body,
  Controller,
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

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CreateMealDto } from './dto/create-meal.dto';
import { ListMealsDto } from './dto/list-meals.dto';
import { QuickAddDto } from './dto/quick-add.dto';
import { ReorderMealsDto } from './dto/reorder-meals.dto';
import { UpdateMealDto } from './dto/update-meal.dto';
import { MealsService } from './meals.service';
import type { DayTotals, MealWriteResult } from './meals.service';
import type { ListMealsResponse, ReorderMealsResponse } from '@qsh/shared-types';

/**
 * 饮食记录控制器（`/api/meals/**`，R3.4 / R3.5 / R3.8 / R3.10）。
 * 全部接口受 `JwtAuthGuard` 保护，`userId` 一律取自 JWT（K7）。
 */
@Controller('meals')
@UseGuards(JwtAuthGuard)
export class MealsController {
  constructor(private readonly mealsService: MealsService) {}

  /**
   * 按日 + 按餐查询（`?date=YYYY-MM-DD`）。
   * 返回类型显式标注为契约 `ListMealsResponse`（QA BUG-01）：
   * 编译期即可拦住响应形状与 `@qsh/shared-types` 的漂移。
   */
  @Get()
  list(@CurrentUser() userId: number, @Query() query: ListMealsDto): Promise<ListMealsResponse> {
    return this.mealsService.listByDate(userId, query);
  }

  /** 新增记录（食物库来源 / 自定义来源）。 */
  @Post()
  @HttpCode(HttpStatus.OK)
  create(@CurrentUser() userId: number, @Body() dto: CreateMealDto): Promise<MealWriteResult> {
    return this.mealsService.create(userId, dto);
  }

  /** 快速加卡（R3.5 / TC-19）。 */
  @Post('quick-add')
  @HttpCode(HttpStatus.OK)
  quickAdd(@CurrentUser() userId: number, @Body() dto: QuickAddDto): Promise<MealWriteResult> {
    return this.mealsService.quickAdd(userId, dto);
  }

  /**
   * 餐内排序 / 跨餐移动（R3.8 / AC-3.8.3）。
   *
   * `orderedIds` 是**目标餐次的完整期望顺序** —— 上移 / 下移 / 跨餐 / 拖拽
   * 四种操作共用这一条接口（D-1）。服务端顺序为唯一权威（K13）。
   */
  @Patch('reorder')
  @HttpCode(HttpStatus.OK)
  reorder(@CurrentUser() userId: number, @Body() dto: ReorderMealsDto): Promise<ReorderMealsResponse> {
    return this.mealsService.reorder(userId, dto);
  }

  /**
   * 改份量 / 改热量（B3）。
   *
   * - 食物库条目：改 `grams` 或 `servingUnit` + `servingQty`，热量**按食物库重算**；
   * - 快速加卡条目（`foodItemId` 为空）：没有参照物，改的是 `kcal` 本身。
   *
   * ⚠️ 响应**只回新条目与当日合计**，不含任何「超标 / 超出预算」判断（PRD §7）。
   */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  update(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMealDto,
  ): Promise<MealWriteResult> {
    return this.mealsService.update(userId, id, dto);
  }

  /** 删除一条记录。 */
  @Delete(':id')
  remove(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ deleted: true; dayTotals: DayTotals }> {
    return this.mealsService.remove(userId, id);
  }
}
