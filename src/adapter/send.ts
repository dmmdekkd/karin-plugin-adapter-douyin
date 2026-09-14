import { logger } from 'node-karin'
import type { Contact, SendElement, SendMsgResults } from 'node-karin'
import type { SendMessageResponse, ConversationAddress, TextMention } from '@/core/im'
import type { ForwardNode } from '@/core/im/types'
import { buildForwardNodes } from '@/core/im/send'
import { displayText } from '@/core/im/content'
import { message as apiMessage } from '@/api'
import { cachedNick } from './nick'
import type { DouyinAccount } from '@/types'
import { resolveAddress } from './convert'
import { fileToBytes, sniffFileExt } from './util'

/** 1x1 JPEG 占位封面（视频发送必需 poster） */
const POSTER_JPEG = Uint8Array.from(Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
))

/** karin fake node 元素形状（合并转发自定义节点） */
interface FakeNodeEl {
  userId: string
  nickname: string
  message: Array<{ type: string; text?: string }>
}

/** nodeDirect 节点补全：查最近历史定位原消息（uid/摘要/类型） */
async function resolveDirectNodes (
  account: DouyinAccount,
  address: ConversationAddress,
  messageIds: string[],
): Promise<ForwardNode[]> {
  const wanted = new Set(messageIds)
  const nodes = new Map<string, ForwardNode>()
  try {
    const history = await apiMessage.getHistory(account.client, address, { count: 60 })
    for (const msg of history) {
      if (!msg.msgId || !wanted.has(msg.msgId)) continue
      nodes.set(msg.msgId, {
        uid: msg.senderUid,
        nickname: cachedNick(msg.senderUid) || msg.senderUid,
        text: displayText(msg.content, msg.msgType),
        msgType: msg.msgType,
        aweType: 0,
        msgId: msg.msgId,
        ...(msg.senderSecUid ? { secUid: msg.senderSecUid } : {}),
        ...(msg.createTime ? { createTime: msg.createTime } : {}),
      })
    }
  } catch { /* 历史不可用时直接占位 */ }
  return messageIds.map(id => nodes.get(id) ?? {
    uid: '0', nickname: '', text: '[消息]', msgType: 7, aweType: 700, msgId: id,
  })
}

/** 引用回复补全：查最近历史定位被引用消息（发送者/类型/摘要） */
async function resolveReplyOptions (
  account: DouyinAccount,
  address: ConversationAddress,
  referencedMessageId: string,
  text: string,
): Promise<apiMessage.ReplyOptions | undefined> {
  try {
    const history = await apiMessage.getHistory(account.client, address, { count: 60 })
    const ref = history.find(m => m.msgId === referencedMessageId)
    if (!ref) return undefined
    return {
      ...address,
      text,
      referencedMessageId,
      referencedMessageType: ref.msgType,
      referencedUid: ref.senderUid,
      ...(ref.senderSecUid ? { referencedSecUid: ref.senderSecUid } : {}),
      nickname: cachedNick(ref.senderUid) || '',
      referencedText: displayText(ref.content, ref.msgType),
    }
  } catch {
    return undefined
  }
}

/** 收集合并转发节点：fake（自定义）+ messageID（引用真实消息） */
async function collectForwardNodes (
  account: DouyinAccount,
  address: ConversationAddress,
  elements: Array<SendElement>,
): Promise<ForwardNode[] | undefined> {
  const fakes: FakeNodeEl[] = []
  const directs: string[] = []
  for (const el of elements) {
    if (el.type !== 'node') continue
    if (el.subType === 'fake') {
      fakes.push({
        userId: el.userId,
        nickname: el.nickname,
        message: el.message.map((inner) => {
          const obj = inner as { type?: string; text?: string }
          return { type: String(obj.type ?? 'text'), text: obj.text }
        }),
      })
    } else if (el.subType === 'messageID') {
      directs.push(el.messageId || el.message_id)
    }
  }
  if (!fakes.length && !directs.length) return undefined
  const directNodes = directs.length
    ? await resolveDirectNodes(account, address, directs.filter(Boolean))
    : []
  return [...buildForwardNodes(fakes, account.platformUid, undefined), ...directNodes]
}

/** karin 元素 → 抖音消息（文本聚合发送；图片/视频逐个上传发送） */
export async function sendKarinElements (
  account: DouyinAccount,
  contact: Contact,
  elements: Array<SendElement>,
): Promise<SendMsgResults> {
  const address = await resolveAddress(account, contact)
  if (!address) throw new Error(`[douyin] 无法解析会话目标: ${contact.scene} ${contact.peer}`)

  // 合并转发：node（fake/messageID）节点走 136 单条发送
  const forwardNodes = await collectForwardNodes(account, address, elements)
  if (forwardNodes) {
    const result = await apiMessage.sendForwardNodes(
      account.client, address, forwardNodes, account.platformUid,
    )
    if (result.statusCode !== 0) logger.warn(`[douyin] 合并转发被拒: ${result.statusMsg}`)
    const messageId = result.serverMessageId ?? ''
    const time = Date.now()
    return { messageId, time, rawData: result, message_id: messageId, messageTime: time }
  }

  let last: SendMessageResponse | undefined
  let text = ''
  let pendingReplyId = ''
  const mentions: TextMention[] = []
  const flush = async (): Promise<void> => {
    const chunk = text.trim()
    text = ''
    if (!chunk) return
    if (pendingReplyId) {
      // 引用回复：查历史补全引用信息；定位失败降级为普通文本
      const options = await resolveReplyOptions(account, address, pendingReplyId, chunk)
      pendingReplyId = ''
      last = options
        ? await apiMessage.reply(account.client, options)
        : await apiMessage.sendText(account.client, address, chunk)
      return
    }
    // at 提及：targetId 为数字 uid 时走真 @（richTextInfos + mentionedUsers）
    const valid = mentions.filter(m => /^\d+$/.test(m.uid))
    mentions.length = 0
    last = await apiMessage.sendText(account.client, address, chunk, valid.length ? valid : undefined)
  }

  for (const el of elements) {
    try {
      switch (el.type) {
        case 'text':
          text += el.text
          break
        case 'at': {
          const label = `@${el.name || el.targetId}`
          mentions.push({ uid: el.targetId, text: label, location: text.length, length: label.length })
          text += label
          break
        }
        case 'face':
          text += `[表情:${el.id}]`
          break
        case 'reply':
          pendingReplyId = el.messageId
          break
        case 'image':
          await flush()
          last = await apiMessage.sendImage(account.client, address, await fileToBytes(el.file))
          break
        case 'video':
          await flush()
          last = await apiMessage.sendVideo(
            account.client, address,
            await fileToBytes(el.file), POSTER_JPEG,
            el.width || 720, el.height || 1280,
          )
          break
        case 'record':
          text += '[语音]暂不支持'
          break
        case 'file': {
          await flush()
          const bytes = await fileToBytes(el.file)
          // name 缺扩展名时按魔数补全（format 空会进文件审核）
          const name = /\.[a-z0-9]+$/i.test(el.name || '') ? el.name! : `${el.name || 'file'}${sniffFileExt(bytes) ? `.${sniffFileExt(bytes)}` : ''}`
          last = await apiMessage.sendFile(account.client, address, bytes, name)
          break
        }
        case 'reply':
          break
        default:
          break
      }
    } catch (err) {
      logger.error(`[douyin] 发送元素 ${el.type} 失败:`, err)
    }
  }
  await flush()

  const messageId = last?.serverMessageId ?? ''
  const time = Date.now()
  return { messageId, time, rawData: last ?? [], message_id: messageId, messageTime: time }
}
