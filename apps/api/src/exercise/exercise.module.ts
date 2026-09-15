import { Module } from '@nestjs/common';

import { ExerciseController } from './exercise.controller';
import { ExerciseService } from './exercise.service';

/** 运动模块（R6.1 / R6.2）。导出 `ExerciseService` 供周报聚合。 */
@Module({
  controllers: [ExerciseController],
  providers: [ExerciseService],
  exports: [ExerciseService],
})
export class ExerciseModule {}
