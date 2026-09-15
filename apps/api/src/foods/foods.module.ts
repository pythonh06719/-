import { Module } from '@nestjs/common';

import { FoodsController } from './foods.controller';
import { FoodsService } from './foods.service';

/** 食物库模块（R3.1~R3.4）。导出 `FoodsService` 供饮食记录复用可见性校验。 */
@Module({
  controllers: [FoodsController],
  providers: [FoodsService],
  exports: [FoodsService],
})
export class FoodsModule {}
