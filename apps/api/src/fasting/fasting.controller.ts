import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UpdateFastingSettingsDto } from './dto/fasting.dto';
import { FastingService } from './fasting.service';

/**
 * 断食控制器（`/api/fasting/**`，R8.1~R8.4）。
 * **不做任何主动推送怂恿断食**（R8.3）；首次开启由服务端强制内容警告（TC-30）。
 */
@Controller('fasting')
@UseGuards(JwtAuthGuard)
export class FastingController {
  constructor(private readonly fastingService: FastingService) {}

  /** 读取设置。 */
  @Get('settings')
  settings(@CurrentUser() userId: number) {
    return this.fastingService.getSettings(userId);
  }

  /** 更新设置（开启时必须携带 `disclaimerAckAt`）。 */
  @Patch('settings')
  updateSettings(@CurrentUser() userId: number, @Body() dto: UpdateFastingSettingsDto) {
    return this.fastingService.updateSettings(userId, dto);
  }

  /** 当前进行中的会话。 */
  @Get('current')
  current(@CurrentUser() userId: number) {
    return this.fastingService.current(userId);
  }

  /** 开始断食（与其他 POST 端点一致返回 200，QA BUG-P2-2）。 */
  @Post('start')
  @HttpCode(HttpStatus.OK)
  start(@CurrentUser() userId: number) {
    return this.fastingService.start(userId);
  }

  /** 结束断食。 */
  @Post('stop')
  @HttpCode(HttpStatus.OK)
  stop(@CurrentUser() userId: number) {
    return this.fastingService.stop(userId);
  }
}
