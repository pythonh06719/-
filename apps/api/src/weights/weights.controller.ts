import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';

import type { MovingAveragePoint, WeightLog } from '@qsh/shared-types';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CreateWeightDto } from './dto/create-weight.dto';
import { ListWeightsDto } from './dto/list-weights.dto';
import { WeightsService } from './weights.service';
import type { WeightListResult } from './weights.service';

/**
 * 体重控制器（`/api/weights/**`，R7.1 / R7.2）。
 * `userId` 一律取自 JWT（K7）。
 */
@Controller('weights')
@UseGuards(JwtAuthGuard)
export class WeightsController {
  constructor(private readonly weightsService: WeightsService) {}

  /** 近 N 天体重 + 7 日移动平均（`?days=90`）。 */
  @Get()
  list(@CurrentUser() userId: number, @Query() query: ListWeightsDto): Promise<WeightListResult> {
    return this.weightsService.list(userId, query.days ?? 90);
  }

  /** 趋势（`shared-types` 约定形态：`movingAverage7` 字段名）。 */
  @Get('trend')
  async trend(
    @CurrentUser() userId: number,
    @Query() query: ListWeightsDto,
  ): Promise<{
    points: Array<{ date: string; weightKg: number }>;
    movingAverage7: MovingAveragePoint[];
    stats: WeightListResult['stats'];
  }> {
    const result = await this.weightsService.list(userId, query.days ?? 90);
    return {
      points: result.points,
      movingAverage7: result.movingAverage7,
      stats: result.stats,
    };
  }

  /** 记录体重（同日覆盖）。 */
  @Post()
  @HttpCode(HttpStatus.OK)
  create(@CurrentUser() userId: number, @Body() dto: CreateWeightDto): Promise<WeightLog> {
    return this.weightsService.create(userId, dto);
  }
}
