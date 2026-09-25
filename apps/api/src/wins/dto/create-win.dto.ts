import { IsString } from 'class-validator';

/**
 * `POST /api/wins` 请求体（R11.4）。
 *
 * ⚠️ **刻意不接受 `loggedDate`**（K21）：`loggedDate` 一律由服务端按本地今天生成，
 * 不支持补录 —— 把补录做成 Todolist 会引入完成压力（QR-5）。
 * 传了 `loggedDate` 也会被全局管道的 `whitelist` 静默剥离。
 *
 * ⚠️ 也**不接受 `userId`**：一律从 JWT 取（NFR-2 / K7）。
 */
export class CreateWinDto {
  /** 正文原文；清洗 / 长度校验统一交给 `@qsh/core` 的 `checkWinText`（唯一校验点，Q-8） */
  @IsString({ message: '正文需为文本' })
  text!: string;
}
