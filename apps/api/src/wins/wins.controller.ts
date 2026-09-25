import { Body, Controller, DefaultValuePipe, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';

import type { DeleteWinResponse, ListWinsResponse, WinLog } from '@qsh/shared-types';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CreateWinDto } from './dto/create-win.dto';
import { WINS_DEFAULT_DAYS, WinsService } from './wins.service';

/**
 * 「体重之外的变化」控制器（`/api/wins`，R11.4）。
 *
 * - `POST /wins`：只记今天（`loggedDate` 服务端生成，K21）；
 * - `GET /wins`：最新 200 条、`createdAt` 升序（D-5 / K23）；
 * - `DELETE /wins/:id`：无二次确认（AC-11.4.4），他人资源 → 404（K7）。
 */
@Controller('wins')
@UseGuards(JwtAuthGuard)
export class WinsController {
  constructor(private readonly winsService: WinsService) {}

  /** 记一条（body 只有 `text`；`loggedDate` 由服务端生成本地今天）。 */
  @Post()
  @HttpCode(HttpStatus.OK)
  create(@CurrentUser() userId: number, @Body() dto: CreateWinDto): Promise<WinLog> {
    return this.winsService.create(userId, dto);
  }

  /** 回看时间线（`?days=90`，1–365）。 */
  @Get()
  list(
    @CurrentUser() userId: number,
    @Query('days', new DefaultValuePipe(WINS_DEFAULT_DAYS), ParseIntPipe) days?: number,
  ): Promise<ListWinsResponse> {
    return this.winsService.list(userId, days ?? WINS_DEFAULT_DAYS);
  }

  /** 删除一条。 */
  @Delete(':id')
  remove(@CurrentUser() userId: number, @Param('id', ParseIntPipe) id: number): Promise<DeleteWinResponse> {
    return this.winsService.remove(userId, id);
  }
}
