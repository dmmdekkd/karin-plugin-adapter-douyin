import { AdapterBase, registerBot, unregisterBot, logger, segment, contactFriend } from 'node-karin'
import type {
  AdapterType,
  Contact,
  SendElement,
  SendMsgResults,
  UserInfo,
  GroupInfo,
  GroupMemberInfo,
  MessageResponse,
  Role,
} from 'node-karin'
import fs from 'node:fs'
import path from 'node:path'
import { dir } from '@/dir'
import { requireFileSync } from 'node-karin'
import type { Config, DouyinAccount } from '@/types'
import { onConfigChange } from '@/utils/config'
import { createAccountManager } from '@/api/account'
import type { AccountManager } from '@/api/account'
import * as apiMessage from '@/api/message'
import * as apiContact from '@/api/contact'
import * as apiRequest from '@/api/request'
import type { ChatMessage, ConversationAddress } from '@/core/im'
import { dispatchMessage } from './message'
import { dispatchNotice } from './notice'
import { dispatchRequest } from './request'
import { sendKarinElements } from './send'
import { resolveAddress, loadForwardNodes } from './convert'
import { setupAutoRead } from './autoRead'
import { warmNickCache, locateSecUid, cachedNick, resolveNick, applyProfiles } from './nick'
import { fetchDesktopSelfProfile } from '@/core/auth'
import { fetchUserProfiles, cacheUserProfile, cachedAvatar as cachedUserProfileAvatar } from '@/api/profile'

/** 账号管理器单例 */
let manager: AccountManager | undefined

export function getAccountManager (): AccountManager {
  manager ??= createAccountManager()
  return manager
}

/** 抖音 CDN 头像尺寸替换：`~c5_168x168.webp` → `~c5_{size}x{size}`；size=0 或无尺寸段原样返回 */
function avatarBySize (url: string, size: 0 | 100 | 40 | 140): string {
  if (!url || !size) return url
  return url.replace(/(~c5_)\d+x\d+/, `$1${size}x${size}`)
}

/** 数字 faceId → 抖音表态键（resources/reactions.json，1-6 为官方回应面板） */
const REACTION_KEYS = loadReactionKeys()

function loadReactionKeys (): Record<string, string> {
  for (const base of [dir.defResourcesDir, path.join(dir.pluginDir, 'resources')]) {
    const file = path.join(base, 'reactions.json')
    if (fs.existsSync(file)) return requireFileSync(file) as Record<string, string>
  }
  return {}
}

/** 从 ChatMessage.content（JSON 字符串）提取纯文本摘要 */
function chatContentText (msg: ChatMessage): string {
  try {
    const parsed = JSON.parse(msg.content) as { text?: string }
    if (typeof parsed.text === 'string' && parsed.text) return parsed.text
  } catch {
    // 非 JSON 按原文返回
  }
  return msg.content
}

/** ChatMessage → karin MessageResponse（昵称取同步缓存，未命中由事件链路异步补） */
function toMessageResponse (contact: Contact, msg: ChatMessage): MessageResponse {
  return {
    time: msg.createTime,
    messageId: msg.msgId,
    messageSeq: Number(msg.indexInConversation ?? 0),
    contact,
    sender: { userId: msg.senderUid, nick: cachedNick(msg.senderUid), role: 'member' },
    elements: [segment.text(chatContentText(msg))],
  } as unknown as MessageResponse
}

/** 抖音群成员 role 数字 → karin Role */
function toKarinRole (role: number): Role {
  if (role === 1) return 'owner'
  if (role === 2) return 'admin'
  return 'member'
}

/** 抖音适配器（单账号实例） */
export class AdapterDouyin extends AdapterBase implements AdapterType<any> {
  constructor (public readonly ctx: DouyinAccount) {
    super()
    this.adapter.name = 'douyin'
    this.adapter.version = dir.pkg.version
    this.adapter.platform = 'douyin'
    this.adapter.standard = 'other'
    this.adapter.protocol = 'douyin'
    this.adapter.communication = 'webSocketClient'
    this.adapter.address = 'wss://frontier-msns.douyin.com/ws/v2'
    this.account.selfId = ctx.platformUid
    this.account.name = ctx.config.name ?? ''
    this.account.avatar = String(getAccountManager().store.load(ctx.platformUid)?.userData?.avatar_url ?? '')
  }

