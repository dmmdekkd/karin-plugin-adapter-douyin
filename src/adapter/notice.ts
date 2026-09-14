import {
  logger,
  contactFriend, contactGroup,
  senderFriend, senderGroup,
  createFriendIncreaseNotice, createFriendDecreaseNotice,
  createPrivateRecallNotice, createGroupRecallNotice,
  createGroupMemberAddNotice, createGroupMemberDelNotice,
  createGroupAdminChangedNotice,
  createGroupMessageReactionNotice,
} from 'node-karin'
import { parsePeerFromConversationId } from '@/core/im'
import { dir } from '@/dir'
import { requireFileSync } from 'node-karin'
import fs from 'node:fs'
import path from 'node:path'
import type { NoticeEvent } from '@/core/im'
import type { AdapterDouyin } from './index'

const now = (): number => Math.floor(Date.now() / 1000)

/** 抖音表态键值 → karin faceId（resources/reactions.json 反查，未收录返回 0） */
function emojiToFaceId (emoji: string): number {
  for (const base of [dir.defResourcesDir, path.join(dir.pluginDir, 'resources')]) {
    const file = path.join(base, 'reactions.json')
    if (fs.existsSync(file)) {
      const table = requireFileSync(file) as Record<string, string>
      const hit = Object.entries(table).find(([, key]) => key === emoji)
      if (hit) return Number(hit[0])
    }
  }
  return 0
}

/** 通知事件公共参数（eventId/rawEvent/time/srcReply 由调用方补 contact/sender/content） */
const common = (bot: AdapterDouyin, raw: Record<string, unknown>) => ({
  bot,
  eventId: `douyin-notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  rawEvent: raw,
  time: now(),
})

/** 抖音通知事件 → karin 通知事件 */
export function dispatchNotice (bot: AdapterDouyin, ev: NoticeEvent): void {
  try {
    switch (ev.type) {
      case 'message.reaction': {
        const faceId = emojiToFaceId(ev.emoji)
        logger.info(
          `[抖音] 表情回应: msgId=${ev.serverMessageId} emoji=${ev.emoji} ` +
          `operator=${ev.operatorUid} isSet=${ev.isSet}`,
        )
        // karin 仅提供群 reaction 事件类型（会话 0:2:*）；私聊回应仅日志
        if (!ev.conversationId.startsWith('0:2:')) return
        const contact = contactGroup(ev.conversationId)
        createGroupMessageReactionNotice({
          ...common(bot, ev.raw),
          contact,
          sender: senderGroup(ev.operatorUid, 'member'),
          srcReply: (elems: any) => bot.sendMsg(contact, elems),
          content: { messageId: ev.serverMessageId, faceId, count: 1, isSet: ev.isSet },
        })
        return
      }
      case 'friend.increase':
      case 'friend.decrease': {
        const contact = contactFriend(ev.peerUid)
        const base = {
          ...common(bot, ev.raw),
          contact,
          sender: senderFriend(ev.peerUid),
          srcReply: (elems: any) => bot.sendMsg(contact, elems),
        }
        if (ev.type === 'friend.increase') {
          createFriendIncreaseNotice({ ...base, content: { targetId: ev.peerUid } })
        } else {
          createFriendDecreaseNotice({ ...base, content: { targetId: ev.peerUid } })
        }
        break
      }

      case 'message.recall': {
        const messageId = ev.serverMessageId ?? ''
        if (ev.conversationType === 2) {
          const operatorId = typeof ev.raw['operatorId'] === 'string' ? ev.raw['operatorId'] : ''
          const contact = contactGroup(ev.conversationId)
          createGroupRecallNotice({
            ...common(bot, ev.raw),
            contact,
            sender: senderGroup(operatorId, 'member'),
            srcReply: elems => bot.sendMsg(contact, elems),
            content: { operatorId, targetId: operatorId, messageId, tip: '' },
          })
        } else {
          const peer = parsePeerFromConversationId(ev.conversationId, bot.selfId) || ev.conversationId
          const contact = contactFriend(peer)
          createPrivateRecallNotice({
            ...common(bot, ev.raw),
            contact,
            sender: senderFriend(peer),
            srcReply: elems => bot.sendMsg(contact, elems),
            content: { operatorId: peer, messageId, tips: '' },
          })
        }
        break
      }

      case 'group.member-increase': {
        const contact = contactGroup(ev.conversationShortId || ev.conversationId)
        const base = {
          ...common(bot, ev.raw),
          contact,
          srcReply: (elems: any) => bot.sendMsg(contact, elems),
        }
        for (const member of ev.members) {
          createGroupMemberAddNotice({
            ...base,
            sender: senderGroup(member.uid, 'member'),
            content: {
              operatorId: ev.operators[0]?.uid ?? '',
              targetId: member.uid,
              type: ev.source === 'invite' ? 'invite' : 'approve',
            },
          })
        }
        break
      }

      case 'group.member-decrease': {
        const contact = contactGroup(ev.conversationShortId || ev.conversationId)
        const base = {
          ...common(bot, ev.raw),
          contact,
          srcReply: (elems: any) => bot.sendMsg(contact, elems),
        }
        for (const member of ev.members) {
          createGroupMemberDelNotice({
            ...base,
            sender: senderGroup(member.uid, 'member'),
            content: {
              operatorId: ev.operators[0]?.uid ?? '',
              targetId: member.uid,
              type: ev.source === 'kick' ? 'kick' : 'leave',
            },
          })
        }
        break
      }

      case 'group.admin': {
        const contact = contactGroup(ev.conversationShortId || ev.conversationId)
        const base = {
          ...common(bot, ev.raw),
          contact,
          srcReply: (elems: any) => bot.sendMsg(contact, elems),
        }
        for (const member of ev.members) {
          createGroupAdminChangedNotice({
            ...base,
            sender: senderGroup(member.uid, 'member'),
            content: { targetId: member.uid, isAdmin: true },
          })
        }
        break
      }

      default:
        logger.debug('[douyin] 未处理通知:', ev.type)
    }
  } catch (err) {
    logger.error('[douyin] 处理通知事件失败:', err)
  }
}
