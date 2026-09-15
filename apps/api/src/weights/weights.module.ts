import { Module } from '@nestjs/common';

import { WeightsController } from './weights.controller';
import { WeightsService } from './weights.service';

/** 体重模块（R7.1 / R7.2）。导出 `WeightsService` 供看板聚合迷你趋势。 */
@Module({
  controllers: [WeightsController],
  providers: [WeightsService],
  exports: [WeightsService],
})
export class WeightsModule {}