  /** 发送消息（karin 调用） */
  async sendMsg (contact: Contact, elements: Array<SendElement>): Promise<SendMsgResults> {
    return sendKarinElements(this.ctx, contact, elements)
  }

  /** 撤回消息 */
  async recallMsg (contact: Contact, messageId: string): Promise<void> {
    const address = await resolveAddress(this.ctx, contact)
    if (!address) throw new Error(`[douyin] 无法解析会话目标: ${contact.scene} ${contact.peer}`)
    const result = await apiMessage.recall(this.ctx.client, address, messageId)
    if (!result.recalled) logger.warn(`[douyin] 撤回失败: ${result.statusMsg}`)
  }

  /** 消息表情回应：faceId 1-6 为回应面板（爱心/大笑/惊讶/泪奔/赞/抱拳），文本表情键原样透传 */
  async setMsgReaction (contact: Contact, messageId: string, faceId: string | number, isSet: boolean): Promise<void> {
    const address = await resolveAddress(this.ctx, contact)
    if (!address) throw new Error(`[douyin] 无法解析会话目标: ${contact.scene} ${contact.peer}`)
    const key = String(faceId)
    const emoji = /^\d+$/.test(key) ? REACTION_KEYS[key] : key
    if (!emoji) throw new Error(`[douyin] 未知的表情回应 faceId: ${faceId}`)
    const result = await this.ctx.client.modifyReaction({
      ...address,
      serverMessageId: messageId,
      emoji,
      operatorUid: this.ctx.platformUid,
      enabled: isSet,
    })
    if (result.statusCode !== 0) logger.warn(`[douyin] 表情回应失败: statusCode=${result.statusCode} ${result.statusMsg}`)
  }

  /** 好友列表（昵称：线程 alias → IM user/info 批量回填） */
  async getFriendList (): Promise<Array<UserInfo>> {
    const list = await apiContact.getFriendList(this.ctx.client)
    await applyProfiles(this.ctx.http, list)
    return list.map(f => ({ userId: f.uid, nick: f.nickname || cachedNick(f.uid) } as UserInfo))
  }

  /** 用户昵称：缓存命中直接返回；未命中走解析链（好友/群成员/陌生人 → IM 资料接口） */
  async getNickname (userId: string): Promise<string> {
    if (userId === this.account.selfId) {
      const record = getAccountManager().store.load(this.account.selfId)
      return String(record?.screenName ?? record?.userData?.screen_name ?? '')
    }
    return resolveNick(this as unknown as AdapterDouyin, userId)
  }

  /** 用户头像：自身取登录资料；他人按 secUid 查 IM user/info。size 对齐官方 0|100|40|140 */
  async getAvatarUrl (userId: string, size?: 0 | 100 | 40 | 140): Promise<string> {
    const uid = userId || this.account.selfId
    const raw = uid === this.account.selfId
      ? await this.selfAvatarUrl()
      : await this.peerAvatarUrl(uid)
    return avatarBySize(raw, size ?? 0)
  }

  /** 自身头像：登录资料（mosaic 占位实时刷新） */
  private async selfAvatarUrl (): Promise<string> {
    const store = getAccountManager().store
    const record = store.load(this.account.selfId)
    const cached = String(record?.userData?.avatar_url ?? '')
    if (cached && !cached.includes('mosaic')) return cached
    const profile = await fetchDesktopSelfProfile(this.ctx.http).catch(() => undefined)
    const avatar = profile?.avatar ?? ''
    if (avatar && record) {
      store.save(this.account.selfId, {
        ...record,
        userData: { ...record.userData, avatar_url: avatar },
        updatedAt: new Date().toISOString(),
      })
    }
    return avatar || cached
  }

