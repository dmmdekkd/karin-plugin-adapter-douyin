import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AccountRecord {
  /** 账号数字 uid */
  platformUid: string
  /** 登录 Cookie 串 */
  cookie: string
  /** 登录返回的用户资料 */
  userData?: Record<string, unknown>
  /** 屏幕昵称 */
  screenName?: string
  avatarUrl?: string
  createdAt: string
  updatedAt: string
}

/** 账号会话持久化：每个账号一个目录 `<accountsDir>/<platformUid>/session.json` */
export class AccountStore {
  private readonly accountsDir: string

  constructor (accountsDir: string) {
    this.accountsDir = accountsDir
    mkdirSync(accountsDir, { recursive: true })
  }

  /** 读取单个账号；不存在返回 undefined */
  load (platformUid: string): AccountRecord | undefined {
    const file = join(this.accountsDir, platformUid, 'session.json')
    if (!existsSync(file)) return undefined
    return JSON.parse(readFileSync(file, 'utf8')) as AccountRecord
  }

  /** 写入/覆盖账号 */
  save (platformUid: string, data: AccountRecord): void {
    const dir = join(this.accountsDir, platformUid)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.json'), JSON.stringify(data, null, 2))
  }

  /** 列出所有已落盘账号 */
  list (): AccountRecord[] {
    if (!existsSync(this.accountsDir)) return []
    return readdirSync(this.accountsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => this.load(d.name))
      .filter((a): a is AccountRecord => a !== undefined)
  }

  /** 删除账号目录 */
  remove (platformUid: string): void {
    rmSync(join(this.accountsDir, platformUid), { recursive: true, force: true })
  }
}
