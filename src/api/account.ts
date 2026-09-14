import { DouyinHttp } from '@/core/http'
import { AccountStore } from '@/core/store'
import type { AccountRecord } from '@/core/store'
import {
  runPassportWarmup, getQrcode, loginByQrcode, pollQrConfirm,
  desktopTtwidCheck, setupDesktopDevice, fetchDesktopSelfProfile,
  type DesktopDeviceIdentity, type QrCodeInfo, type QrLoginOptions, type QrSession,
} from '@/core/auth'
import { DESKTOP_LOGIN_USER_AGENT } from '@/core/sign/constants'
import { ImClient } from '@/core/im'
import { config } from '@/utils/config'
import { dir } from '@/dir'
import { join } from 'node:path'
import type { DouyinAccount, AccountMap } from '@/types'

export interface AccountManager {
  store: AccountStore
  /** 已登录并初始化的账号：platformUid → 上下文 */
  accounts: AccountMap
  /** 启动时恢复启用账号（按 config.accounts.name 匹配本地会话） */
  restore: () => Promise<void>
  /** 触发一次扫码登录（含 bootstrap + 落盘 + 构建） */
  loginByQr: (options?: QrLoginOptions & { onQr?: (info: QrCodeInfo) => void }) => Promise<DouyinAccount>
  /** 下线：关闭连接并删除本地会话 */
  logout: (platformUid: string) => void
}

/** 构建适配器级账号管理器 */
export function createAccountManager (): AccountManager {
  const store = new AccountStore({ accountsDir: dir.accountsDir })
  const accounts: AccountMap = new Map()

  const build = (
    platformUid: string,
    session: { cookies: string; msToken?: string; deviceId?: string },
    name?: string,
  ): DouyinAccount => {
    const http = new DouyinHttp({ initialCookies: session.cookies })
    if (session.msToken) http.setMsToken(session.msToken)
    const client = new ImClient({
      http,
      userId: platformUid,
      cookies: session.cookies,
      deviceId: session.deviceId ?? store.ensureDeviceId(platformUid),
    })
    return { platformUid, config: { name }, http, client }
  }

  const recordName = (record: AccountRecord | undefined): string | undefined => {
    const name = record?.screenName ?? String(record?.userData?.screen_name ?? '')
    return name || undefined
  }

  const persist = async (session: QrSession, device?: DesktopDeviceIdentity): Promise<void> => {
    const prev = store.load(session.platformUid)
    const deviceId = device?.deviceId ?? prev?.session.deviceId ?? store.ensureDeviceId(session.platformUid)
    const screenName = String(session.userData?.screen_name ?? '') || prev?.screenName
    store.save(session.platformUid, {
      platformUid: session.platformUid,
      session: { cookies: session.cookies, deviceId, verifiedAt: new Date().toISOString() },
      ...(session.userData ? { userData: session.userData } : {}),
      ...(screenName ? { screenName } : {}),
      ...(prev?.ticketGuard ? { ticketGuard: prev.ticketGuard } : {}),
      ...(device ? { deviceProfile: device } : {}),
      createdAt: prev?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  const restore = async (): Promise<void> => {
    // 落盘 key = platformUid；config 中 enable=false 的账号跳过
    const disabled = new Set(
      config().accounts.filter(a => a.enable === false).map(a => a.name ?? ''),
    )
    for (const record of store.list()) {
      if (!record.session.cookies?.trim()) continue
      if (disabled.has(record.platformUid) || disabled.has(String(record.userData?.name ?? ''))) continue
      // 修正历史落盘的 hash 形态 platformUid（frontier 握手要求数字 uid）
      const numericUid = (record.userData as { user_id_str?: string } | undefined)?.user_id_str
      const platformUid = numericUid ?? record.platformUid
      const deviceId = store.ensureDeviceId(record.platformUid)
      const acc = build(platformUid, { ...record.session, deviceId }, recordName(record))
      accounts.set(platformUid, acc)
      // 旧会话 Cookie 可能缺 bd_ticket_guard_server_data，重启时补跑护照预热
      await runPassportWarmup(acc.http).catch(() => undefined)
    }
  }

  const loginByQr = async (
    options: QrLoginOptions & { onQr?: (info: QrCodeInfo) => void } = {},
  ): Promise<DouyinAccount> => {
    // 桌面客户端登录（对齐 douyin-im beginLogin）：注册设备 → ttwid 预热 → 扫码。
    // 服务端签发的设备身份是登录不触发短信二次验证的根因
    const http = new DouyinHttp({ userAgent: DESKTOP_LOGIN_USER_AGENT })
    const device = await setupDesktopDevice(join(dir.accountsDir, 'device.json'), http)
      .catch(() => undefined)
    await desktopTtwidCheck(http).catch(() => undefined)

    // 有 onQr 时：先取二维码回传，再进入轮询确认
    let session: QrSession
    if (options.onQr) {
      const info = await getQrcode(http)
      options.onQr(info)
      session = await pollQrConfirm(http, info.token, options)
    } else {
      session = await loginByQrcode(http, options)
    }

    // 对齐 douyin-im finishLogin：passport 的 screen_name 是"用户xxx"默认昵称、
    // avatar_url 是 mosaic 占位，需用桌面 IM 自我资料的真实昵称/头像覆盖
    await fetchDesktopSelfProfile(http)
      .then(profile => {
        session.userData = {
          ...session.userData,
          ...(profile.nickname ? { screen_name: profile.nickname } : {}),
          ...(profile.avatar ? { avatar_url: profile.avatar } : {}),
        }
      })
      .catch(() => undefined)

    await persist(session, device)
    const record = store.load(session.platformUid)
    const acc = build(session.platformUid, { cookies: session.cookies }, recordName(record))
    accounts.set(session.platformUid, acc)
    return acc
  }

  const logout = (platformUid: string): void => {
    accounts.get(platformUid)?.client.stop()
    accounts.delete(platformUid)
    store.remove(platformUid)
  }

  return { store, accounts, restore, loginByQr, logout }
}
