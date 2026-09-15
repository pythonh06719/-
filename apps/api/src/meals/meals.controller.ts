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

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CreateMealDto } from './dto/create-meal.dto';
import { ListMealsDto } from './dto/list-meals.dto';
import { QuickAddDto } from './dto/quick-add.dto';
import { MealsService } from './meals.service';
import type { DayTotals, MealWriteResult } from './meals.service';
import type { ListMealsResponse } from '@qsh/shared-types';

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

  /** 删除一条记录。 */
  @Delete(':id')
  remove(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ deleted: true; dayTotals: DayTotals }> {
    return this.mealsService.remove(userId, id);
  }
}
