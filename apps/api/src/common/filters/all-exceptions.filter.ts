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
import type { Request, Response } from 'express';

import { ERROR_CODES } from '../constants/error-codes';
import { ApiException } from '../exceptions/api.exception';

/**
 * 全局异常过滤器（ARCHITECTURE §7 K2 / K3）。
 *
 * 统一渲染为 `{ data: null, error: { code, message, fields? } }`：
 * - 业务异常 `ApiException` → 原样透出 `code` / `message` / `fields`；
 * - 流控 `ThrottlerException` → 429 `E_LIMIT_THROTTLE`；
 * - 请求体超限（body-parser `entity.too.large`）→ 413 `E_VALID_TOO_LARGE`（F-010：此前落 500）；
 * - Nest 内置 `HttpException` → 按状态码归类（401 / 403 / 404 / 400 / 500）；
 * - Prisma 已知错误（P2002 / P2025）→ 409 / 404；
 * - 其他 → 500 `E_INTERNAL`（日志记录堆栈，响应不泄露内部细节）。
 *
 * 另承担**安全事件日志**（F-009 / OWASP A09）：401 / 403 / 429 三类落 warn（见 catch 内注释）。
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

    /**
     * 安全事件日志（上线前全检 F-009）：只记 **401 / 403 / 429** ——
     * 鉴权失败、越权拒绝、触发限流，这三类是「有人在试探」的唯一可观测信号。
     *
     * 为什么**不记 404**：本应用「越权访问他人资源」统一归一为 404（不泄露存在性），
     * 正常业务里缺资源同样大量 404，全记会把真信号淹掉。
     * 为什么不记请求体：可能含邮箱 / 体重等个人数据；只记方法 + 路径 + 状态 + 客户端 IP。
     */
    if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN || status === HttpStatus.TOO_MANY_REQUESTS) {
      const request = http.getRequest<Request>();
      this.logger.warn(
        `[安全事件] ${status} ${error.code} ${request.method} ${request.path} ip=${request.ip ?? 'unknown'}`,
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

    // 请求体超限：body-parser 抛 PayloadTooLargeError（type='entity.too.large'），
    // 它既不是 HttpException 也不是 ApiException → 曾一路落到 500 `E_INTERNAL`（F-010 实测 11MB 复现）。
    if (this.isPayloadTooLarge(exception)) {
      return {
        status: HttpStatus.PAYLOAD_TOO_LARGE,
        error: this.buildError(ERROR_CODES.VALID_TOO_LARGE, '上传的内容太大了，请拆分后再试'),
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

  /** 判定是否为「请求体过大」（body-parser `entity.too.large` 或任意 413）。 */
  private isPayloadTooLarge(exception: unknown): boolean {
    if (typeof exception !== 'object' || exception === null) {
      return false;
    }
    const record = exception as { type?: unknown; status?: unknown; statusCode?: unknown };
    return (
      record.type === 'entity.too.large' ||
      record.status === HttpStatus.PAYLOAD_TOO_LARGE ||
      record.statusCode === HttpStatus.PAYLOAD_TOO_LARGE
    );
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
