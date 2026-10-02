import { logger, segment } from 'node-karin'
import type { Elements, Contact, SendElement, SendMsgResults } from 'node-karin'
import type { BotMessage, ConversationAddress, MsgBody, RecvBody } from 'douyin.ts'
import type { DouyinAccount } from '@/types'
import { buildForwardNodes, type ForwardNode } from '@/utils/im'
import { resolveChatId, chatAddressOf } from './contact'
import { mediaUrl } from './media'

/** 收侧图片资源（SDK 未导出，从 RecvBody 提取） */
type ImageResource = Extract<RecvBody, { type: 'image' }>['image']

/** 合并转发节点缓存：resId（消息 ID）→ 节点，getForwardMsg 供插件拉取 */
const forwardCache = new Map<string, ForwardNode[]>()

/** 引用回复缓存：`${平台uid}:${serverMessageId}` → 入站消息，收消息时缓存、300 秒后过期（对齐参考插件 replys，免查历史） */
const replyCache = new Map<string, BotMessage>()

/** SDK 未导出的发送响应结构 */
interface SendMessageResponse {
  statusCode: number
  statusMsg: string
  serverMessageId?: string
  clientMessageId?: string
  checkCode?: number
}

/** SDK 未导出的引用回复选项（im().reply 入参） */
interface ReplyOptions extends ConversationAddress {
  text: string
  referencedMessageId: string
  referencedMessageType: number
  referencedUid: string
  referencedSecUid?: string
  nickname?: string
  referencedText?: string
  rootMessageId?: string
  rootMessageConvIndex?: string
}

/** karin fake node 元素形状（合并转发自定义节点） */
interface FakeNodeEl {
  userId: string
  nickname: string
  message: Array<{ type: string, text?: string }>
}

/** 1x1 JPEG 占位封面（视频发送必需 poster） */
const POSTER_JPEG = Uint8Array.from(Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64'
))

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

/** 记录入站引用的原消息（发送侧引用回复优先取缓存，命中即免查历史） */
export function rememberReply (account: DouyinAccount, msg: BotMessage): void {
  if (!msg.serverMessageId) return
  const key = `${account.platformUid}:${msg.serverMessageId}`
  replyCache.set(key, msg)
  setTimeout(() => replyCache.delete(key), 300_000).unref()
}

