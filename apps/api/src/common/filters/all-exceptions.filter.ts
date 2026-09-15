import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';

import type { ApiError } from '@qsh/shared-types';
import type { Response } from 'express';

import { ERROR_CODES } from '../constants/error-codes';
import { ApiException } from '../exceptions/api.exception';

/**
 * 全局异常过滤器（ARCHITECTURE §7 K2 / K3）。
 *
 * 统一渲染为 `{ data: null, error: { code, message, fields? } }`：
 * - 业务异常 `ApiException` → 原样透出 `code` / `message` / `fields`；
 * - 流控 `ThrottlerException` → 429 `E_LIMIT_THROTTLE`；
 * - Nest 内置 `HttpException` → 按状态码归类（401 / 403 / 404 / 400 / 500）；
 * - Prisma 已知错误（P2002 / P2025）→ 409 / 404；
 * - 其他 → 500 `E_INTERNAL`（日志记录堆栈，响应不泄露内部细节）。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();

    const { status, error } = this.resolve(exception);

    if (status >= 500) {
      this.logger.error(
        `未捕获异常（${status}）：${exception instanceof Error ? exception.message : String(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(status).json({ data: null, error });
  }

  /** 将任意异常归一为 `{ status, error }`。 */
  private resolve(exception: unknown): { status: number; error: ApiError } {
    if (exception instanceof ApiException) {
      return {
        status: exception.getStatus(),
        error: this.buildError(exception.code, exception.message, exception.fields),
      };
    }

    if (exception instanceof ThrottlerException) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        error: this.buildError(ERROR_CODES.LIMIT_THROTTLE, '操作有点频繁，稍等一会儿再试'),
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.resolvePrisma(exception);
    }

    if (exception instanceof HttpException) {
      return this.resolveHttp(exception);
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: this.buildError(ERROR_CODES.INTERNAL, '服务开小差了，请稍后再试'),
    };
  }

  /** Nest 内置 HTTP 异常归一。 */
  private resolveHttp(exception: HttpException): { status: number; error: ApiError } {
    const status = exception.getStatus();
    const payload = exception.getResponse();

    let code: string;
    let message: string;

    if (status === HttpStatus.UNAUTHORIZED) {
      code = ERROR_CODES.AUTH_UNAUTHORIZED;
      message = '请先登录';
    } else if (status === HttpStatus.NOT_FOUND) {
      code = ERROR_CODES.NOTFOUND_RESOURCE;
      message = '没有找到对应的内容';
    } else if (status === HttpStatus.FORBIDDEN) {
      code = ERROR_CODES.AUTH_UNAUTHORIZED;
      message = '没有权限访问该内容';
    } else if (status === HttpStatus.TOO_MANY_REQUESTS) {
      code = ERROR_CODES.LIMIT_THROTTLE;
      message = '操作有点频繁，稍等一会儿再试';
    } else if (status >= 500) {
      code = ERROR_CODES.INTERNAL;
      message = '服务开小差了，请稍后再试';
    } else {
      code = ERROR_CODES.VALID_INPUT;
      message = this.extractHttpMessage(payload);
    }

    return { status, error: this.buildError(code, message) };
  }

  /** 从 Nest 异常响应体中尽量提取可读文案。 */
  private extractHttpMessage(payload: unknown): string {
    if (typeof payload === 'string') {
      return payload;
    }
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>;
      const raw = record.message;
      if (Array.isArray(raw)) {
        const first = raw.find((item): item is string => typeof item === 'string');
        return first ?? '请检查填写的内容';
      }
      if (typeof raw === 'string') {
        return raw;
      }
    }
    return '请检查填写的内容';
  }

  /** Prisma 已知错误码归一。 */
  private resolvePrisma(exception: Prisma.PrismaClientKnownRequestError): {
    status: number;
    error: ApiError;
  } {
    if (exception.code === 'P2002') {
      return {
        status: HttpStatus.CONFLICT,
        error: this.buildError(ERROR_CODES.VALID_DUPLICATE, '已经存在同名内容，换个名字试试'),
      };
    }
    if (exception.code === 'P2025') {
      return {
        status: HttpStatus.NOT_FOUND,
        error: this.buildError(ERROR_CODES.NOTFOUND_RESOURCE, '没有找到对应的内容'),
      };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: this.buildError(ERROR_CODES.INTERNAL, '服务开小差了，请稍后再试'),
    };
  }

  /** 组装 `ApiError`（`fields` 为空时省略该键）。 */
  private buildError(code: string, message: string, fields?: Record<string, string>): ApiError {
    return fields && Object.keys(fields).length > 0 ? { code, message, fields } : { code, message };
  }
}
