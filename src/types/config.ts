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
  /** 匹配到相应插件时自动已读（消息被任一插件处理即标记会话已读），默认 false */
  autoReadOnMatch?: boolean
}
