import { Module } from '@nestjs/common';

import { FoodsModule } from '../foods/foods.module';
import { CombosController } from './combos.controller';
import { MealsController } from './meals.controller';
import { MealsService } from './meals.service';

/**
 * 饮食记录模块（R3.4 / R3.5 / R3.8 / R3.9 / R3.10）。
 * 复用 `FoodsService` 做食物可见性与份量换算校验。导出 `MealsService` 供看板聚合。
 */
@Module({
  imports: [FoodsModule],
  controllers: [MealsController, CombosController],
  providers: [MealsService],
  exports: [MealsService],
})
export class MealsModule {}
