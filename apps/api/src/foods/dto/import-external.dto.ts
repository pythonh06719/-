import { IsString, Matches } from 'class-validator';

import { BARCODE_PATTERN } from '../external/off.client';

/**
 * `POST /api/foods/import-external` 请求体（Phase C-1）。
 *
 * **安全要点**：客户端**只**提供外部条码，服务端据此**重新**向 Open Food Facts 拉取营养数据 ——
 * 绝不信任客户端传来的任何热量 / 宏量字段（这些字段即便被提交也会被 `whitelist` 剥离）。
 */
export class ImportExternalDto {
  /** 外部条码（8–14 位数字，即 OFF 的 `code`） */
  @IsString({ message: '缺少条码' })
  @Matches(BARCODE_PATTERN, { message: '条码应为 8–14 位数字' })
  externalId!: string;
}
