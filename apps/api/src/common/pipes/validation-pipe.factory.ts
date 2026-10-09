import { ValidationPipe } from '@nestjs/common';

import type { ValidationError } from 'class-validator';

import { ERROR_CODES } from '../constants/error-codes';
import { ApiException } from '../exceptions/api.exception';

/**
 * 字段级入参错误的统一构造（K3）。
 *
 * ⚠️ 抽出来是为了让**独立管道**（如 `LocalDateKeyQueryPipe`）与全局校验管道
 * 抛出**同一形态**的异常：同状态码、同 `E_VALID_INPUT`、同 `fields` 结构。
 * 否则读取侧「自己 new 一个」容易在文案/结构上与写入侧漂移，前端要做两套解析。
 */
export function invalidInputError(fields: Record<string, string>): ApiException {
  return new ApiException(400, ERROR_CODES.VALID_INPUT, '请检查填写的内容', fields);
}

/**
 * 全局校验管道工厂（ARCHITECTURE §2 / K3）。
 *
 * - `whitelist: true`：剥离未在 DTO 声明的字段（**天然忽略 body/query 里的 `userId`**，K7）；
 * - `transform: true`：按 DTO 类型转换（query 字符串 → number 等）；
 * - `exceptionFactory`：把 `class-validator` 错误归一为 `E_VALID_INPUT` + `fields`（中文提示）。
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: false,
    transformOptions: { enableImplicitConversion: true },
    exceptionFactory: (errors: ValidationError[]): ApiException => {
      const fields: Record<string, string> = {};
      for (const error of errors) {
        const messages = error.constraints ? Object.values(error.constraints) : [];
        fields[error.property] = messages[0] ?? '填写有误，请检查后重试';
      }
      return invalidInputError(fields);
    },
  });
}
