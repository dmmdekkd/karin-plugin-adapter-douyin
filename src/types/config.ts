/** 接收通道 */
export type ReceiverMode = 'android_websocket' | 'im_websocket' | 'im_http_poll'

/** 账号配置 */
export interface AccountConfig {
  /** 账号备注名 */
  name?: string
  /** 是否启用 */
  enable?: boolean
}

/** 适配器配置 */
export interface Config {
  /** 账号列表 */
  accounts: AccountConfig[]
  /** 接收通道，默认 android_websocket */
  receiverMode?: ReceiverMode
  /** 跳过 msToken 预热 */
  skipMssdk?: boolean
}