  /** 他人头像：定位 secUid 后批量资料接口取 avatar_thumb */
  private async peerAvatarUrl (uid: string): Promise<string> {
    const cachedAvatar = cachedUserProfileAvatar(uid)
    if (cachedAvatar) return cachedAvatar
    const secUid = await locateSecUid(this, uid)
    if (!secUid) return ''
    const profiles = await fetchUserProfiles(this.ctx.http, [secUid]).catch(() => undefined)
    const avatar = profiles?.get(secUid)?.avatar ?? ''
    if (avatar) cacheUserProfile(uid, { avatar })
    return avatar
  }

  /** 群列表 */
  async getGroupList (): Promise<Array<GroupInfo>> {
    const list = await apiContact.getGroupList(this.ctx.client)
    return list.map(g => ({
      groupId: g.conversationShortId || g.conversationId,
      groupName: g.name,
      memberCount: g.members.length,
      avatar: g.avatar ?? '',
    } as GroupInfo))
  }

  /** 群信息（从群列表匹配） */
  async getGroupInfo (groupId: string): Promise<GroupInfo> {
    const groups = await apiContact.getGroupList(this.ctx.client)
    const group = groups.find(
      g => g.conversationId === groupId || g.conversationShortId === groupId || g.name === groupId,
    )
    if (!group) throw new Error(`[douyin] 未找到群: ${groupId}`)
    return {
      groupId: group.conversationShortId || group.conversationId,
      groupName: group.name,
      memberCount: group.members.length,
      avatar: group.avatar ?? '',
    } as GroupInfo
  }

  /** 群头像 */
  async getGroupAvatarUrl (groupId: string): Promise<string> {
    const groups = await apiContact.getGroupList(this.ctx.client)
    const group = groups.find(
      g => g.conversationId === groupId || g.conversationShortId === groupId || g.name === groupId,
    )
    return group?.avatar ?? ''
  }

  /** 群成员列表（昵称：alias 常空，IM user/info 批量回填） */
  async getGroupMemberList (groupId: string): Promise<Array<GroupMemberInfo>> {
    const address = await apiContact.resolveGroupAddress(this.ctx.client, groupId)
    if (!address) throw new Error(`[douyin] 未找到群: ${groupId}`)
    const members = await apiContact.getGroupMembers(this.ctx.client, address)
    await applyProfiles(this.ctx.http, members)
    return members.map(m => ({
      userId: m.uid,
      nick: cachedNick(m.uid) || m.alias || m.uid,
      card: m.alias ?? '',
      role: toKarinRole(m.role),
      avatar: m.avatar ?? '',
    } as unknown as GroupMemberInfo))
  }

  /** 群成员信息 */
  async getGroupMemberInfo (groupId: string, targetId: string): Promise<GroupMemberInfo> {
    const list = await this.getGroupMemberList(groupId)
    const member = list.find(m => m.userId === targetId)
    if (!member) throw new Error(`[douyin] 群 ${groupId} 未找到成员: ${targetId}`)
    return member
  }

  /** 陌生人信息 */
  async getStrangerInfo (targetId: string): Promise<UserInfo> {
    const list = await apiContact.getStrangerList(this.ctx.client)
    const stranger = list.find(s => s.uid === targetId)
    if (!stranger) throw new Error(`[douyin] 未找到陌生人会话: ${targetId}`)
    return { userId: stranger.uid, nick: stranger.nickname ?? '' } as UserInfo
  }

  /** 获取单条消息（重载 A：仅消息 ID，抖音需会话上下文，不支持） */
  getMsg (messageId: string): Promise<MessageResponse>
  /** 获取单条消息（重载 B：会话 + 消息 ID，从最近历史查找） */
  getMsg (contact: Contact, messageId: string): Promise<MessageResponse>
  async getMsg (a: Contact | string, b?: string): Promise<MessageResponse> {
    if (typeof a === 'string') {
      throw new Error('[douyin] getMsg(messageId) 不支持，请提供会话 contact')
    }
    const address = await this.requireAddress(a)
    const history = await apiMessage.getHistory(this.ctx.client, address)
    const msg = b ? history.find(m => m.msgId === b) : history[history.length - 1]
    if (!msg) throw new Error(`[douyin] 未找到消息: ${b || '(最近)'}`)
    return toMessageResponse(a, msg)
  }

