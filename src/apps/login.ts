/**
 * #抖音bot登录 交互式登录
 *
 * 仅主人可用。登录方式固定为 qr 扫码：
 * - qr：推送二维码图片 → 手机扫码确认（若触发短信/密码二次验证，直接发送验证码/密码即可）
 *
 * 交互式输入由全局 hook 监听消费「裸消息」（白名单同一会话的主人），
 * 完全不走命令方式。
 *
 * 登录成功后自动落盘会话并注册 bot，并回复成功提示。
 */
import karin, { hooks, segment, logger } from 'node-karin'
import QRCode from 'qrcode'
import { login } from '@/adapter'

/** 互斥锁：避免并发登录 */
let busy = false

/** 发起登录的会话（peer + 发起人） */
let loginFrom: { peer: string; userId: string | number } | undefined

/** 扫码二次验证（手机号 MFA / 密码 MFA）等待的回调 */
let mfaWaiter: ((code: string) => void) | undefined

/**
 * 全局监听：登录等待期间直接消费「裸消息」作为输入（同一会话的主人）。
 *
 * node-karin 的消息分发不走 EventEmitter，必须通过 hooks.message 钩子接收；
 * 该钩子在命令系统之前执行，且必须调用 next() 放行无关消息。
 * 命中扫码二次验证等待输入时主动中断（不调用 next()），
 * 避免裸消息继续进入命令系统被其他插件误处理。
 */
hooks.message((e, next) => {
  if (!busy || !loginFrom) return next()
  const sameUser = String(loginFrom.userId) === String(e.sender?.userId)
  const samePeer = loginFrom.peer === e.contact?.peer
  if (!sameUser || !samePeer) return next()
  const input = e.msg.trim()
  if (!input) return next()
  // 消费扫码二次验证等待器
  const waiter = mfaWaiter
  if (!waiter) return next()
  mfaWaiter = undefined
  waiter(input)
})

export const douyinLogin = karin.command(/^#(?:抖音bot登录)$/i, async (e) => {
  if (busy) {
    await e.reply('已有登录在进行中，请稍候再试')
    return
  }
  busy = true
  mfaWaiter = undefined
  loginFrom = { peer: e.contact.peer, userId: e.sender.userId }

  try {
    let name = ''

    // 二维码推送：控制台适配器打印机终端码，其余推送图片到聊天
    const pushQr = async (info: { url: string; base64?: string }): Promise<void> => {
      if (e.bot.adapter.name === '@karinjs/console') {
        const terminal = await QRCode.toString(info.url, {
          type: 'terminal',
          small: true,
          margin: 0,
          errorCorrectionLevel: 'L',
        })
        logger.info(`\n${terminal}\n请使用抖音 APP 扫码登录`)
        return
      }
      if (!info.base64) throw new Error('未收到二维码图片')
      await e.reply([segment.image(info.base64)])
    }
    // qr：扫码登录（对齐 douyin-im beginLogin 桌面流程）
    const ctx = await login({
      onQr: pushQr,
      onStatus: async (status) => {
        if (!['new', 'scanned', 'verifying', 'verified', 'confirmed', 'expired'].includes(status)) await e.reply(status)
      },
      onMfa: async ({ maskedMobile, kind }) => {
        const prompt = kind === 'password'
          ? '触发密码验证，请发送密码'
          : `验证码已发至 ${maskedMobile ?? '安全手机'}，请发送验证码`
        await e.reply(prompt)
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (mfaWaiter === resolve) mfaWaiter = undefined
            reject(new Error(kind === 'password' ? '等待密码输入超时' : '等待验证码输入超时'))
          }, 5 * 60_000)
          mfaWaiter = (code) => {
            clearTimeout(timer)
            resolve(code)
          }
        })
      },
    })
    name = ctx.config.name || ctx.platformUid

    await e.reply(`抖音登录成功：${name}`)
  } catch (err) {
    logger.error('[douyin] 登录失败:', err)
    await e.reply(`登录失败：${err instanceof Error ? err.message : '未知错误'}`)
  } finally {
    busy = false
    loginFrom = undefined
    mfaWaiter = undefined
  }
},
{
  name: 'douyin:login',
  permission: 'master',
  authFailMsg: '#抖音bot登录 仅限主人使用',
}
)
