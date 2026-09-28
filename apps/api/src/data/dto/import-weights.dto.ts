import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsString,
  ValidateIf,
} from 'class-validator';

/**
 * `POST /api/data/import/weights` 的入参契约（GAP-6）。
 *
 * ### 为什么必须补这个 DTO
 *
 * 前端此前是**逐行 POST `/weights`**（N 行 = N 个请求），后端这条批量接口写好了也没人用。
 * 改成批量后，**一次请求能带任意多行** —— 而这条接口原先的入参是**裸类型**
 * （`{ rows?: WeightImportRow[]; csvText?: string }`），没有 class-validator、
 * **没有数组长度上限**。一行 `rows: [...10 万条]` 就能把单个 SQLite 事务打爆
 * （`importWeights` 是一条 `$transaction` 包住 N 条 upsert）。
 *
 * ### ⚠️ 这里**只**守两件事，逐字段校验**故意不做**
 *
 * ① `rows` / `csvText` 二选一（两者都不给由 service 抛 400，保持既有契约不动）；
 * ② `rows` 是数组且有**长度上限**（{@link MAX_IMPORT_ROWS}）。
 *
 * **逐行字段校验留给了 `DataService.isValidRow`，不在这里做。** 原因是一次实测教训：
 * DTO 若对 `rows` 元素加 `@ValidateNested` + 日期/体重规则，一行坏数据会让**整批 400**，
 * 于是「合法行照写、坏行只跳过并汇总（计入 `skipped`）」的既有语义被破坏 ——
 * 而那正是这条导入接口最核心的产品行为（PRD §9.3：非法行跳过并汇总，不影响合法行）。
 *
 * 换句话说：**DoS 靠长度上限挡，坏数据靠 service 逐行过滤**。两者的职责不能混。
 * 至于「`rows` 元素不是对象」这种明显畸形，`isValidRow` 的 `typeof row?.date === 'string'`
 * 已经会把它判为非法并计入 `skipped`，不需要 DTO 插手。
 */

/**
 * 单次批量导入允许的最大行数。
 *
 * 取值理由：本项目是单人自用的本地工具，CSV 导入的是**历史体重**（一天最多几条），
 * 2000 行 ≈ 5 年多的逐日记录 —— 正常使用远远够不到，
 * 而一旦超过，说明要么是文件选错了（比如误传了一份饮食 CSV），
 * 要么该走 JSON 备份恢复（`/data/restore`，那才是为「整库搬运」设计的路径）。
 * 上限设在 2000 既能挡住打爆事务的请求，也不会误伤任何正常导入。
 */
export const MAX_IMPORT_ROWS = 2000;

/**
 * 体重导入行（§9.3，与 `DataService.WeightImportRow` 字段逐字一致）。
 *
 * ⚠️ 字段名是 `date` / `weightKg` / `note` —— **不是** `/weights` 单条写入接口的
 * `loggedAt`。前端从 CSV 解析出的结构本来就是 `{ date, weightKg, note? }`
 * （`@qsh/core` 的 `parseWeightCsv` 产出），这里保持一致，避免在中间层改名。
 *
 * ⚠️ **本 DTO 刻意不带任何字段级校验器**（只有类型声明）。理由见文件头：
 * 逐行合法性由 `DataService.isValidRow` 判定并计入 `skipped`；
 * 若在此加 `@Matches` / `@Min` / `@Max`，一行坏数据会让整批 400，
 * 与「非法行跳过并汇总」的契约直接冲突。类型声明仅用于服务层签名可读性。
 */
export class WeightImportRowDto {
  /** 记录日期，`YYYY-MM-DD`（合法性由 service 判，见类注释） */
  date!: string;
  /** 体重（kg），`0 < w < 500`（合法性由 service 判，见类注释） */
  weightKg!: number;
  /** 备注（可选） */
  note?: string;
}

/**
 * 导入历史体重的请求体（`{ rows }` 或 `{ csvText }`，二选一）。
 *
 * `@ValidateIf` 的用法：两个分支各自**只在自己被提供时**才校验 ——
 * 传 `csvText` 时完全不碰 `rows`（哪怕 `rows` 是 `null` / 缺省），反之亦然。
 * 这样「只给 csvText」的既有调用方不会因为缺 `rows` 而被 400（回归保护）。
 */
export class ImportWeightsDto {
  /**
   * 客户端已解析好的行（前端改走批量接口后走这条分支）。
   *
   * ⚠️ `@Type(() => WeightImportRowDto)` 保留：让 `transform: true` 下数组元素
   * 被实例化为 DTO 类（未来若有人加字段级规则，转化链路已经就位）；
   * 但不加 `@ValidateNested`，所以当下不会有「元素校验失败 → 整批 400」的副作用。
   */
  @ValidateIf((payload: ImportWeightsDto) => payload.rows !== undefined)
  @IsArray({ message: 'rows 需要是数组' })
  @ArrayMaxSize(MAX_IMPORT_ROWS, {
    message: `一次最多导入 ${MAX_IMPORT_ROWS} 行，再多请分几次来`,
  })
  @Type(() => WeightImportRowDto)
  rows?: WeightImportRowDto[];

  /** 原始 CSV 文本（既有契约，保留）。 */
  @ValidateIf((payload: ImportWeightsDto) => payload.csvText !== undefined)
  @IsString({ message: 'csvText 需要是字符串' })
  csvText?: string;
}
