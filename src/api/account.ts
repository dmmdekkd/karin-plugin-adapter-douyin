import { Bot, login } from 'douyin.ts'
import type { LoginOpts, Session } from 'douyin.ts'
import { AccountStore } from '@/store'
import type { AccountRecord } from '@/store'
import { config, upsertAccount } from '@/utils/config'
import { dir } from '@/dir'
import { sdkLog } from '@/utils/im'
import { logger } from 'node-karin'
import type { DouyinAccount, AccountMap } from '@/types'

export interface LoginOptions extends LoginOpts { }

export interface AccountManager {
  store: AccountStore
  /** 已登录并初始化的账号：platformUid → 上下文 */
  accounts: AccountMap
  /** 启动时恢复启用账号（按 config.accounts.name 匹配本地会话） */
  restore: () => Promise<void>
  /** 统一登录入口：扫码登录（含落盘 + 构建） */
  login: (options?: LoginOptions) => Promise<DouyinAccount>
  /** 下线：关闭连接并删除本地会话 */
  logout: (platformUid: string) => void
  /** 应用账号启用状态：enable=true 时按昵称从本地会话构建并返回账号（无会话返回 undefined），false 时下线保留会话 */
  applyEnable: (name: string, enable: boolean) => Promise<DouyinAccount | undefined>
}

/** 构建适配器级账号管理器 */
export function createAccountManager (): AccountManager {
  const store = new AccountStore(dir.accountsDir)
  const accounts: AccountMap = new Map()

  const build = (platformUid: string, session: Session, name?: string): DouyinAccount => {
    const bot = new Bot({ cookie: session.cookie, userId: platformUid, log: sdkLog })
    return { platformUid, config: { name }, bot }
  }

  /** 登录会话落盘（扁平结构：cookie 作为唯一凭据） */
  const persist = (session: Session): void => {
    const platformUid = session.userId
    const prev = store.load(platformUid)
    const screenName = String(session.userData?.screen_name ?? '') || prev?.screenName
    store.save(platformUid, {
      platformUid,
      cookie: session.cookie,
      ...(session.userData ? { userData: session.userData } : {}),
      ...(screenName ? { screenName } : {}),
      createdAt: prev?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  /** 账号 name 是否匹配本地会话（restore 停用判定同源逻辑） */
  const matchName = (record: AccountRecord, name: string): boolean =>
    record.screenName === name

  /** 从本地会话按昵称构建账号并登记（无会话返回 undefined） */
  const enableAccount = (name: string): DouyinAccount | undefined => {
    const record = store.list().find(r => r.cookie?.trim() && matchName(r, name))
    if (!record) {
      logger.warn(`[douyin] 启用账号失败，未找到本地会话: ${name}（请先扫码登录）`)
      return undefined
    }
    const acc = build(record.platformUid, { userId: record.platformUid, cookie: record.cookie }, record.screenName)
    accounts.set(acc.platformUid, acc)
    return acc
  }

  /** 下线账号但保留本地会话（重启或重新启用时恢复） */
  const disableAccount = (name: string): void => {
    const acc = [...accounts.values()].find(a => a.config.name === name)
    if (acc) {
      acc.bot.stop()
      accounts.delete(acc.platformUid)
    }
  }

  const restore = async (): Promise<void> => {
    // 落盘 key = platformUid；config 中 enable=false 的账号跳过（按昵称匹配）
    const disabled = new Set(
      config().accounts.filter(a => a.enable === false).map(a => a.name ?? '')
    )
    for (const record of store.list()) {
      if (!record.cookie?.trim()) continue
      if (disabled.size > 0 && [...disabled].some(d => matchName(record, d))) continue
      accounts.set(record.platformUid, build(
        record.platformUid,
        { userId: record.platformUid, cookie: record.cookie },
        record.screenName
      ))
    }
  }

  const loginAccount = async (options: LoginOptions = {}): Promise<DouyinAccount> => {
    // 扫码登录全流程（取码/轮询/设备注册/二次验证）由 douyin.ts login() 完成
    const session = await login({ ...options, log: sdkLog })
    persist(session)
    const platformUid = session.userId
    const name = store.load(platformUid)?.screenName
    const acc = build(platformUid, session, name)
    accounts.set(platformUid, acc)
    // 登录成功后自动生成账号配置（name 取屏幕昵称）
    if (name) upsertAccount(name)
    return acc
  }

  const logout = (platformUid: string): void => {
    accounts.get(platformUid)?.bot.stop()
    accounts.delete(platformUid)
    store.remove(platformUid)
  }

  /**
   * @description 配置变更后应用账号启用状态（配置立即生效）
   */
  const applyEnable = async (name: string, enable: boolean): Promise<DouyinAccount | undefined> => {
    if (!name) return undefined
    if (!enable) {
      disableAccount(name)
      return undefined
    }
    return enableAccount(name)
  }

  return { store, accounts, restore, login: loginAccount, logout, applyEnable }
}
