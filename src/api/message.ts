import type { ImClient, InboundMessage, ConversationAddress } from '@/core/im'
import type { ForwardNode } from '@/core/im/types'
import type { ReplyOptions, TextMention } from '@/core/im'
import { buildForwardNodes } from '@/core/im/send'
import type { ResolvedAddress } from '@/types'

/** 发送文本（可带 @ 提及） */
export async function sendText (client: ImClient, address: ConversationAddress, text: string, mentions?: TextMention[]) {
  return client.sendText(address, text, mentions)
}

/** 合并转发（136）：nodes 已构造（fake 节点由 buildForwardNodes 转换） */
export async function sendForwardNodes (
  client: ImClient,
  address: ConversationAddress,
  nodes: ForwardNode[],
  selfUid: string,
  selfSecUid?: string,
) {
  return client.sendMergeForward({
    ...address,
    nodes,
    selfUid,
    ...(selfSecUid ? { selfSecUid } : {}),
  })
}

/** 发送图片：data 为原始字节（已上传前的 Buffer/Uint8Array） */
export async function sendImage (client: ImClient, address: ConversationAddress, data: Uint8Array) {
  const asset = await client.uploadImage(data)
  return client.sendMedia({ ...address, image: asset })
}

/** 发送视频 */
export async function sendVideo (
  client: ImClient,
  address: ConversationAddress,
  data: Uint8Array,
  poster: Uint8Array,
  width: number,
  height: number,
) {
  const asset = await client.uploadVideo(data)
  const posterAsset = await client.uploadImage(poster)
  return client.sendMedia({ ...address, video: { asset, poster: posterAsset, width, height } })
}

/** 发送文件：data 为原始字节，name 为文件名（≤10MiB） */
export async function sendFile (client: ImClient, address: ConversationAddress, data: Uint8Array, name: string) {
  const asset = await client.uploadFile(data, name)
  return client.sendMedia({ ...address, file: asset })
}

/** 引用回复（cmd=100 + refMsgInfo，引用信息已补全） */
export async function reply (client: ImClient, options: ReplyOptions) {
  return client.reply(options)
}

export type { ReplyOptions }

/** 撤回 */
export async function recall (client: ImClient, address: ConversationAddress, messageId: string) {
  return client.recall({ ...address, serverMessageId: messageId })
}

/** 历史消息（cursor = indexInConversation 游标，0 表示最新） */
export async function getHistory (
  client: ImClient,
  address: ResolvedAddress,
  options: { cursor?: number; count?: number } = {},
) {
  return client.getChatHistory({ ...address, ...options })
}

export type {
  InboundMessage,
}
