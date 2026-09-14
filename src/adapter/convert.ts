import { segment } from 'node-karin'
import type { Elements } from 'node-karin'
import { pickImageUrl, type ImageResource } from '@/core/im'
import type { InboundMessage } from '@/core/im'
import type { ForwardNode } from '@/core/im'
import type { ConversationAddress } from '@/core/im'
import type { DouyinAccount, ResolvedAddress } from '@/types'
import * as apiContact from '@/api/contact'

/** 合并转发节点缓存：resId（消息 ID）→ 节点，getForwardMsg 供插件拉取 */
const forwardCache = new Map<string, ForwardNode[]>()

/** 读取合并转发节点缓存 */
export function loadForwardNodes (resId: string): ForwardNode[] | undefined {
  return forwardCache.get(resId)
}

function cacheForwardNodes (resId: string, nodes: ForwardNode[]): void {
  forwardCache.set(resId, nodes)
  if (forwardCache.size > 200) {
    const first = forwardCache.keys().next().value
    if (first) forwardCache.delete(first)
  }
}

/** 入站抖音消息 → karin Elements 数组 */
export function toKarinElements (message: InboundMessage): Elements[] {
  const p = message.parsed
  switch (p.kind) {
    case 'text':
      // 引用回复：reply 元素 + 正文
      if (message.reference) {
        const body = p.text ? [segment.text(p.text)] : []
        return [segment.reply(message.reference.referencedMessageId), ...body]
      }
      return [segment.text(p.text)]
    case 'emoji':
      return [segment.text(p.text || '[表情]')]
    case 'image': {
      const url = pickImageUrl(p.image)
      return url ? [segment.image(url)] : [segment.text(p.text || '[图片]')]
    }
    case 'video': {
      const poster = p.video.poster ? pickImageUrl(p.video.poster) : undefined
      const parts: Elements[] = []
      if (poster) parts.push(segment.image(poster))
      parts.push(segment.text(p.text || '[视频]'))
      return parts
    }
    case 'file':
      return [segment.text(p.file.name ? `[文件] ${p.file.name}` : '[文件]')]
    case 'audio':
      return [segment.text(p.text || '[语音]')]
    case 'share':
      return [segment.text(p.share.title ? `[分享] ${p.share.title}` : '[分享]')]
    case 'link':
      return [segment.text(p.link.title ? `[链接] ${p.link.title} ${p.link.url || ''}` : (p.text || '[链接]'))]
    case 'user':
      return [segment.text(p.user.name ? `[名片] ${p.user.name}` : '[名片]')]
    case 'forward': {
      // karin 合并转发：longMsg 占位，节点缓存供 getForwardMsg 拉取
      const resId = message.serverMessageId || ''
      if (resId && p.nodes.length) {
        cacheForwardNodes(resId, p.nodes)
        return [segment.longMsg(resId)]
      }
      return [segment.text(p.text || '[合并转发]')]
    }
    default:
      return [segment.text(p.text || '[未知消息]')]
  }
}

/** 根据 contact 场景把 karin 目标解析为抖音会话地址（friend: 查好友；group: 查群） */
export async function resolveAddress (account: DouyinAccount, contact: { scene?: string; peer: string }): Promise<ResolvedAddress | undefined> {
  if (!contact || !contact.peer) return undefined
  if (contact.scene === 'group') {
    const address = await apiContact.resolveGroupAddress(account.client, contact.peer)
    if (!address) return undefined
    return { ...address, groupName: contact.peer }
  }
  // 好友/私聊均按 uid 解析
  const address = await apiContact.resolveFriendAddress(account.client, contact.peer)
  if (!address) return undefined
  return { ...address, peerUid: contact.peer }
}
