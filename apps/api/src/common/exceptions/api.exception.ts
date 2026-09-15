import { HttpException } from '@nestjs/common';

/**
 * 业务异常：携带统一响应所需的 `code`（`E_` 前缀）与可选 `fields`。
 *
 * 由 `AllExceptionsFilter` 统一渲染为 `{ data: null, error: { code, message, fields? } }`。
 */
export class ApiException extends HttpException {
  /** 统一错误码（`E_` 前缀） */
  public readonly code: string;

  /** 字段级错误明细（`字段名 -> 中文提示`） */
  public readonly fields?: Record<string, string>;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super({ code, message, fields }, status);
    this.name = 'ApiException';
    this.code = code;
    this.fields = fields;
  }
}
