import type { AccountConfig } from './config.js'
import type { DouyinHttp } from '@/core/http'
import type { ImClient, ImClientEventMap } from '@/core/im'
import type { AccountStore } from '@/core/store'
import type { ConversationAddress } from '@/core/im'

/** 单个抖音账号的运行上下文 */
export interface DouyinAccount {
  /** 账号数字 uid */
  platformUid: string
  /** 配置项 */
  config: AccountConfig
  /** HTTP 客户端（Cookie/签名） */
  http: DouyinHttp
  /** IM 业务门面（收发/上传/联系人） */
  client: ImClient
}

/** 运行中的账号注册表：platformUid → 账号上下文 */
export type AccountMap = Map<string, DouyinAccount>

/** karin contact → 抖音会话寻址 */
export interface ResolvedAddress extends ConversationAddress {
  /** 好友场景：对方 uid */
  peerUid?: string
  /** 群场景：群名 */
  groupName?: string
}

export type {
  ImClientEventMap,
}
