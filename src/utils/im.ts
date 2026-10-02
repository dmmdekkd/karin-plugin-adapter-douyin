import type { Log } from 'douyin.ts'
import { logger } from 'node-karin'

/** 官方 PC 客户端 UA（桌面 IM HTTP 接口共用） */
export const DESKTOP_PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) douyin/8.5.302 Chrome/136.0.7103.59 Electron/36.4.0-rs.31.release.pgo.7 TTElectron/36.4.0-rs.31.release.pgo.7 Safari/537.36 awemePcClient/8.5.302 buildId/469548567 osName/Windows'

/** karin fake node 的 message 元素（合并转发节点构建输入） */
interface NodeElement {
  type: string
  text?: string
}

/** 合并转发节点（与 douyin.ts 全局 ForwardNode 同形；send 侧消息体所需，SDK 未导出） */
export interface ForwardNode {
  uid: string
  nickname: string
  text: string
  msgType: number
  aweType: number
  msgId: string
  secUid?: string
  createTime?: number
}

/** 节点摘要：文字原样，媒体占位 */
function nodeSummaryText (message: NodeElement[]): string {
  return message.map(el => {
    switch (el.type) {
      case 'text': return el.text ?? ''
      case 'image': return '[图片]'
      case 'video': return '[视频]'
      case 'record': return '[语音]'
      default: return `[${el.type}]`
    }
  }).join('')
}

/** 节点消息类型：图片 27/2702，其余按文本 7/700 */
function nodeMessageType (message: NodeElement[]): { msgType: number, aweType: number } {
  return message[0]?.type === 'image'
    ? { msgType: 27, aweType: 2702 }
    : { msgType: 7, aweType: 700 }
}

/** karin fake node → 合并转发节点（客户端生成 19 位数字 msg_id） */
export function buildForwardNodes (
  nodes: Array<{ userId: string, nickname: string, message: NodeElement[] }>,
  selfUid: string
): ForwardNode[] {
  const timestamp = Date.now()
  return nodes.map((node, index) => {
    const { msgType, aweType } = nodeMessageType(node.message)
    return {
      uid: /^\d+$/.test(node.userId) ? node.userId : selfUid,
      nickname: node.nickname || '',
      text: nodeSummaryText(node.message),
      msgType,
      aweType,
      msgId: String(BigInt(timestamp) * 1000n + BigInt(index)),
      createTime: timestamp,
    }
  })
}

/** 从会话 ID（`0:1:{uidA}:{uidB}`）解析对端 UID 与自身不相同时返回对端，否则返回空串 */
export function parsePeerFromConversationId (conversationId: string, myUid: string): string {
  const parts = conversationId.split(':')
  if (parts.length >= 4 && parts[1] === '1') {
    const uidA = parts[2]!
    const uidB = parts[3]!
    return uidA === myUid ? uidB : uidA
  }
  return ''
}

/** SDK 日志收敛到 karin：info 降为 debug（协议帧等调试信息默认隐藏），warn/error 对应转发，格式统一 karin 日志 */
export const sdkLog: Log = {
  info: (msg) => logger.debug(`[douyin] ${msg}`),
  warn: (msg) => logger.warn(`[douyin] ${msg}`),
  error: (msg) => logger.error(`[douyin] ${msg}`),
}
