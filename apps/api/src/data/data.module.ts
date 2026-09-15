import { Module } from '@nestjs/common';

import { DataController } from './data.controller';
import { DataService } from './data.service';

/** 数据主权模块（R10.1~R10.4，二期）。 */
@Module({
  controllers: [DataController],
  providers: [DataService],
  exports: [DataService],
})
export class DataModule {}
