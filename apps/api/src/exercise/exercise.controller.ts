import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CreateExerciseDto, EstimateExerciseDto } from './dto/create-exercise.dto';
import { ExerciseService } from './exercise.service';

/**
 * 运动控制器（`/api/exercises/**`，R6.1 / R6.2）。
 * `userId` 一律取自 JWT（K7）。
 */
@Controller('exercises')
@UseGuards(JwtAuthGuard)
export class ExerciseController {
  constructor(private readonly exerciseService: ExerciseService) {}

  /** 内置 MET 表。 */
  @Get('activities')
  activities() {
    return this.exerciseService.listActivities();
  }

  /** 查询某日运动记录（`?date=YYYY-MM-DD`）。 */
  @Get()
  list(@CurrentUser() userId: number, @Query('date') date?: string) {
    return this.exerciseService.listByDate(userId, date);
  }

  /** 试算消耗（不落库）。 */
  @Post('estimate')
  @HttpCode(HttpStatus.OK)
  estimate(@CurrentUser() userId: number, @Body() dto: EstimateExerciseDto) {
    return this.exerciseService.estimate(userId, dto);
  }

  /** 记录一条运动。 */
  @Post()
  @HttpCode(HttpStatus.OK)
  create(@CurrentUser() userId: number, @Body() dto: CreateExerciseDto) {
    return this.exerciseService.create(userId, dto);
  }

  /** 删除一条运动记录。 */
  @Delete(':id')
  remove(@CurrentUser() userId: number, @Param('id', ParseIntPipe) id: number) {
    return this.exerciseService.remove(userId, id);
  }
}