  /** 获取历史消息：start 为 indexInConversation 游标（或消息 ID），返回 ≤start 的 count 条（时间正序） */
  async getHistoryMsg (contact: Contact, start?: string | number | { seq?: string | number }, count?: number): Promise<Array<MessageResponse>> {
    const address = await this.requireAddress(contact)
    const limit = count || 1
    const anchor = typeof start === 'object' && start !== null ? start.seq : start
    let cursor = Number(anchor)
    if (!Number.isFinite(cursor) || cursor <= 0) {
      // start 是消息 ID：先在最近历史中定位其 indexInConversation 作为游标
      cursor = 0
      if (anchor) {
        const recent = await apiMessage.getHistory(this.ctx.client, address)
        const hit = recent.find(m => m.msgId === String(anchor))
        cursor = Number(hit?.indexInConversation ?? 0)
      }
    }
    const history = await apiMessage.getHistory(this.ctx.client, address, { cursor, count: limit })
    const sorted = [...history].sort((a, b) =>
      (Number(a.indexInConversation) || 0) - (Number(b.indexInConversation) || 0),
    )
    return sorted.slice(-limit).map(m => toMessageResponse(contact, m))
  }

  /** 获取账号 Cookie */
  async getCookies (): Promise<{ cookie: string }> {
    return { cookie: this.ctx.http.getCookies() }
  }

  /** 获取 QQ 相关接口凭证（抖音返回 cookie 与 passport csrf token） */
  async getCredentials (): Promise<{ cookies: string; csrf_token: number }> {
    const csrf = Number(this.ctx.http.jar.get('passport_csrf_token') ?? 0)
    return { cookies: this.ctx.http.getCookies(), csrf_token: Number.isFinite(csrf) ? csrf : 0 }
  }

  /** 获取 CSRF Token */
  async getCSRFToken (): Promise<{ token: number }> {
    const csrf = Number(this.ctx.http.jar.get('passport_csrf_token') ?? 0)
    return { token: Number.isFinite(csrf) ? csrf : 0 }
  }

  /** 解析 karin contact → 抖音会话地址 */
  private async requireAddress (contact: Contact): Promise<ConversationAddress> {
    const address = await resolveAddress(this.ctx, contact)
    if (!address) throw new Error(`[douyin] 无法解析会话目标: ${contact.scene} ${contact.peer}`)
    return address
  }

  /** 处理好友申请（flag = 申请者 uid） */
  async setFriendApplyResult (flag: string, isApprove: boolean): Promise<void> {
    if (isApprove) await apiRequest.approveFriend(this.ctx.client, flag)
    else await apiRequest.rejectFriend(this.ctx.client, flag)
  }

  /** 处理入群申请（flag = requestId） */
  async setGroupApplyResult (flag: string, isApprove: boolean): Promise<void> {
    if (isApprove) await apiRequest.approveGroupJoin(this.ctx.client, flag)
    else await apiRequest.rejectGroupJoin(this.ctx.client, flag)
  }

  /** 设置群名（cmd=902 set_conversation_core_info） */
  async setGroupName (groupId: string, groupName: string): Promise<void> {
    const address = await apiContact.resolveGroupAddress(this.ctx.client, groupId)
    if (!address) throw new Error(`[douyin] 未找到群: ${groupId}`)
    const result = await apiContact.setGroupName(this.ctx.client, address, groupName)
    if (result.statusCode !== 0) {
      throw new Error(`[douyin] 设置群名失败: ${result.statusMsg} (code=${result.statusCode})`)
    }
  }

  /** 邀请入群审批（抖音无独立接口） */ setInvitedJoinGroupResult (): never { return this.unsupported('setInvitedJoinGroupResult') }

  /** 打印不支持日志并抛错 */
  private unsupported (method: string): never {
    logger.error(`[douyin] 不支持的操作: ${method}（抖音平台无此能力）`)
    throw new Error(`[douyin] 抖音平台不支持: ${method}`)
  }

  /* ---- 以下为 karin 标准接口中抖音平台不支持的方法，调用时打印错误日志 ---- */

