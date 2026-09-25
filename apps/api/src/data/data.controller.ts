import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';

import type { DataOverviewResponse } from '@qsh/shared-types';

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

  /**
   * 记录概览（R11.6 / AC-11.6.6）：各类记录的条数与最早/最晚日期，**只读**。
   *
   * ⚠️ 与 `/data/export` 一样是**本地下载链路里的只读 GET**；
   * 本轮备份链路只有这两个 GET，**没有任何上传类调用**（AC-11.6.9）。
   */
  @Get('overview')
  overview(@CurrentUser() userId: number): Promise<DataOverviewResponse> {
    return this.dataService.overview(userId);
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
