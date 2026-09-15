import { Module } from '@nestjs/common';

import { HabitsController } from './habits.controller';
import { HabitsService } from './habits.service';

/** 习惯模块（R7.3 / R7.4）。导出 `HabitsService` 供周报聚合。 */
@Module({
  controllers: [HabitsController],
  providers: [HabitsService],
  exports: [HabitsService],
})
export class HabitsModule {}
