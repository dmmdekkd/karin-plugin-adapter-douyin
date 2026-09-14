import * as apiContact from '@/api/contact'
import { fetchUserProfiles, cacheUserProfile, cacheSecUid, cachedSecUid, cachedNickname } from '@/api/profile'
import type { ConversationAddress } from '@/core/im'
import type { AdapterDouyin } from './index'

/**
 * 联系人资料模型（对齐 douyin-im）：
 * - 资料以「会话线程 nickname / cmd=605 participants.secUid → IM user/info 批量」实时获取
 * - uid → secUid 为稳定标识映射，昵称/头像随资料查询回填
 */

/** 群 shortId → 群名（群列表填充） */
const groupNameCache = new Map<string, string>()

/** 正在按需解析的 key（防并发重复拉取） */
const fetching = new Set<string>()

export function cachedNick (uid: string): string {
  return cachedNickname(uid)
}

export function cachedGroupName (shortId: string): string {
  return groupNameCache.get(shortId) ?? ''
}

function cacheNicks (pairs: Iterable<readonly [uid: string, nickname: string]>): void {
  for (const [uid, nickname] of pairs) {
    cacheUserProfile(uid, { nickname })
  }
}

/** 按 uid+secUid 对批量拉 IM 资料并回填缓存（对齐 douyin-im resolveUsers） */
export async function applyProfiles (
  http: AdapterDouyin['ctx']['http'],
  entries: Iterable<{ uid: string; secUid?: string }>,
): Promise<void> {
  const list = [...entries].filter(e => e.uid && e.uid !== '0' && e.secUid)
  if (!list.length) return
  try {
    const profiles = await fetchUserProfiles(
      http,
      list.map(e => e.secUid!),
    )
    for (const entry of list) {
      const profile = profiles.get(entry.secUid!)
      if (profile) cacheUserProfile(entry.uid, profile)
    }
  } catch { /* 拉取失败静默 */ }
}

/** 预热缓存：好友昵称 + 群名（createBot 后异步执行，不阻塞注册） */
export async function warmNickCache (bot: AdapterDouyin): Promise<void> {
  const key = bot.selfId
  if (fetching.has(key)) return
  fetching.add(key)
  try {
    try {
      const friends = await apiContact.getFriendList(bot.ctx.client)
      cacheNicks(friends.map(f => [f.uid, f.nickname] as const))
      for (const f of friends) {
        if (f.secUid) cacheSecUid(f.uid, f.secUid)
      }
    } catch { /* 预热失败静默，消息时按需补 */ }
    try {
      const groups = await apiContact.getGroupList(bot.ctx.client)
      for (const g of groups) {
        if (g.conversationShortId && g.name) groupNameCache.set(g.conversationShortId, g.name)
      }
    } catch { /* 同上 */ }
  } finally {
    fetching.delete(key)
  }
}

/**
 * 按需解析昵称（对齐 douyin-im 联系人补全）：
 * - 群：cmd=605 participants 携带 secUid → IM user/info 批量拉全群昵称/头像
 * - 私聊：会话线程 nickname（好友/陌生人）；指定 secUid 时走 IM 资料接口
 */
export async function resolveNick (
  bot: AdapterDouyin,
  uid: string,
  group?: ConversationAddress,
  secUid?: string,
): Promise<string> {
  if (!uid || uid === '0' || cachedNick(uid)) return cachedNick(uid)
  const key = `${bot.selfId}:${uid}:${group?.conversationShortId ?? 'dm'}`
  if (fetching.has(key)) return cachedNick(uid)
  fetching.add(key)
  try {
    if (group) {
      // participants 一次给全群 uid+secUid，批量资料回填（douyin-im group 模式）
      try {
        const members = await apiContact.getGroupMembers(bot.ctx.client, group)
        for (const m of members) {
          if (m.secUid) cacheSecUid(m.uid, m.secUid)
          if (m.alias) cacheUserProfile(m.uid, { nickname: m.alias })
        }
        await applyProfiles(bot.ctx.http, members)
      } catch { /* 拉取失败静默 */ }
    } else {
      try {
        const strangers = await apiContact.getStrangerList(bot.ctx.client)
        cacheNicks(strangers.map(s => [s.uid, s.nickname ?? ''] as const))
        for (const s of strangers) {
          const peerSec = s.lastMessage?.senderSecUid ?? ''
          if (peerSec) cacheSecUid(s.uid, peerSec)
        }
      } catch { /* 拉取失败静默 */ }
      // 兜底：IM 资料接口（入参或缓存 secUid）
      const sec = secUid ?? cachedSecUid(uid)
      if (sec && !cachedNick(uid)) {
        try {
          const profiles = await fetchUserProfiles(bot.ctx.http, [sec])
          const profile = profiles.get(sec)
          if (profile) cacheUserProfile(uid, profile)
        } catch { /* 拉取失败静默 */ }
      }
    }
    return cachedNick(uid)
  } finally {
    fetching.delete(key)
  }
}

/** 定位用户 secUid：缓存 → 群 participants / 私聊线程字段 */
export async function locateSecUid (
  bot: AdapterDouyin,
  uid: string,
  group?: ConversationAddress,
): Promise<string> {
  const known = cachedSecUid(uid)
  if (known) return known
  if (group) {
    try {
      const members = await apiContact.getGroupMembers(bot.ctx.client, group)
      for (const m of members) {
        if (m.secUid) cacheSecUid(m.uid, m.secUid)
      }
    } catch { /* 拉取失败静默 */ }
  } else {
    try {
      const friends = await apiContact.getFriendList(bot.ctx.client)
      for (const f of friends) {
        if (f.secUid) cacheSecUid(f.uid, f.secUid)
      }
      if (!cachedSecUid(uid)) {
        const strangers = await apiContact.getStrangerList(bot.ctx.client)
        for (const s of strangers) {
          const peerSec = s.lastMessage?.senderSecUid ?? ''
          if (peerSec) cacheSecUid(s.uid, peerSec)
        }
      }
    } catch { /* 拉取失败静默 */ }
  }
  return cachedSecUid(uid)
}

/** 按需解析群名：拉群列表回填；未命中返回空串 */
export async function resolveGroupName (bot: AdapterDouyin, shortId: string): Promise<string> {
  if (!shortId || groupNameCache.has(shortId)) return cachedGroupName(shortId)
  const key = `${bot.selfId}:g:${shortId}`
  if (fetching.has(key)) return cachedGroupName(shortId)
  fetching.add(key)
  try {
    try {
      const groups = await apiContact.getGroupList(bot.ctx.client)
      for (const g of groups) {
        if (g.conversationShortId && g.name) groupNameCache.set(g.conversationShortId, g.name)
      }
    } catch { /* 拉取失败静默 */ }
    return cachedGroupName(shortId)
  } finally {
    fetching.delete(key)
  }
}
