import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';

import type { MealCombo, MealComboItem } from '@qsh/shared-types';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ApplyComboDto, CreateComboDto } from './dto/combo.dto';
import { MealsService } from './meals.service';
import type { ComboApplyResult } from './meals.service';

/**
 * 套餐模板控制器（R3.9）。
 *
 * 同时挂载 `/api/meal-combos`（固定契约）与 `/api/combos`（`shared-types` 约定）两套路径，
 * 便于前端任选其一。
 */
@Controller(['meal-combos', 'combos'])
@UseGuards(JwtAuthGuard)
export class CombosController {
  constructor(private readonly mealsService: MealsService) {}

  /** 套餐模板列表。 */
  @Get()
  list(@CurrentUser() userId: number): Promise<Array<MealCombo & { items: MealComboItem[] }>> {
    return this.mealsService.listCombos(userId);
  }

  /** 新建套餐模板。 */
  @Post()
  @HttpCode(HttpStatus.OK)
  create(
    @CurrentUser() userId: number,
    @Body() dto: CreateComboDto,
  ): Promise<MealCombo & { items: MealComboItem[] }> {
    return this.mealsService.createCombo(userId, dto);
  }

  /** 一键用套餐记一餐。 */
  @Post(':id/apply')
  @HttpCode(HttpStatus.OK)
  apply(
    @CurrentUser() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApplyComboDto,
  ): Promise<ComboApplyResult> {
    return this.mealsService.applyCombo(userId, id, dto);
  }
}
