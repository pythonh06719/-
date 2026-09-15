import { Module } from '@nestjs/common';

import { FastingController } from './fasting.controller';
import { FastingService } from './fasting.service';

/** 断食模块（R8.1~R8.4，二期，默认关闭）。 */
@Module({
  controllers: [FastingController],
  providers: [FastingService],
  exports: [FastingService],
})
export class FastingModule {}
