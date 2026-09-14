import { logger } from 'node-karin'
import type { QrCodeInfo, QrLoginOptions } from '@/core/auth'
import type { DouyinAccount } from '@/types'
import { createBot, getAccountManager } from './index'

/** 扫码登录并注册适配器（供指令层调用） */
export async function loginByQr (
  options: QrLoginOptions & { onQr?: (info: QrCodeInfo) => void } = {},
): Promise<DouyinAccount> {
  const manager = getAccountManager()
  const ctx = await manager.loginByQr(options)
  await createBot(ctx)
  logger.info(`[douyin] 扫码登录成功: ${ctx.platformUid}`)
  return ctx
}