function isObject (v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function stringArray (v: unknown): string[] {
  return Array.isArray(v) ? v.filter((item): item is string => typeof item === 'string') : []
}

/** 从图片资源取可访问 URL（转码档 WebP 优先；无 URL 返回 undefined） */
function pickImage (image: ImageResource): { url: string, skey: string } | undefined {
  const url = image.largeUrls?.[0] ?? image.mediumUrls?.[0] ?? image.thumbUrls?.[0] ?? image.originUrls?.[0]
  return url ? { url, skey: image.skey } : undefined
}

/** 复刻 SDK parseBody：wire content + messageType → 收侧消息体（只覆盖参考插件 8 类，其余兜底文本） */
export function parseContent (content: string, messageType: number | null): RecvBody {
  let value: Record<string, unknown> | undefined
  try {
    // 19 位大整数（uid/msgId 等）转字符串避免 JSON 精度丢失
    const decoded: unknown = JSON.parse(content.replace(/"(\w+)"\s*:\s*(\d{16,})/g, '"$1":"$2"'))
    if (!isObject(decoded)) return { type: 'unknown', text: content, raw: content }
    value = decoded
  } catch {
    return { type: 'text', text: content }
  }
  const aweType = Number(value['aweType'] ?? value['awe_type'] ?? 0)
  const text = String(value['text'] ?? value['content'] ?? value['display_name'] ?? '')
  if (messageType === 17) {
    const resource = isObject(value['resource_url']) ? value['resource_url'] : undefined
    return { type: 'audio', text: text || '[语音]', audio: { urls: stringArray(resource?.['url_list']), uri: String(resource?.['uri'] ?? '') } }
  }
  if (messageType === 6 || messageType === 150) {
    return {
      type: 'file',
      text: String(value['name'] ?? '') || '[文件]',
      file: {
        uri: String(value['uri'] ?? ''),
        skey: String(value['skey'] ?? ''),
        md5: String(value['md5'] ?? ''),
        name: String(value['name'] ?? ''),
        dataSize: Number(value['data_size'] ?? 0),
      },
    }
  }
  if (messageType === 73 || messageType === 90) return { type: 'text', text: String(value['hint'] ?? '') }
  if (messageType === 1 && aweType === 133) return { type: 'text', text: '' }
  if (messageType === 136) {
    const summary = Array.isArray(value['list_content']) ? value['list_content'] : []
    const refs = Array.isArray(value['msg_ids']) ? value['msg_ids'] : []
    const refById = new Map<string, Record<string, unknown>>()
    for (const ref of refs) {
      if (isObject(ref)) refById.set(String(ref['msg_id'] ?? ''), ref)
    }
    const nodes: ForwardNode[] = []
    for (const item of summary) {
      if (!isObject(item)) continue
      const msgId = String(item['msgid'] ?? '')
      const ref = refById.get(msgId)
      nodes.push({
        uid: String(ref?.['uid'] ?? ''),
        nickname: String(item['nick_name'] ?? ''),
        text: String(item['text'] ?? ''),
        msgType: Number(ref?.['msg_type'] ?? 0),
        aweType: Number(ref?.['awe_type'] ?? 0),
        msgId,
        ...(ref?.['sec_uid'] ? { secUid: String(ref['sec_uid']) } : {}),
        ...(ref?.['create_time'] ? { createTime: Number(ref['create_time']) } : {}),
      })
    }
    return { type: 'forward', text: '[合并转发]', nodes }
  }
  if (messageType === 502) {
    const cover = isObject(isObject(value['cover_info']) ? value['cover_info']['resource_url'] : undefined)
      ? (isObject(value['cover_info']) ? value['cover_info'] : {})['resource_url'] as Record<string, unknown>
      : undefined
    return {
      type: 'location',
      text: String(value['poi_name'] ?? value['poi_address'] ?? '') || '[位置]',
      location: {
        name: String(value['poi_name'] ?? ''),
        address: String(value['poi_address'] ?? ''),
        latitude: Number(value['latitude'] ?? 0),
        longitude: Number(value['longitude'] ?? 0),
        poiId: String(value['poi_id'] ?? ''),
        awemePoiId: String(value['aweme_poi_id'] ?? ''),
        uri: String(cover?.['uri'] ?? ''),
        urlList: stringArray(cover?.['url_list']),
      },
    }
  }
  if (messageType != null && ![1, 2, 5, 7, 27, 30].includes(messageType)) {
    return { type: 'unknown', text, raw: value }
  }
  const image = imageFromObject(value)
  if (image) return { type: 'image', text: text || '[图片]', image }
  const videoValue = isObject(value['video']) ? value['video'] : undefined
  if (videoValue) {
    const poster = isObject(value['poster']) ? imageFromObject(value['poster']) : undefined
    return {
      type: 'video',
      text: text || '[视频]',
      video: {
        tkey: String(videoValue['tkey'] ?? ''),
        skey: String(videoValue['skey'] ?? ''),
        md5: String(videoValue['md5'] ?? ''),
        width: Number(value['width'] ?? 0),
        height: Number(value['height'] ?? 0),
        checkPics: stringArray(value['check_pics']),
        ...(poster ? { poster } : {}),
        ...(value['inline_pic'] ? { inlinePic: String(value['inline_pic']) } : {}),
      },
    }
  }
  const emojiUrl = isObject(value['url']) ? value['url'] : undefined
  const url = String(emojiUrl?.['uri'] ?? stringArray(emojiUrl?.['url_list'])[0] ?? '')
  if (aweType === 507 || url) return { type: 'emoji', text: text || '[表情]', emoji: url }
  if (text || 'text' in value) {
    const mentions = mentionsFromValue(value)
    if (!mentions) return { type: 'text', text }
    const stripped = stripMentions(text, mentions)
    const ats = mentions.sort((a, b) => a.location - b.location).map(m => ({ uid: m.uid }))
    return { type: 'text', text: stripped || text, ats }
  }
  return { type: 'unknown', text, raw: value }
}

/** 复刻 SDK imageFromObject：resource_url 兜底取 value 本身，URL 双来源读取 */
function imageFromObject (value: Record<string, unknown>): ImageResource | undefined {
  const resource = isObject(value['resource_url']) ? value['resource_url'] : value
  const oid = String(resource['oid'] ?? resource['uri'] ?? '')
  const skey = String(resource['skey'] ?? '')
  const urls = (name: string): string[] => stringArray(resource[name] ?? value[name])
  if (!oid && !skey && !['origin_url_list', 'large_url_list', 'medium_url_list', 'thumb_url_list'].some(name => urls(name).some(Boolean))) {
    return undefined
  }
  return {
    oid,
    skey,
    md5: String(resource['md5'] ?? value['md5'] ?? ''),
    dataSize: Number(resource['data_size'] ?? value['data_size'] ?? 0),
    width: Number(value['cover_width'] ?? resource['width'] ?? 0),
    height: Number(value['cover_height'] ?? resource['height'] ?? 0),
    originUrls: urls('origin_url_list'),
    largeUrls: urls('large_url_list'),
    mediumUrls: urls('medium_url_list'),
    thumbUrls: urls('thumb_url_list'),
  }
}

/** 复刻 SDK mentionsFromValue：仅 infoType=1（@ 人）计入，取 uid/location/length */
function mentionsFromValue (value: Record<string, unknown>): Array<{ uid: string, location: number, length: number }> | undefined {
  const infos = value['richTextInfos']
  if (!Array.isArray(infos) || infos.length === 0) return undefined
  const mentions: Array<{ uid: string, location: number, length: number }> = []
  for (const item of infos) {
    const record = isObject(item) ? item : undefined
    if (!record || Number(record['infoType']) !== 1) continue
    const info = isObject(record['info']) ? record['info'] : undefined
    const uid = String(info?.['uid'] ?? '')
    if (!uid) continue
    mentions.push({ uid, location: Number(record['location'] ?? 0), length: Number(record['length'] ?? 0) })
  }
  return mentions.length ? mentions : undefined
}

/** 复刻 SDK stripMentions：按 location/length 从后往前剥离 @ 片段 */
function stripMentions (text: string, mentions: Array<{ location: number, length: number }>): string {
  let rest = text
  for (const m of [...mentions].sort((a, b) => b.location - a.location)) {
    if (m.location < 0 || m.location + m.length > rest.length) continue
    rest = rest.slice(0, m.location) + rest.slice(m.location + m.length)
  }
  return rest
}

/** 收侧消息体 → karin 元素：媒体走鉴权代理，无直链资源按封面/占位还原 */
function bodyToElements (body: RecvBody, uid: string, resId: string): Elements[] {
  switch (body.type) {
    case 'text': {
      const segs: Elements[] = []
      for (const at of body.ats ?? []) {
        if (at.uid) segs.push(segment.at(at.uid))
      }
      return [...segs, segment.text(body.text)]
    }
    case 'emoji':
      return body.emoji ? [segment.image(mediaUrl(uid, body.emoji))] : [segment.text(body.text ?? '')]
    case 'image': {
      const img = pickImage(body.image)
      return img ? [segment.image(mediaUrl(uid, img.url, img.skey))] : []
    }
    case 'video': {
      // 事件推送视频带播放地址（CENC 加密流经代理解密）；历史消息无 url 时回退封面/内置缩略图
      const play = body.video.url?.mainUrl ?? body.video.url?.backupUrl
      if (play) return [segment.video(mediaUrl(uid, play, body.video.skey))]
      const poster = body.video.poster ? pickImage(body.video.poster) : undefined
      if (poster) return [segment.image(mediaUrl(uid, poster.url, poster.skey))]
      if (body.video.inlinePic) return [segment.image(body.video.inlinePic)]
      return []
    }
    case 'audio': {
      const url = body.audio.urls[0] ?? ''
      return url ? [segment.record(mediaUrl(uid, url))] : []
    }
    case 'file':
      return [segment.file(body.file.md5, { name: body.file.name, size: body.file.dataSize, hash: body.file.md5 })]
    case 'forward': {
      // karin 合并转发：longMsg 占位，节点缓存供 getForwardMsg 拉取
      if (resId && body.nodes.length) {
        cacheForwardNodes(resId, body.nodes)
        return [segment.longMsg(resId)]
      }
      return [segment.text(body.text || '[合并转发]')]
    }
    default:
      return [segment.text(body.text || '[未知消息]')]
  }
}

/** 抖音消息 → karin 元素（引用回复前置 reply 元素；收/历史消息共用同一入口） */
export function toElements (
  content: string,
  messageType: number | null,
  resId: string,
  uid: string,
  reference?: { referencedMessageId: string }
): Elements[] {
  const body = parseContent(content, messageType)
  const elements = bodyToElements(body, uid, resId)
  if (reference) return [segment.reply(reference.referencedMessageId), ...elements]
  return elements.length ? elements : [segment.text(body.text || '[未知消息]')]
}

/** 历史消息展示摘要（发送侧合并转发节点/引用回复补全用） */
function historySummary (content: string, messageType: number | null): string {
  const body = parseContent(content, messageType)
  return body.text || '[未知消息]'
}

/** karin 媒体源 → SDK 可识别输入：剥掉 base64:// 前缀（SDK 只认纯 base64/URL/本地路径） */
function mediaSource (file: string): string {
  return file.startsWith('base64://') ? file.slice(9) : file
}

/** fake node 元素消息归一化（缺省类型按 text） */
function normalizeNodeMessage (inner: unknown): { type: string, text?: string } {
  const obj = inner as { type?: string, text?: string }
  return { type: String(obj.type ?? 'text'), text: obj.text }
}

/** nodeDirect 节点补全：查最近历史定位原消息（uid/摘要/类型），失败按占位 */
async function resolveDirectNodes (
  account: DouyinAccount,
  chatId: string,
  messageIds: string[]
): Promise<ForwardNode[]> {
  const wanted = new Set(messageIds)
  const nodes = new Map<string, ForwardNode>()
  try {
    const history = await account.bot.chat.history(chatId, { count: 60 })
    for (const msg of history) {
      if (!msg.msgId || !wanted.has(msg.msgId)) continue
      nodes.set(msg.msgId, {
        uid: msg.senderUid,
        nickname: (await account.bot.nickOf(msg.senderUid)) ?? msg.senderUid,
        text: historySummary(msg.content, msg.msgType),
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

/** 引用回复选项：优先取收消息时缓存的原文（免查历史）；未命中降级查最近 60 条，仍无返回 undefined */
async function makeReplyOptions (
  account: DouyinAccount,
  chatId: string,
  referencedMessageId: string,
  text: string
): Promise<ReplyOptions | undefined> {
  const cached = replyCache.get(`${account.platformUid}:${referencedMessageId}`)
  if (cached) {
    return {
      ...chatAddressOf(chatId),
      text,
      referencedMessageId,
      referencedMessageType: cached.messageType ?? 0,
      referencedUid: cached.senderUid,
      ...(cached.senderSecUid ? { referencedSecUid: cached.senderSecUid } : {}),
      nickname: cached.senderNickname ?? '',
      referencedText: cached.text || historySummary(cached.content, cached.messageType ?? 0),
    }
  }
  try {
    const history = await account.bot.chat.history(chatId, { count: 60 })
    const ref = history.find(m => m.msgId === referencedMessageId)
    if (!ref) return undefined
    return {
      ...chatAddressOf(chatId),
      text,
      referencedMessageId,
      referencedMessageType: ref.msgType,
      referencedUid: ref.senderUid,
      ...(ref.senderSecUid ? { referencedSecUid: ref.senderSecUid } : {}),
      nickname: (await account.bot.nickOf(ref.senderUid)) ?? '',
      referencedText: historySummary(ref.content, ref.msgType),
    }
  } catch {
    return undefined
  }
}

/** 发送摘要：text 原样、媒体类型占位（对齐参考插件 makeBrief） */
function makeBrief (body: MsgBody): string {
  switch (body.type) {
    case 'text': return body.text || '(空)'
    case 'image': return '[图片]'
    case 'video': return '[视频]'
    case 'file': return `[文件:${'name' in body.file ? (body.file.name ?? '') : ''}]`
    case 'forward': return `[合并转发:${body.nodes.length}条]`
    default: return `[${body.type}]`
  }
}

/** 校验发送响应：非 0 抛错（401/login/expire 提示重登）；成功写中文发送日志 */
function checkSend (account: DouyinAccount, ret: SendMessageResponse, target: string, brief: string): SendMessageResponse {
  if (ret.statusCode !== 0) {
    if (/401|login|expire/i.test(ret.statusMsg)) {
      logger.error(`[douyin][${account.platformUid}] 登录态失效（${ret.statusMsg}），请重新扫码登录`)
    }
    throw new Error(`[douyin] 发送${brief}失败: ${ret.statusMsg} (code=${ret.statusCode})`)
  }
  logger.info(`[douyin] 发送到 ${target}: ${brief}`)
  return ret
}

/** 单条发送入口：状态校验 + 结果日志（媒体由 SDK 自动上传） */
async function sendBody (
  account: DouyinAccount,
  chatId: string,
  body: MsgBody,
  target: string
): Promise<SendMessageResponse> {
  return checkSend(account, await account.bot.msg.send(chatId, body), target, makeBrief(body))
}

/** 引用回复发送：定位失败降级为普通文本 */
async function sendReply (
  account: DouyinAccount,
  chatId: string,
  referencedMessageId: string,
  chunk: string,
  target: string
): Promise<SendMessageResponse> {
  const options = await makeReplyOptions(account, chatId, referencedMessageId, chunk)
  if (!options) return sendBody(account, chatId, { type: 'text', text: chunk }, target)
  const ret = await account.bot.im().reply(options)
  return checkSend(account, ret, target, makeBrief({ type: 'text', text: chunk }))
}

/** 收集合并转发节点：fake（自定义）+ messageID（引用真实消息） */
async function collectForwardNodes (
  account: DouyinAccount,
  chatId: string,
  elements: Array<SendElement>
): Promise<ForwardNode[] | undefined> {
  const fakes: FakeNodeEl[] = []
  const directs: string[] = []
  for (const el of elements) {
    if (el.type !== 'node') continue
    if (el.subType === 'fake') {
      fakes.push({
        userId: el.userId,
        nickname: el.nickname,
        message: el.message.map(normalizeNodeMessage),
      })
    } else if (el.subType === 'messageID') {
      directs.push(el.messageId || el.message_id)
    }
  }
  if (!fakes.length && !directs.length) return undefined
  const directNodes = directs.length
    ? await resolveDirectNodes(account, chatId, directs.filter(Boolean))
    : []
  return [...buildForwardNodes(fakes, account.platformUid), ...directNodes]
}

/** karin 元素 → 抖音消息：node 合并转发单发；text/at/face 聚合、reply 带引用、媒体逐条发送（对齐参考插件 makeMsg） */
export async function makeMsg (
  account: DouyinAccount,
  contact: Contact,
  elements: Array<SendElement>
): Promise<SendMsgResults> {
  const chatId = await resolveChatId(account, contact)
  if (!chatId) throw new Error(`[douyin] 无法解析会话目标: ${contact.scene} ${contact.peer}`)
  const target = contact.scene === 'group' ? `Group(${contact.peer})` : `User(${contact.peer})`

  // 合并转发：node（fake/messageID）节点单条发送
  const forwardNodes = await collectForwardNodes(account, chatId, elements)
  if (forwardNodes) {
    const result = await sendBody(account, chatId, { type: 'forward', text: '[合并转发]', nodes: forwardNodes }, target)
    const messageId = result.serverMessageId ?? ''
    const time = Date.now()
    return { messageId, time, rawData: result, message_id: messageId, messageTime: time }
  }

  let last: SendMessageResponse | undefined
  let text = ''
  let pendingReplyId = ''
  const ats: Array<{ uid: string, nickname?: string }> = []
  const flush = async (): Promise<void> => {
    const chunk = text.trim()
    text = ''
    if (!chunk) return
    if (pendingReplyId) {
      const referenced = pendingReplyId
      pendingReplyId = ''
      last = await sendReply(account, chatId, referenced, chunk, target)
      return
    }
    const mentions = ats.splice(0).filter(m => /^\d+$/.test(m.uid))
    last = await sendBody(account, chatId, {
      type: 'text',
      text: chunk,
      ...(mentions.length ? { ats: mentions } : {}),
    }, target)
  }

  for (const el of elements) {
    switch (el.type) {
      case 'text':
        text += el.text
        break
      case 'at':
        ats.push({ uid: el.targetId, nickname: el.name })
        break
      case 'face':
        text += `[表情:${el.id}]`
        break
      case 'reply':
        pendingReplyId = el.messageId
        break
      case 'image':
        await flush()
        last = await sendBody(account, chatId, { type: 'image', image: mediaSource(el.file) }, target)
        break
      case 'video':
        await flush()
        last = await sendBody(account, chatId, {
          type: 'video',
          video: { source: mediaSource(el.file), poster: POSTER_JPEG, width: el.width || 720, height: el.height || 1280 },
        }, target)
        break
      case 'record':
        text += '[语音]暂不支持'
        break
      case 'file':
        await flush()
        last = await sendBody(account, chatId, { type: 'file', file: { source: mediaSource(el.file), name: el.name } }, target)
        break
      default:
        break
    }
  }
  await flush()

  const messageId = last?.serverMessageId ?? ''
  const time = Date.now()
  return { messageId, time, rawData: last ?? [], message_id: messageId, messageTime: time }
}