  /** 点赞 */ sendLike (): never { return this.unsupported('sendLike') }
  /** 戳一戳 */ pokeUser (): never { return this.unsupported('pokeUser') }
  /** 消息表情回应（别名） */ setMessageReaction (): never { return this.unsupported('setMessageReaction') }
  /** 合并转发资源（发送侧直接用 node 节点，无需预上传） */ createResId (): never { return this.unsupported('createResId') }
  /** 获取合并转发（resId = 合并转发消息 ID，取入站时缓存的节点） */
  async getForwardMsg (resId: string): Promise<Array<MessageResponse>> {
    const nodes = loadForwardNodes(resId)
    if (!nodes?.length) throw new Error(`[douyin] 未找到合并转发: ${resId}`)
    return nodes.map((node, index) => ({
      time: node.createTime ? Math.floor(node.createTime / 1000) : Math.floor(Date.now() / 1000),
      messageId: node.msgId,
      messageSeq: index + 1,
      contact: contactFriend(node.uid, node.nickname || undefined),
      sender: { userId: node.uid, nick: node.nickname, role: 'member' },
      elements: [segment.text(node.text)],
    } as MessageResponse))
  }
  /** 发送合并转发 */ sendForwardMsg (): never { return this.unsupported('sendForwardMsg') }
  /** 长消息 */ sendLongMsg (): never { return this.unsupported('sendLongMsg') }
  /** 踢人 */ groupKickMember (): never { return this.unsupported('groupKickMember') }
  /** 退群 */ setGroupQuit (): never { return this.unsupported('setGroupQuit') }
  /** 单人禁言 */ setGroupMute (): never { return this.unsupported('setGroupMute') }
  /** 单人禁言（别名） */ setGroupBan (): never { return this.unsupported('setGroupBan') }
  /** 全员禁言 */ setGroupAllMute (): never { return this.unsupported('setGroupAllMute') }
  /** 全员禁言（别名） */ setGroupWholeBan (): never { return this.unsupported('setGroupWholeBan') }
  /** 群名片 */ setGroupCard (): never { return this.unsupported('setGroupCard') }
  /** 群名片（别名） */ setGroupMemberCard (): never { return this.unsupported('setGroupMemberCard') }
  /** 群管理员 */ setGroupAdmin (): never { return this.unsupported('setGroupAdmin') }
  /** 成员头衔 */ setGroupMemberTitle (): never { return this.unsupported('setGroupMemberTitle') }
  /** 专属头衔 */ setGroupSpecialTitle (): never { return this.unsupported('setGroupSpecialTitle') }
  /** 群公告 */ setGroupNotice (): never { return this.unsupported('setGroupNotice') }
  /** 群公告（别名） */ sendGroupNotice (): never { return this.unsupported('sendGroupNotice') }
  /** 删除群公告 */ delGroupNotice (): never { return this.unsupported('delGroupNotice') }
  /** 加精华 */ setEssenceMsg (): never { return this.unsupported('setEssenceMsg') }
  /** 加精华（别名） */ setGroupHighlights (): never { return this.unsupported('setGroupHighlights') }
  /** 移除精华 */ deleteEssenceMsg (): never { return this.unsupported('deleteEssenceMsg') }
  /** 精华列表 */ getGroupHighlights (): never { return this.unsupported('getGroupHighlights') }
  /** 群头衔/群头像 */ setGroupPortrait (): never { return this.unsupported('setGroupPortrait') }
  /** 群备注 */ setGroupRemark (): never { return this.unsupported('setGroupRemark') }
  /** 群荣誉 */ getGroupHonor (): never { return this.unsupported('getGroupHonor') }
  /** 群荣誉（别名） */ getGroupHonorInfo (): never { return this.unsupported('getGroupHonorInfo') }
  /** 陌生群信息 */ getNotJoinedGroupInfo (): never { return this.unsupported('getNotJoinedGroupInfo') }
  /** 群禁言列表 */ getGroupMuteList (): never { return this.unsupported('getGroupMuteList') }
  /** @全体剩余次数 */ getGroupAtAllRemain (): never { return this.unsupported('getGroupAtAllRemain') }
  /** @全体次数（抖音桌面 IM 无 @全体能力） */ getAtAllCount (_groupId?: string): never { return this.unsupported('getAtAllCount') }
  /** 上传文件 */ uploadFile (): never { return this.unsupported('uploadFile') }
  /** 上传群文件 */ uploadGroupFile (): never { return this.unsupported('uploadGroupFile') }
  /** 上传私聊文件 */ uploadPrivateFile (): never { return this.unsupported('uploadPrivateFile') }
  /** 下载文件 */ downloadFile (): never { return this.unsupported('downloadFile') }
  /** 文件链接 */ getFileUrl (): never { return this.unsupported('getFileUrl') }
  /** 私聊文件链接 */ getPrivateFileUrl (): never { return this.unsupported('getPrivateFileUrl') }
  /** rkey */ getRkey (): never { return this.unsupported('getRkey') }
  /** 群文件列表 */ getGroupFileList (): never { return this.unsupported('getGroupFileList') }
  /** 群文件系统信息 */ getGroupFileSystemInfo (): never { return this.unsupported('getGroupFileSystemInfo') }
  /** 群文件链接 */ getGroupFileUrl (): never { return this.unsupported('getGroupFileUrl') }
  /** 根目录文件 */ getGroupRootFiles (): never { return this.unsupported('getGroupRootFiles') }
  /** 文件夹内文件 */ getGroupFilesByFolder (): never { return this.unsupported('getGroupFilesByFolder') }
  /** 建群文件夹 */ createGroupFileFolder (): never { return this.unsupported('createGroupFileFolder') }
  /** 建群文件夹（别名） */ createGroupFolder (): never { return this.unsupported('createGroupFolder') }
  /** 删群文件 */ deleteGroupFile (): never { return this.unsupported('deleteGroupFile') }
  /** 删群文件（别名） */ delGroupFile (): never { return this.unsupported('delGroupFile') }
  /** 删群文件夹 */ deleteGroupFolder (): never { return this.unsupported('deleteGroupFolder') }
  /** 删群文件夹（别名） */ delGroupFolder (): never { return this.unsupported('delGroupFolder') }
  /** 重命名群文件夹 */ renameGroupFolder (): never { return this.unsupported('renameGroupFolder') }
  /** 移动群文件 */ moveGroupFile (): never { return this.unsupported('moveGroupFile') }
  /** 修改头像 */ setAvatar (): never { return this.unsupported('setAvatar') }
  /** 修改头像（QQ 别名） */ setQqAvatar (): never { return this.unsupported('setQqAvatar') }
  /** 删除好友 */ deleteFriend (): never { return this.unsupported('deleteFriend') }
  /** 删除单向好友 */ deleteUnidirectionalFriend (): never { return this.unsupported('deleteUnidirectionalFriend') }
  /** 单向好友列表 */ getUnidirectionalFriendList (): never { return this.unsupported('getUnidirectionalFriendList') }
  /** 群签到 */ sendGroupSign (): never { return this.unsupported('sendGroupSign') }
  /** 群 AI 语音 */ sendGroupAiRecord (): never { return this.unsupported('sendGroupAiRecord') }
  /** AI 角色语音 */ sendAiCharacter (): never { return this.unsupported('sendAiCharacter') }
  /** AI 角色列表 */ getAiCharacters (): never { return this.unsupported('getAiCharacters') }
  /** OCR 图片 */ ocrImage (): never { return this.unsupported('ocrImage') }
  /** OCR 图片（别名） */ dotOcrImage (): never { return this.unsupported('dotOcrImage') }
  /** 获取图片 */ getImage (): never { return this.unsupported('getImage') }
  /** 获取语音 */ getRecord (): never { return this.unsupported('getRecord') }
  /** 分词 */ getWordSlices (): never { return this.unsupported('getWordSlices') }
  /** 自定义表情 */ fetchCustomFace (): never { return this.unsupported('fetchCustomFace') }
  /** 群系统消息 */ getGroupSystemMsg (): never { return this.unsupported('getGroupSystemMsg') }
  /** 修改头像（别名） */ setBotInfo (): never { return this.unsupported('setBotInfo') }
}

