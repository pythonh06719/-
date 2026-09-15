import { Module } from '@nestjs/common';

import { WaterController } from './water.controller';
import { WaterService } from './water.service';

/** 饮水模块（R6.3）。导出 `WaterService` 供看板聚合。 */
@Module({
  controllers: [WaterController],
  providers: [WaterService],
  exports: [WaterService],
})
export class WaterModule {}
