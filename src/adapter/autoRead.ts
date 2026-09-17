import { hooks, logger } from 'node-karin'
import type { Contact } from 'node-karin'
import { config } from '@/utils/config'
import { resolveAddress } from './convert'
import type { AdapterDouyin } from './index'

let registered = false

/**
 * 注册「匹配到相应插件自动已读」全局钩子（幂等，仅注册一次）。
 * 消息事件被任一插件匹配（eventCall）时即标记该会话已读，不阻塞插件执行。
 */
export function setupAutoRead (): void {
  if (registered) return
  registered = true
  hooks.eventCall((e, _plugin, next) => {
    if (e.event === 'message' && config().autoReadOnMatch) {
      const bot = e.bot as unknown as AdapterDouyin | undefined
      if (bot?.ctx?.client) void autoReadConversation(bot, e.contact, e.time)
    }
    next()
  }, { priority: 100 })
}

async function autoReadConversation (bot: AdapterDouyin, contact: Contact, time: number): Promise<void> {
  try {
    const address = await resolveAddress(bot.ctx, contact)
    if (!address) return
    const result = await bot.ctx.client.markRead({
      ...address,
      // read_message_index 为消息 createTime 微秒时间戳；e.time 为秒级时间戳，换算为微秒
      readMessageIndex: String(Math.floor(Number(time) || 0) * 1_000_000),
    })
    if (result.statusCode !== 0) {
      logger.warn(`[douyin] 自动已读失败: statusCode=${result.statusCode} ${result.statusMsg}`)
    }
  } catch (err) {
    logger.debug(`[douyin] 自动已读异常: ${err instanceof Error ? err.message : String(err)}`)
  }
}