/** 已注册 bot 索引：platformUid → 适配器实例 */
const bots = new Map<string, AdapterDouyin>()

/** 注册单个账号为 karin bot：绑定事件、注册、启动 WS 接收 */
export async function createBot (ctx: DouyinAccount): Promise<AdapterDouyin> {
  // 重复登录/重复注册：先卸载旧实例
  const prev = bots.get(ctx.platformUid)
  if (prev) await destroyBot(prev)

  const bot = new AdapterDouyin(ctx)
  ctx.client.on('message', msg => dispatchMessage(bot, msg))
  ctx.client.on('notice', ev => dispatchNotice(bot, ev))
  ctx.client.on('request', ev => dispatchRequest(bot, ev))
  ctx.client.on('reconnecting', () => logger.debug(`[douyin][${ctx.platformUid}] WS 重连中`))
  ctx.client.on('close', () => logger.debug(`[douyin][${ctx.platformUid}] WS 连接关闭`))

  bots.set(ctx.platformUid, bot)
  bot.adapter.index = registerBot('webSocketClient', bot)
  void warmNickCache(bot)
  await ctx.client.start()
  logger.debug(`[douyin] 账号 ${ctx.platformUid}(${ctx.config.name || '未命名'}) 已上线`)
  return bot
}

/** 卸载 bot：断开连接并从 karin 注销 */
export async function destroyBot (bot: AdapterDouyin): Promise<void> {
  bots.delete(bot.ctx.platformUid)
  bot.ctx.client.stop()
  unregisterBot('selfId', bot.account.selfId)
  logger.debug(`[douyin] 账号 ${bot.ctx.platformUid} 已卸载`)
}

