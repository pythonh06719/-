import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DataService, type ImportResult, type WeightImportRow } from './data.service';

/**
 * 数据主权控制器（`/api/data/**`，R10.1~R10.4）。
 * - 导出：服务端组装 JSON（CSV 由前端按 §9.2 列定义生成，也可复用本 JSON）；
 * - 导入：历史体重，同日覆盖，非法行汇总；
 * - 删除：**账号硬删除**（级联清除全部数据）。
 */
@Controller('data')
@UseGuards(JwtAuthGuard)
export class DataController {
  constructor(private readonly dataService: DataService) {}

  /** 一键导出全部数据（JSON）。 */
  @Get('export')
  exportAll(@CurrentUser() userId: number) {
    return this.dataService.exportAll(userId);
  }

  /** 导入历史体重（`{ csvText }` 或 `{ rows }`）。 */
  @Post('import/weights')
  @HttpCode(HttpStatus.OK)
  importWeights(@CurrentUser() userId: number, @Body() payload: { rows?: WeightImportRow[]; csvText?: string }): Promise<ImportResult> {
    return this.dataService.importWeights(userId, payload);
  }

  /** **删除我的全部数据**（硬删除，二次确认由前端负责）。 */
  @Delete()
  @HttpCode(HttpStatus.OK)
  deleteAll(@CurrentUser() userId: number) {
    return this.dataService.deleteAccount(userId);
  }
}
