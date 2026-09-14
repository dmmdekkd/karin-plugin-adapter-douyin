import {
  logger,
  contactFriend, contactGroup,
  senderFriend, senderGroup,
  createFriendMessage, createGroupMessage,
} from 'node-karin'
import { parsePeerFromConversationId } from '@/core/im'
import type { InboundMessage } from '@/core/im'
import { toKarinElements } from './convert'
import { cachedNick, cachedGroupName, resolveNick, resolveGroupName } from './nick'
import type { AdapterDouyin } from './index'

/** 抖音入站消息 → karin 消息事件 */
export function dispatchMessage (bot: AdapterDouyin, msg: InboundMessage): void {
  try {
    if (msg.senderUid === bot.selfId) return
    // 空文本推送（如 aweType=133 系统引导模板）无内容价值，不分发
    if (msg.parsed.kind === 'text' && !msg.parsed.text) return

    const elements = toKarinElements(msg)
    const messageId = msg.serverMessageId || `${msg.cmd}-${msg.indexInConversationV2 ?? msg.indexInConversation ?? Date.now()}`
    const seq = Number(msg.indexInConversationV2 || msg.indexInConversation || msg.serverMessageId || 0)
      || Math.floor(Date.now() / 1000)
    const time = Number(msg.createTime) > 0 ? Math.floor(Number(msg.createTime) / 1000) : Math.floor(Date.now() / 1000)
    const nick = cachedNick(msg.senderUid)

    if (msg.conversationType === 2) {
      const peer = msg.conversationShortId || msg.conversationId
      const groupName = cachedGroupName(peer)
      const contact = contactGroup(peer, groupName || undefined)
      // 昵称/群名未命中缓存时异步补全（后续消息生效）
      const groupAddress = {
        conversationId: msg.conversationId,
        conversationShortId: msg.conversationShortId,
        conversationType: 2 as const,
      }
      if (!nick) void resolveNick(bot, msg.senderUid, groupAddress)
      if (!groupName) void resolveGroupName(bot, peer)
      createGroupMessage({
        bot,
        contact,
        elements,
        eventId: messageId,
        messageId,
        messageSeq: seq,
        rawEvent: msg.raw,
        sender: senderGroup(msg.senderUid, 'member', nick || undefined),
        time,
        srcReply: elems => bot.sendMsg(contact, elems),
      })
    } else {
      const peer = parsePeerFromConversationId(msg.conversationId, bot.selfId) || msg.senderUid
      const contact = contactFriend(peer, nick || undefined)
      if (!nick) void resolveNick(bot, msg.senderUid, undefined, msg.senderSecUid)
      createFriendMessage({
        bot,
        contact,
        elements,
        eventId: messageId,
        messageId,
        messageSeq: seq,
        rawEvent: msg.raw,
        sender: senderFriend(msg.senderUid, nick || undefined),
        time,
        srcReply: elems => bot.sendMsg(contact, elems),
      })
    }
  } catch (err) {
    logger.error('[douyin] 处理入站消息失败:', err)
  }
}
