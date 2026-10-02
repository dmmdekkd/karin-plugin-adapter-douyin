import type { Bot } from 'douyin.ts'
import type { AccountConfig } from './config.js'

/** 单个抖音账号的运行上下文 */
export interface DouyinAccount {
  /** 账号数字 uid */
  platformUid: string
  /** 配置项 */
  config: AccountConfig
  /** douyin.ts 门面（收发/上传/联系人/HTTP） */
  bot: Bot
}

/** 运行中的账号注册表：platformUid → 账号上下文 */
export type AccountMap = Map<string, DouyinAccount>
