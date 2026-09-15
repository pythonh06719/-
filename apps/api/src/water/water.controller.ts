import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CreateWaterDto, UpdateWaterGoalDto } from './dto/water.dto';
import { WaterService } from './water.service';

/**
 * 饮水控制器（`/api/water/**`，R6.3）。
 * `userId` 一律取自 JWT（K7）。
 */
@Controller('water')
@UseGuards(JwtAuthGuard)
export class WaterController {
  constructor(private readonly waterService: WaterService) {}

  /** 查询某日饮水（`?date=YYYY-MM-DD`）。 */
  @Get()
  list(@CurrentUser() userId: number, @Query('date') date?: string) {
    return this.waterService.listByDate(userId, date);
  }

  /** 记一笔（缺省 +250ml）。 */
  @Post()
  @HttpCode(HttpStatus.OK)
  create(@CurrentUser() userId: number, @Body() dto: CreateWaterDto) {
    return this.waterService.create(userId, dto);
  }

  /** 撤销上一条。 */
  @Delete('last')
  undoLast(@CurrentUser() userId: number, @Query('date') date?: string) {
    return this.waterService.undoLast(userId, date);
  }

  /** 删除指定一条。 */
  @Delete(':id')
  remove(@CurrentUser() userId: number, @Param('id', ParseIntPipe) id: number) {
    return this.waterService.remove(userId, id);
  }

  /** 自定义每日目标。 */
  @Patch('goal')
  updateGoal(@CurrentUser() userId: number, @Body() dto: UpdateWaterGoalDto) {
    return this.waterService.updateGoal(userId, dto);
  }
}
