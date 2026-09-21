/**
 * 运行时配置（ARCHITECTURE §1.7 / D4）。
 *
 * ⚠️ 说明（T03 偏离记录）：架构 §2 约定用 `@nestjs/config` 的 `ConfigModule` 读取 `.env`，
 * 但当前 monorepo 未安装 `@nestjs/config`（工程师不自行安装，避免并发破坏 `package-lock.json`）。
 * 因此这里用已在依赖清单内的 `dotenv` 直接加载 `.env`，并对外暴露**只读**的配置访问器，
 * 语义与 `ConfigService.get()` 等价；待依赖补齐后可无损替换为 `ConfigModule`。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';

let envLoaded = false;

/**
 * 幂等加载 `.env`。**仓库根 `.env` 为唯一事实源并优先**，`apps/api/.env` 仅作兜底
 * （它只服务于在 apps/api 目录下直接跑 prisma CLI 的场景，历史上曾因它先加载而
 * 静默遮蔽根 `.env`，导致 AI key 等新配置读不到）。
 *
 * 兼容从 `apps/api` 或仓库根两种 cwd 启动。
 */
export function loadEnv(): void {
  if (envLoaded) {
    return;
  }
  envLoaded = true;

  // 注意：dotenv 默认不覆盖已存在的变量 → **先加载者生效**，故顺序即优先级。
  // 显式判定 cwd 是否为仓库根，避免靠相对路径顺序猜（曾因此让 apps/api/.env 遮蔽根 .env）
  const cwd = process.cwd();
  const isRepoRoot = existsSync(resolve(cwd, 'apps/api/package.json'));
  const rootEnv = isRepoRoot ? resolve(cwd, '.env') : resolve(cwd, '../../.env');
  const apiLocalEnv = isRepoRoot ? resolve(cwd, 'apps/api/.env') : resolve(cwd, '.env');

  const candidates = [
    rootEnv, // 唯一事实源：仓库根 .env
    apiLocalEnv, // 兜底：仅补齐根 .env 未声明的项
  ];

  for (const path of candidates) {
    if (!existsSync(path)) {
      continue;
    }
    const result = loadDotenv({ path });
    // dotenv 默认**不覆盖**已存在的变量，而某些 shell / IDE / CI 会注入**空字符串**的同名变量
    // （例如 `AI_API_KEY=""`）。若不处理，`.env` 会被静默遮蔽 —— 故把空值视为「未设置」。
    for (const [key, value] of Object.entries(result.parsed ?? {})) {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

/** 应用配置（只读）。 */
export interface AppConfig {
  /** 监听端口（默认 3000） */
  port: number;
  /** 运行环境 */
  nodeEnv: string;
  /** JWT 签名密钥（生产必须替换） */
  jwtSecret: string;
  /** JWT 有效期字面量（如 `2h`） */
  jwtExpiresIn: string;
  /** CORS 白名单 */
  corsOrigins: string[];
  /** 验证码有效期（秒，默认 300） */
  verificationCodeTtlSeconds: number;
  /**
   * 自用 / 开发模式开关（`AUTH_LOG_CODE=true`，默认 false）—— 语义扩展后同时控制两条出口：
   * ① 把验证码打印到服务端日志；② 在 `POST /api/auth/send-code` 的响应里回显验证码（`code`）。
   *
   * ⚠️ 安全边界：置为 `true` 等价于「知道邮箱即可登录任意账号」，
   * **生产环境绝不应开启**；仅用于自用部署 / 尚无 SMTP 的演示环境。
   * 默认 false → 生产既不打印、也绝不返回验证码。
   */
  allowLogVerificationCode: boolean;
  /** 密码哈希成本因子（bcryptjs，默认 12） */
  bcryptCost: number;
  /** AI（三期，R9.5）：key 仅存在于服务端环境变量，绝不进入前端产物 / 响应体 / 日志 */
  ai: {
    /**
     * AI 总开关（`AI_ENABLED=false` 关闭，默认开启）。
     * 用于：① 成本熔断 / 故障降级；② 测试中**确定性地**模拟「未配置 key」，
     * 不依赖环境里 key 是否为空（历史上的测试正是靠环境巧合才通过）。
     */
    enabled: boolean;
    /** LLM API Key（空 = 未配置，AI 功能走规则兜底并返回 `available: false`） */
    apiKey: string;
    /** OpenAI 兼容 base url（如 `https://api.openai.com/v1`） */
    baseUrl: string;
    /** 模型名（如 `gpt-4o-mini`） */
    model: string;
  };
}

const DEFAULT_JWT_SECRET = 'dev-only-insecure-secret-change-me-0123456789abcdef';

/** 读取必填环境变量，缺失时返回兜底值。 */
function readEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return value !== undefined && value !== '' ? value : fallback;
}

/** 解析时长字面量（`2h` / `30m` / `30d` / 纯秒数）为秒。 */
export function parseDurationSeconds(literal: string, fallbackSeconds = 7200): number {
  const matched = /^(\d+)\s*([smhd])?$/i.exec(literal.trim());
  if (!matched) {
    return fallbackSeconds;
  }
  const amount = Number(matched[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return fallbackSeconds;
  }
  const unit = (matched[2] ?? 's').toLowerCase();
  const factor = unit === 'd' ? 86_400 : unit === 'h' ? 3_600 : unit === 'm' ? 60 : 1;
  return Math.round(amount * factor);
}

/** 获取应用配置（内部先确保 `.env` 已加载）。 */
export function getAppConfig(): AppConfig {
  loadEnv();

  const jwtExpiresIn = readEnv('JWT_EXPIRES_IN', '2h');
  const origins = readEnv('CORS_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173');

  return {
    port: Number(readEnv('PORT', '3000')) || 3000,
    nodeEnv: readEnv('NODE_ENV', 'development'),
    jwtSecret: readEnv('JWT_SECRET', DEFAULT_JWT_SECRET),
    jwtExpiresIn,
    corsOrigins: origins
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    verificationCodeTtlSeconds: Number(readEnv('AUTH_CODE_TTL_SECONDS', '300')) || 300,
    allowLogVerificationCode: readEnv('AUTH_LOG_CODE', 'false') === 'true',
    bcryptCost: Number(readEnv('BCRYPT_COST', '12')) || 12,
    ai: {
      enabled: readEnv('AI_ENABLED', 'true').trim().toLowerCase() !== 'false',
      apiKey: readEnv('AI_API_KEY', ''),
      baseUrl: readEnv('AI_BASE_URL', 'https://api.openai.com/v1'),
      model: readEnv('AI_MODEL', 'gpt-4o-mini'),
    },
  };
}
