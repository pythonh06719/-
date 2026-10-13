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
 * - body-parser 家族错误 → 413 / 415 / 400（见 `resolveBodyParser`：此前只有 413 被归一，
 *   其余兄弟错误落到 500 `E_INTERNAL` + error 级堆栈，未认证即可触发）；
 * - Nest 内置 `HttpException` → 按状态码归类（401 / 403 / 404 / 400 / 500）；
 * - Prisma 已知错误（P2002 / P2025）→ 409 / 404；
 * - 其他 → 500 `E_INTERNAL`（日志记录堆栈，响应不泄露内部细节）。
 *
 * 另承担**安全事件日志**（F-009 / OWASP A09）：401 / 403 / 429 与**验证码校验失败**落 warn
 * （见 catch 内注释）。
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
     * 安全事件日志（上线前全检 F-009）：记 **401 / 403 / 429** 以及**验证码校验失败**——
     * 鉴权失败、越权拒绝、触发限流、验证码被猜，这四类是「有人在试探」的可观测信号。
     *
     * ⚠️ 验证码失败必须单独纳入（安全官复核发现的 F-009 最大盲区）：`/auth/verify-code`
     * 猜错返回的是 **400 `E_AUTH_CODE_INVALID`**，而 6 位码爆破是该路径唯一的高价值攻击面；
     * 只按状态码筛会把这条路径整个漏掉（只有把限流桶打爆拿到 429 才留痕）。
     * 密码登录猜错是 401，本来就会记。
     *
     * 为什么**不记 404**：本应用「越权访问他人资源」统一归一为 404（不泄露存在性），
     * 正常业务里缺资源同样大量 404，全记会把真信号淹掉。
     * 为什么不记请求体：可能含邮箱 / 体重等个人数据；只记方法 + 路径 + 状态 + 客户端 IP。
     */
    const isSecurityRelevant =
      status === HttpStatus.UNAUTHORIZED ||
      status === HttpStatus.FORBIDDEN ||
      status === HttpStatus.TOO_MANY_REQUESTS ||
      error.code === ERROR_CODES.AUTH_CODE_INVALID ||
      error.code === ERROR_CODES.AUTH_CODE_EXPIRED;

    if (isSecurityRelevant) {
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

    // 请求体解析家族错误（body-parser / raw-body / type-is）：此前只归一身为 413 的
    // `entity.too.large`，兄弟错误一路落到 500 `E_INTERNAL` + error 级堆栈 ——
    // **未认证即可触发**（解析发生在鉴权之前），既错语义又放大日志（安全官复核发现）。
    const bodyParserError = this.resolveBodyParser(exception);
    if (bodyParserError !== null) {
      return bodyParserError;
    }

    // 中间件层原始 HTTP 错误（读体阶段的 zlib 解压失败等）：不带 `type`，靠 `expose` 识别。
    const middlewareError = this.resolveMiddlewareError(exception);
    if (middlewareError !== null) {
      return middlewareError;
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

  /**
   * 归类「没有 `type` 标记、但自带 4xx 状态」的中间件错误 → 400。
   *
   * 实测形状（探针打出来的）：损坏的 gzip 体抛 `{ errno, code: 'Z_DATA_ERROR', expose: true,
   * status: 400, statusCode: 400 }` —— 无 `type`、非 `HttpException`，此前落到 500。
   *
   * 判据用 `expose === true`（http-errors 的「可对外展示」标记）：框架内部错误不带它，
   * 本应用自身的错误全部是 `ApiException`（有自己的分支），故不会误伤。
   */
  private resolveMiddlewareError(exception: unknown): { status: number; error: ApiError } | null {
    if (typeof exception !== 'object' || exception === null) {
      return null;
    }
    const record = exception as { status?: unknown; statusCode?: unknown; expose?: unknown };
    const status = typeof record.status === 'number' ? record.status : record.statusCode;
    if (record.expose !== true || typeof status !== 'number' || status < 400 || status >= 500) {
      return null;
    }
    return {
      status,
      error: this.buildError(ERROR_CODES.VALID_INPUT, '请求格式不正确，请检查后再试'),
    };
  }

  /**
   * 归一 body-parser 家族错误（按 `type` 判，不靠文案）。
   *
   * | type | 状态 | 说明 |
   * | --- | --- | --- |
   * | `entity.too.large` | 413 | 请求体超过 `express.json({ limit })` |
   * | `parameters.too.many` | 400 | 参数个数超过 `parameterLimit`（语义不是「太大」，故不并入 413） |
   * | `encoding.unsupported` | 415 | `Content-Encoding` 不支持（此前 500） |
   *
   * 兜底：无 `type` 但显式 413 的异常仍按超限处理（框架别处可能直接抛 413）。
   *
   * ⚠️ 这里**没有** `entity.parse.failed` 分支，因为它在此层**不可达**（安全官定位到
   * `@nestjs/core/router/routes-resolver.js` 的 `mapExternalException`）：Nest 在异常到达
   * filter 之前就把 `SyntaxError` / `URIError`（body-parser 的 JSON 解析失败、
   * 路径里的非法 `%FF` 百分号编码）转成 `BadRequestException(err.message)` —— **type 被丢弃、
   * 原始文案被保留**。这类 400 统一由 `resolveHttp` 的 400 分支换通用文案（见该处注释）。
   */
  private resolveBodyParser(exception: unknown): { status: number; error: ApiError } | null {
    if (typeof exception !== 'object' || exception === null) {
      return null;
    }
    const record = exception as { type?: unknown; status?: unknown; statusCode?: unknown };
    const type = typeof record.type === 'string' ? record.type : '';
    const status = typeof record.status === 'number' ? record.status : record.statusCode;

    switch (type) {
      case 'entity.too.large':
        return {
          status: HttpStatus.PAYLOAD_TOO_LARGE,
          error: this.buildError(ERROR_CODES.VALID_TOO_LARGE, '上传的内容太大了，请拆分后再试'),
        };
      case 'parameters.too.many':
        return {
          status: HttpStatus.BAD_REQUEST,
          error: this.buildError(ERROR_CODES.VALID_INPUT, '请求携带的参数太多了，请精简后再试'),
        };
      case 'encoding.unsupported':
        return {
          status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
          error: this.buildError(ERROR_CODES.VALID_INPUT, '请求的压缩格式不支持，请用未压缩的请求发送'),
        };
      case 'entity.parse.failed':
        return {
          status: HttpStatus.BAD_REQUEST,
          // 不回显解析器原文（如 "Unexpected token '1', \"12345\" is not valid JSON"）：那是内部细节
          error: this.buildError(ERROR_CODES.VALID_INPUT, '请求格式不正确，请检查后再试'),
        };
      default:
        break;
    }

    if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
      return {
        status: HttpStatus.PAYLOAD_TOO_LARGE,
        error: this.buildError(ERROR_CODES.VALID_TOO_LARGE, '上传的内容太大了，请拆分后再试'),
      };
    }
    return null;
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
    } else if (status === HttpStatus.BAD_REQUEST) {
      /**
       * 400 有两种来源，文案策略不同：
       * - **校验管道**（ValidationPipe / ParseIntPipe）：数组形态的消息逐字段说明，取首条给用户看
       *   （是我们自己的口径，有用）；
       * - **body-parser 的 JSON 解析失败**：Nest 把它包成 `BadRequestException`，message 是解析器
       *   原文（如 `Unexpected token 'o', "{"content": …" is not valid JSON`）——属内部细节，
       *   换成通用文案（安全官复核发现的信息泄露项）。
       * 应用自身的业务 400 一律走 `ApiException`（本分支收不到）。
       */
      const raw = (payload as { message?: unknown }).message;
      code = ERROR_CODES.VALID_INPUT;
      message = Array.isArray(raw) ? this.extractHttpMessage(payload) : '请求格式不正确，请检查后再试';
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
