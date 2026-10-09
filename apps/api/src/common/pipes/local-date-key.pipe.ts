import { Injectable, PipeTransform } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';

import { isValidLocalDateKey } from '../utils/date.util';
import { invalidInputError } from './validation-pipe.factory';

/**
 * 日期字段的中文提示（与 `IsLocalDateKey` 的 `defaultMessage` 同文案）。
 *
 * 抽成常量是为了让「写入侧 DTO 校验」与「读取侧 query 管道」对同一个坏日期
 * 给出**同一句话**，用户不会在 POST 与 GET 之间看到两种说法。
 */
export const DATE_KEY_MESSAGE = '应为合法的 YYYY-MM-DD 日期';

/**
 * 查询参数日期键管道（读取侧与写入侧口径统一的那一半）。
 *
 * **为什么需要它**：写入侧（DTO）早已统一用 `@IsLocalDateKey()`，但读取侧的
 * `@Query('date') date?: string` 是**裸参数、没有管道** —— `?date=2026-02-31`
 * 不会 400，而是拿这个不存在的日期去查库，静默返回「当日无记录」，
 * 用户会误以为数据丢了。同一份日期在 POST 被拒、在 GET 被放行，口径自相矛盾。
 *
 * **判据的唯一真源**：本管道**不自带正则**，直接复用 `date.util.ts` 的
 * `isValidLocalDateKey` —— 与 `@IsLocalDateKey()` 装饰器、**core** 的
 * `isLocalDateKey` 是同一个判据（严格正则 + 日历回环比对）。
 * ⚠️ 本项目已因「三份各自为政的裸正则」付过一次债（`data.service.ts` 注释有记）：
 * 只验形状不验真实性，正是 `2026-02-31` 能入库的根因。**不要再引入第四份判据。**
 *
 * **缺省语义不变**：`undefined`（不传）原样返回 `undefined`，由 service 走
 * `date ?? todayLocalKey()` 的既有默认；本管道不替 service 选今天。
 *
 * **空串 `?date=` 视同未传**（返回 `undefined`），理由见 `transform` 内注释。
 */
@Injectable()
export class LocalDateKeyQueryPipe implements PipeTransform<string | undefined, string | undefined> {
  /**
   * @param value query 里的原始字符串（可能是 `undefined` / 空串 / 数组）。
   * @param metadata 用于取参数名，错误 `fields` 的键与前端字段名对齐（如 `date`）。
   * @returns 原样返回合法日期键；缺省或空串返回 `undefined`。
   * @throws {ApiException} 400 `E_VALID_INPUT` —— 与全局校验管道同一错误码与响应形态。
   */
  public transform(value: string | undefined, metadata: ArgumentMetadata): string | undefined {
    const field = typeof metadata.data === 'string' ? metadata.data : 'date';

    // 缺省：保持 service 的既有默认语义（`date ?? todayLocalKey()`），管道不猜测。
    if (value === undefined || value === null) {
      return undefined;
    }

    // ⚠️ 边界决定：`?date=`（空串）**视同未传**，不报 400。
    // 理由：① URL 里带空 query 是前端最常见的无心行为（表单未填、模板拼接、
    //   `?date=${value}` 里 value 为空），为无心行为抛错会把「没填」误判成「填错」；
    //   ② 若当真值放行，service 会拿 `''` 去查 `loggedDate: ''` —— 必然空结果，
    //   正是本次要消灭的「静默返回当日无记录」；
    //   ③ 与写入侧一致：DTO 侧空串由 `@IsOptional()` 兜住，同样不因空而报错。
    if (value === '') {
      return undefined;
    }

    // `?date=a&date=b` 时 Express 给出数组；`typeof` 守卫顺带把它挡成 400。
    if (typeof value === 'string' && isValidLocalDateKey(value)) {
      return value;
    }

    throw invalidInputError({ [field]: DATE_KEY_MESSAGE });
  }
}
