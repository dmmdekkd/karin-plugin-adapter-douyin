import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Bot, BotMessage, ConversationAddress } from 'douyin.ts'
import { logger } from 'node-karin'
import type { Contact } from 'node-karin'
import type { DouyinAccount } from '@/types'
import { dir } from '@/dir'
import { parsePeerFromConversationId } from '@/utils/im'

/** 联系人缓存文件（chatId/secUid 持久化，重启后免重新解析） */
const cacheFile = join(dir.DataDir, 'cache', 'contact.json')

/** chatId 缓存：`${uid}:${scene}:${peer}` → chatId，入站消息与列表查询回填，按账号隔离 */
const chatCache = new Map<string, string>()
/** uid → secUid 缓存（用户资料查询入参用；用户属性跨账号一致，全局一份） */
const secUidCache = new Map<string, string>()
/** 防抖落盘定时器 */
let saveTimer: NodeJS.Timeout | undefined

function key (uid: string, scene: string, peer: string): string {
  return `${uid}:${scene}:${peer}`
}

/** 变更后合并落盘（防抖 500ms，覆盖入站消息高频写入） */
function saveSoon (): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 500)
}

/** 全量落盘：两个缓存平铺写入 JSON */
function save (): void {
  mkdirSync(join(dir.DataDir, 'cache'), { recursive: true })
  writeFileSync(cacheFile, JSON.stringify({
    chat: [...chatCache],
    secUid: [...secUidCache],
  }, null, 2))
}

/** 启动时从磁盘加载联系人缓存（缺失/损坏时静默忽略） */
export function loadContactCache (): void {
  if (!existsSync(cacheFile)) return
  try {
    const data = JSON.parse(readFileSync(cacheFile, 'utf8')) as {
      chat?: Array<[string, string]>
      secUid?: Array<[string, string]>
    }
    for (const [k, v] of data.chat ?? []) chatCache.set(k, v)
    for (const [k, v] of data.secUid ?? []) secUidCache.set(k, v)
  } catch (err) {
    logger.warn(`[douyin] 联系人缓存加载失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 记录入站消息的会话 chatId 与发送者 secUid（后续发送/撤回/已读复用，无需重新解析） */
export function rememberChat (bot: Bot, msg: BotMessage): void {
  const scene = msg.conversationType === 2 ? 'group' : 'friend'
  const peer = scene === 'group'
    ? msg.conversationShortId || msg.conversationId
    : parsePeerFromConversationId(msg.conversationId, bot.id) || msg.senderUid
  chatCache.set(key(bot.id, scene, peer), msg.chatId)
  if (msg.senderSecUid) secUidCache.set(msg.senderUid, msg.senderSecUid)
  saveSoon()
}

/** 记录 uid → secUid（群成员/陌生人列表回填） */
export function rememberSecUid (uid: string, secUid?: string): void {
  if (!secUid) return
  secUidCache.set(uid, secUid)
  saveSoon()
}

/** 按 uid 查 secUid（用户资料接口入参用） */
export function cachedSecUid (uid: string): string | undefined {
  return secUidCache.get(uid)
}

/** 全量刷新好友/群列表防漂移（30 分钟定时调用；断线失败静默返回） */
export async function refreshContacts (account: DouyinAccount): Promise<void> {
  const uid = account.platformUid
  const friends = await account.bot.frd.list().catch(() => undefined)
  if (friends) {
    for (const f of friends) chatCache.set(key(uid, 'friend', f.uid), f.chatId)
  }
  const groups = await account.bot.grp.list().catch(() => undefined)
  if (groups) {
    for (const g of groups) {
      chatCache.set(key(uid, 'group', g.conversationShortId || g.conversationId), g.chatId)
    }
    for (const member of groups.flatMap(g => g.members)) rememberSecUid(member.uid, member.secUid)
  }
  saveSoon()
}

/** karin contact → 抖音 chatId：缓存命中直接返回；未命中查好友/群列表匹配并顺带回填 */
export async function resolveChatId (account: DouyinAccount, contact: Contact): Promise<string | undefined> {
  if (!contact?.peer) return undefined
  const scene = contact.scene === 'group' ? 'group' : 'friend'
  const cached = chatCache.get(key(account.platformUid, scene, contact.peer))
  if (cached) return cached
  if (scene === 'group') {
    const group = (await account.bot.grp.list().catch(() => [])).find(g =>
      g.conversationShortId === contact.peer || g.conversationId === contact.peer || g.name === contact.peer
    )
    if (!group) return undefined
    chatCache.set(key(account.platformUid, 'group', contact.peer), group.chatId)
    // 群成员 secUid 回填（群资料查询后续复用）
    for (const member of group.members) rememberSecUid(member.uid, member.secUid)
    saveSoon()
    return group.chatId
  }
  const friend = (await account.bot.frd.list().catch(() => [])).find(f => f.uid === contact.peer)
  if (!friend) return undefined
  chatCache.set(key(account.platformUid, 'friend', contact.peer), friend.chatId)
  saveSoon()
  return friend.chatId
}

/** chatId → 抖音会话地址（复刻 SDK 内部 toAddress；盖楼 `50::threadId` 时 shortId 为空串） */
export function chatAddressOf (chatId: string): ConversationAddress {
  const [type, shortId, ...rest] = chatId.split(':')
  const conversationId = rest.join(':')
  if (!type || !conversationId) throw new Error(`[douyin] 非法 chatId: ${chatId}`)
  return { conversationId, conversationShortId: shortId ?? '', conversationType: Number(type) as 1 | 2 | 50 }
}