/** 账号下线：卸载 bot（保留本地会话，重启后自动恢复） */
export async function logoutBot (platformUid: string): Promise<void> {
  const bot = bots.get(platformUid)
  if (bot) await destroyBot(bot)
}

/** 当前在线的抖音 bot 列表 */
export function getBots (): AdapterDouyin[] {
  return [...bots.values()]
}

/**
 * @description 对比新旧配置中账号启用状态，变更时立即停用/启用对应 bot（配置立即生效）
 */
async function applyAccountEnable (oldCfg: Config, newCfg: Config): Promise<void> {
  const m = getAccountManager()
  const oldMap = new Map((oldCfg.accounts || []).map(a => [a.name ?? '', a.enable !== false]))
  const newMap = new Map((newCfg.accounts || []).map(a => [a.name ?? '', a.enable !== false]))
  for (const [name, enable] of newMap) {
    if (!name || oldMap.get(name) === enable) continue
    if (enable) {
      // 已在线的账号（如扫码登录刚创建）无需重建，仅确保管理器持有
      if (getBots().some(b => b.ctx.config.name === name)) {
        await m.applyEnable(name, true)
        continue
      }
      const acc = await m.applyEnable(name, true)
      if (acc) {
        await createBot(acc).catch(err => logger.error(
          `[douyin] 启用账号失败 ${name}: ${err instanceof Error ? err.message : String(err)}`,
        ))
      }
    } else {
      const bot = getBots().find(b => b.ctx.config.name === name)
      if (bot) await destroyBot(bot)
      await m.applyEnable(name, false)
    }
  }
}

/**
 * @description 注册配置变更监听：账号启用/停用保存后立即生效（幂等）
 * @remarks autoReadOnMatch 每次消息实时读取配置，本身即热生效，无需处理
 */
export function setupConfigHotApply (): void {
  onConfigChange((oldCfg, nowCfg) => {
    void applyAccountEnable(oldCfg, nowCfg)
  })
}

/** 启动适配器：恢复配置中启用的账号并注册 */
export async function initAdapter (): Promise<void> {
  setupAutoRead()
  setupConfigHotApply()
  const m = getAccountManager()
  await m.restore()
  await Promise.all([...m.accounts.values()].map(ctx => createBot(ctx)))
}

export { loginByQr } from './login'
