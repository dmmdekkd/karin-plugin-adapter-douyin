import {
  AdapterBase, registerBot, unregisterBot, logger, segment, requireFileSync,
  contactFriend, contactGroup,
  senderFriend, senderGroup,
  createFriendMessage, createGroupMessage,
  createFriendIncreaseNotice, createFriendDecreaseNotice,
  createPrivateRecallNotice, createGroupRecallNotice,
  createGroupMemberAddNotice, createGroupMemberDelNotice,
  createGroupAdminChangedNotice, createGroupMessageReactionNotice,
  createPrivateApplyRequest, createGroupApplyRequest,
  hooks,
} from 'node-karin'
import type {
  Contact, Elements, SendElement, SendMsgResults, UserInfo, GroupInfo, GroupMemberInfo, MessageResponse,
} from 'node-karin'
import fs from 'node:fs'
import path from 'node:path'
import { dir } from '@/dir'
import type { Config, DouyinAccount } from '@/types'
import { config, onConfigChange } from '@/utils/config'
import { createAccountManager } from '@/api/account'
import type { AccountManager } from '@/api/account'
import type { LoginOptions } from '@/api/account'
import { chatIdOf } from 'douyin.ts'
import type { BotMessage, ChatMessage, MediaInput, NoticeEvent, RequestEvent, StatusEvent } from 'douyin.ts'
import { makeMsg, toElements, loadForwardNodes, rememberReply } from './convert'
import { mountMediaRoute } from './media'
import { rememberChat, resolveChatId, cachedSecUid, rememberSecUid, refreshContacts, loadContactCache } from './contact'
import { parsePeerFromConversationId } from '@/utils/im'

/** 账号管理器单例 */
let manager: AccountManager | undefined

export function getAccountManager (): AccountManager {
  manager ??= createAccountManager()
  return manager
}

/** ChatMessage → karin MessageResponse（昵称异步查询） */
async function toMessageResponse (ctx: DouyinAccount, contact: Contact, msg: ChatMessage): Promise<MessageResponse> {
  const nick = (await ctx.bot.nickOf(msg.senderUid)) ?? ''
  return {
    time: msg.createTime,
    messageId: msg.msgId,
    messageSeq: Number(msg.indexInConversation ?? 0),
    contact,
    sender: { userId: msg.senderUid, nick, name: nick, role: 'member' },
    elements: toElements(msg.content, msg.msgType, msg.msgId, ctx.platformUid),
  }
}

/** 抖音适配器（单账号实例） */
export class AdapterDouyin extends AdapterBase {
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
    return makeMsg(this.ctx, contact, elements)
  }

  /** 撤回消息 */
  async recallMsg (contact: Contact, messageId: string): Promise<void> {
    const chatId = await this.requireChatId(contact)
    const result = await this.ctx.bot.msg.recall(chatId, messageId)
    if (!result.recalled) logger.warn(`[douyin] 撤回失败: ${result.statusMsg}`)
  }

  /** 消息表情回应：faceId 1-6 为回应面板（爱心/大笑/惊讶/泪奔/赞/抱拳），文本表情键原样透传 */
  async setMsgReaction (contact: Contact, messageId: string, faceId: string | number, isSet: boolean): Promise<void> {
    const chatId = await this.requireChatId(contact)
    const key = String(faceId)
    let emoji = ''
    if (/^\d+$/.test(key)) {
      for (const base of [dir.defResourcesDir, path.join(dir.pluginDir, 'resources')]) {
        const file = path.join(base, 'reactions.json')
        if (!fs.existsSync(file)) continue
        emoji = (requireFileSync(file) as Record<string, string>)[key] ?? ''
        break
      }
    } else {
      emoji = key
    }
    if (!emoji) throw new Error(`[douyin] 未知的表情回应 faceId: ${faceId}`)
    const result = await this.ctx.bot.msg.react(chatId, messageId, emoji, isSet)
    if (result.statusCode !== 0) logger.warn(`[douyin] 表情回应失败: statusCode=${result.statusCode} ${result.statusMsg}`)
  }

  /** 好友列表（同时回填 secUid，供头像查询复用） */
  async getFriendList (): Promise<Array<UserInfo>> {
    const list = await this.ctx.bot.frd.list()
    for (const f of list) rememberSecUid(f.uid, f.secUid)
    return list.map(f => ({ userId: f.uid, nick: f.nickname } as UserInfo))
  }

  /** 用户昵称：自身取登录资料，他人走 SDK 昵称接口 */
  async getNickname (userId: string): Promise<string> {
    if (userId === this.account.selfId) {
      return (await this.ctx.bot.user.self()).nickname ?? ''
    }
    return (await this.ctx.bot.nickOf(userId)) ?? ''
  }

  /** 用户头像：自身取登录资料；他人按 secUid 查对话场景资料。size 对齐官方 0|100|40|140 */
  async getAvatarUrl (userId: string, size?: 0 | 100 | 40 | 140): Promise<string> {
    const uid = userId || this.account.selfId
    const raw = uid === this.account.selfId
      ? (await this.ctx.bot.user.self()).avatar ?? ''
      : await this.peerAvatarUrl(uid)
    // 抖音 CDN 头像尺寸替换：`~c5_168x168.webp` → `~c5_{size}x{size}`；size=0 或无尺寸段原样返回
    const s = size ?? 0
    return raw && s ? raw.replace(/(~c5_)\d+x\d+/, `$1${s}x${s}`) : raw
  }

  /** 他人头像：按缓存 secUid 查对话场景资料 */
  private async peerAvatarUrl (uid: string): Promise<string> {
    const secUid = cachedSecUid(uid)
    if (!secUid) return ''
    const profile = await this.ctx.bot.user.profileScene(secUid).catch(() => undefined)
    return profile?.avatar ?? ''
  }

  /** 群列表（同时回填成员 secUid） */
  async getGroupList (): Promise<Array<GroupInfo>> {
    const list = await this.ctx.bot.grp.list()
    for (const member of list.flatMap(g => g.members)) rememberSecUid(member.uid, member.secUid)
    return list.map(g => ({
      groupId: g.conversationShortId || g.conversationId,
      groupName: g.name,
      memberCount: g.members.length,
      avatar: g.avatar ?? '',
    } as GroupInfo))
  }

  /** 群信息（从群列表匹配） */
  async getGroupInfo (groupId: string): Promise<GroupInfo> {
    const group = (await this.ctx.bot.grp.list()).find(
      g => g.conversationId === groupId || g.conversationShortId === groupId || g.name === groupId
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
    const group = (await this.ctx.bot.grp.list()).find(
      g => g.conversationId === groupId || g.conversationShortId === groupId || g.name === groupId
    )
    return group?.avatar ?? ''
  }

  /** 群成员列表（secUid 回填供资料查询） */
  async getGroupMemberList (groupId: string): Promise<Array<GroupMemberInfo>> {
    const chatId = await this.requireChatId({ scene: 'group', peer: groupId, name: '' })
    const members = await this.ctx.bot.grp.members(chatId)
    for (const m of members) rememberSecUid(m.uid, m.secUid)
    return members.map(m => ({
      userId: m.uid,
      nick: m.nickname || m.alias || m.uid,
      card: m.alias ?? '',
      // 抖音群成员 role 数字 → karin Role
      role: m.role === 1 ? 'owner' : m.role === 2 ? 'admin' : 'member',
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
    const list = await this.ctx.bot.chat.strangers()
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
    const chatId = await this.requireChatId(a)
    const history = await this.ctx.bot.chat.history(chatId)
    const msg = b ? history.find(m => m.msgId === b) : history[history.length - 1]
    if (!msg) throw new Error(`[douyin] 未找到消息: ${b || '(最近)'}`)
    return toMessageResponse(this.ctx, a, msg)
  }

  /** 获取历史消息：start 为 indexInConversation 游标（或消息 ID），返回 ≤start 的 count 条（时间正序） */
  async getHistoryMsg (contact: Contact, start?: string | number | { seq?: string | number }, count?: number): Promise<Array<MessageResponse>> {
    const chatId = await this.requireChatId(contact)
    const limit = count || 1
    const anchor = typeof start === 'object' && start !== null ? start.seq : start
    let cursor = Number(anchor)
    if (!Number.isFinite(cursor) || cursor <= 0) {
      // start 是消息 ID：先在最近历史中定位其 indexInConversation 作为游标
      cursor = 0
      if (anchor) {
        const recent = await this.ctx.bot.chat.history(chatId)
        cursor = Number(recent.find(m => m.msgId === String(anchor))?.indexInConversation ?? 0)
      }
    }
    const history = await this.ctx.bot.chat.history(chatId, { cursor, count: limit })
    const sorted = [...history].sort((a, b) =>
      (Number(a.indexInConversation) || 0) - (Number(b.indexInConversation) || 0)
    )
    return Promise.all(sorted.slice(-limit).map(m => toMessageResponse(this.ctx, contact, m)))
  }

  /** 抖音 HTTP 通道（douyin.ts Bot 内部实例） */
  private get http () {
    return this.ctx.bot.http()
  }

  /** 获取账号 Cookie */
  async getCookies (): Promise<{ cookie: string }> {
    return { cookie: this.http.jar.header() }
  }

  /** 获取 QQ 相关接口凭证（抖音返回 cookie 与 passport csrf token） */
  async getCredentials (): Promise<{ cookies: string; csrf_token: number }> {
    const csrf = Number(this.http.jar.get('passport_csrf_token') ?? 0)
    return { cookies: this.http.jar.header(), csrf_token: Number.isFinite(csrf) ? csrf : 0 }
  }

  /** 获取 CSRF Token */
  async getCSRFToken (): Promise<{ token: number }> {
    const csrf = Number(this.http.jar.get('passport_csrf_token') ?? 0)
    return { token: Number.isFinite(csrf) ? csrf : 0 }
  }

  /** 解析 karin contact → 抖音 chatId（缓存未命中查好友/群列表） */
  private async requireChatId (contact: Contact): Promise<string> {
    const chatId = await resolveChatId(this.ctx, contact)
    if (!chatId) throw new Error(`[douyin] 无法解析会话目标: ${contact.scene} ${contact.peer}`)
    return chatId
  }

  /** 处理好友申请（flag = 申请者 uid） */
  async setFriendApplyResult (flag: string, isApprove: boolean): Promise<void> {
    if (isApprove) await this.ctx.bot.frd.approve(flag)
    else await this.ctx.bot.frd.reject(flag)
  }

  /** 处理入群申请（flag = requestId） */
  async setGroupApplyResult (flag: string, isApprove: boolean): Promise<void> {
    if (isApprove) await this.ctx.bot.grp.approve(flag)
    else await this.ctx.bot.grp.reject(flag)
  }

  /** 设置群名（cmd=902 set_conversation_core_info） */
  async setGroupName (groupId: string, groupName: string): Promise<void> {
    const chatId = await this.requireChatId({ scene: 'group', peer: groupId, name: '' })
    const result = await this.ctx.bot.grp.rename(chatId, groupName)
    if (result.statusCode !== 0) {
      throw new Error(`[douyin] 设置群名失败: ${result.statusMsg} (code=${result.statusCode})`)
    }
  }

  /** 群踢人（SDK 成员移除；rejectAddRequest/kickReason 抖音无对等入参，忽略） */
  async groupKickMember (groupId: string, targetId: string): Promise<void> {
    const chatId = await this.requireChatId({ scene: 'group', peer: groupId, name: '' })
    const result = await this.ctx.bot.grp.removeMembers(chatId, [targetId])
    if (result.statusCode !== 0) {
      throw new Error(`[douyin] 群踢人失败: ${result.statusMsg} (code=${result.statusCode})`)
    }
  }

  /** 退出群聊（抖音 Leave 无解散/退出之分，isDismiss 忽略） */
  async setGroupQuit (groupId: string, _isDismiss: boolean): Promise<void> {
    const chatId = await this.requireChatId({ scene: 'group', peer: groupId, name: '' })
    const result = await this.ctx.bot.grp.leave(chatId)
    if (result.statusCode !== 0) {
      throw new Error(`[douyin] 退群失败: ${result.statusMsg} (code=${result.statusCode})`)
    }
  }

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

  /** 抖音入站消息 → karin 消息事件（bind 已补 chatId/senderNickname/视频直链） */
  makeMessage (msg: BotMessage): void {
    try {
      // 空文本推送（如 aweType=133 系统引导模板）无内容价值，不分发
      if (msg.type === 'text' && !msg.text) return

      rememberChat(this.ctx.bot, msg)
      rememberReply(this.ctx, msg)
      const messageId = msg.serverMessageId || `${msg.cmd}-${msg.indexInConversationV2 ?? msg.indexInConversation ?? Date.now()}`
      const elements = toElements(msg.content, msg.messageType, messageId, this.ctx.platformUid, msg.reference)
      const seq = Number(msg.indexInConversationV2 || msg.indexInConversation || msg.serverMessageId || 0) ||
        Math.floor(Date.now() / 1000)
      const time = Number(msg.createTime) > 0 ? Math.floor(Number(msg.createTime) / 1000) : Math.floor(Date.now() / 1000)
      const nick = msg.senderNickname

      if (msg.conversationType === 2) {
        const peer = msg.conversationShortId || msg.conversationId
        const contact = contactGroup(peer)
        createGroupMessage({
          bot: this,
          contact,
          elements,
          eventId: messageId,
          messageId,
          messageSeq: seq,
          rawEvent: msg.raw,
          sender: senderGroup(msg.senderUid, 'member', nick),
          time,
          srcReply: elems => this.sendMsg(contact, elems),
        })
      } else {
        const peer = parsePeerFromConversationId(msg.conversationId, this.ctx.platformUid) || msg.senderUid
        const contact = contactFriend(peer, nick)
        createFriendMessage({
          bot: this,
          contact,
          elements,
          eventId: messageId,
          messageId,
          messageSeq: seq,
          rawEvent: msg.raw,
          sender: senderFriend(msg.senderUid, nick),
          time,
          srcReply: elems => this.sendMsg(contact, elems),
        })
      }
    } catch (err) {
      logger.error('[douyin] 处理入站消息失败:', err)
    }
  }

  /** 抖音通知事件 → karin 通知事件 */
  makeNotice (ev: NoticeEvent): void {
    try {
      switch (ev.type) {
        case 'message.reaction': {
          const faceId = emojiToFaceId(ev.emoji)
          logger.info(
            `[douyin] 表情回应: msgId=${ev.serverMessageId} emoji=${ev.emoji} ` +
            `operator=${ev.operatorUid} isSet=${ev.isSet}`
          )
          // karin 仅提供群 reaction 事件类型（会话 0:2:*）；私聊回应仅日志
          if (!ev.conversationId.startsWith('0:2:')) return
          const contact = contactGroup(ev.conversationId.split(':')[2] || ev.conversationId)
          createGroupMessageReactionNotice({
            ...common(this, ev.raw),
            contact,
            sender: senderGroup(ev.operatorUid, 'member'),
            srcReply: elems => this.sendMsg(contact, elems),
            content: { messageId: ev.serverMessageId, faceId, count: 1, isSet: ev.isSet },
          })
          return
        }
        case 'friend.increase':
        case 'friend.decrease': {
          const contact = contactFriend(ev.peerUid)
          const base = {
            ...common(this, ev.raw),
            contact,
            sender: senderFriend(ev.peerUid),
            srcReply: (elems: Elements[]) => this.sendMsg(contact, elems),
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
          const operatorId = ev.recallUid ?? ''
          if (ev.conversationType === 2) {
            const contact = contactGroup(ev.conversationId.split(':')[2] || ev.conversationId)
            createGroupRecallNotice({
              ...common(this, ev.raw),
              contact,
              sender: senderGroup(operatorId, 'member'),
              srcReply: elems => this.sendMsg(contact, elems),
              content: { operatorId, targetId: operatorId, messageId, tip: '' },
            })
          } else {
            const peer = parsePeerFromConversationId(ev.conversationId, this.selfId) || ev.conversationId
            const contact = contactFriend(peer)
            createPrivateRecallNotice({
              ...common(this, ev.raw),
              contact,
              sender: senderFriend(peer),
              srcReply: elems => this.sendMsg(contact, elems),
              content: { operatorId: peer, messageId, tips: '' },
            })
          }
          break
        }

        case 'group.member-increase': {
          const contact = contactGroup(ev.conversationShortId || ev.conversationId)
          const base = {
            ...common(this, ev.raw),
            contact,
            srcReply: (elems: Elements[]) => this.sendMsg(contact, elems),
          }
          for (const member of ev.members) {
            // 登记去重：status 补漏通道会检查此 key，避免同一变更双发
            claimMemberChange(`${groupPeerOf(ev.conversationId)}:${member.uid}:increase`)
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
            ...common(this, ev.raw),
            contact,
            srcReply: (elems: Elements[]) => this.sendMsg(contact, elems),
          }
          for (const member of ev.members) {
            // 登记去重：status 补漏通道会检查此 key，避免同一变更双发
            claimMemberChange(`${groupPeerOf(ev.conversationId)}:${member.uid}:decrease`)
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
            ...common(this, ev.raw),
            contact,
            srcReply: (elems: Elements[]) => this.sendMsg(contact, elems),
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

        case 'conversation.typing':
          // karin 无输入状态通知，仅记日志（周期上报，用 debug 防刷屏）
          logger.debug(`[douyin] 输入状态: ${ev.peerUid} typing=${ev.typing}`)
          return

        case 'group.name-change':
          logger.info(`[douyin] 群名变更: ${ev.conversationShortId} 新名=${ev.name ?? '(未知)'}`)
          return

        case 'group.avatar-change':
          logger.info(`[douyin] 群头像变更: ${ev.conversationShortId}`)
          return

        default:
          logger.debug('[douyin] 未处理通知:', ev.type)
      }
    } catch (err) {
      logger.error('[douyin] 处理通知事件失败:', err)
    }
  }

  /** 会话状态事件 → karin 通知事件（补漏：部分群成员增减服务端仅下发 status，无系统消息） */
  makeStatus (ev: StatusEvent): void {
    try {
      // 仅群成员变更（commandType=7）补漏，其余状态同步维持 debug 日志
      if (ev.commandType !== 7) {
        logger.debug(`[douyin][${this.ctx.platformUid}] 会话状态变更: ${ev.conversationId} cmd=${ev.commandType}`)
        return
      }
      const change = ev.memberChange
      if (!change) return
      const peer = groupPeerOf(ev.conversationId)
      const contact = contactGroup(peer)
      const base = {
        ...common(this, ev.raw),
        contact,
        srcReply: (elems: Elements[]) => this.sendMsg(contact, elems),
      }
      for (const uid of change.added ?? []) {
        if (isSelfUid(this.ctx.platformUid, uid)) {
          logger.info(`[douyin] 机器人加入群聊: ${peer}`)
          continue
        }
        // notice 通道已派发过的（2 分钟内）跳过，避免重复
        if (!claimMemberChange(`${peer}:${uid}:increase`)) continue
        createGroupMemberAddNotice({
          ...base,
          sender: senderGroup(uid, 'member'),
          content: { operatorId: '', targetId: uid, type: 'invite' },
        })
      }
      for (const uid of change.removed ?? []) {
        if (isSelfUid(this.ctx.platformUid, uid)) {
          logger.info(`[douyin] 机器人退出群聊: ${peer}`)
          continue
        }
        if (!claimMemberChange(`${peer}:${uid}:decrease`)) continue
        createGroupMemberDelNotice({
          ...base,
          sender: senderGroup(uid, 'member'),
          content: { operatorId: '', targetId: uid, type: 'leave' },
        })
      }
    } catch (err) {
      logger.error('[douyin] 处理会话状态事件失败:', err)
    }
  }

  /**
   * @description SDK 独有能力透传（karin 无标准接口的方法，插件可通过 e.bot.xxx 直接调用）
   * @remarks 方法与参考插件挂载面对齐；无返回值的签名由 SDK 类型推导
   */
  sendTyping (chatId: string, typing = true) {
    return this.ctx.bot.msg.sendTyping(chatId, typing)
  }

  addGroupMembers (chatId: string, uids: string[]) {
    return this.ctx.bot.grp.addMembers(chatId, uids)
  }

  getGroupRequests (chatId?: string) {
    return this.ctx.bot.grp.requests(chatId)
  }

  createGroup (options: { participantUids: string[], name?: string, description?: string }) {
    return this.ctx.bot.grp.create(options)
  }

  getChatInfo (chatId: string) {
    return this.ctx.bot.chat.info(chatId)
  }

  deleteChat (chatId: string) {
    return this.ctx.bot.chat.delete(chatId)
  }

  setChatSetting (chatId: string, input: { setStickOnTop?: boolean, setMute?: boolean, setFavorite?: boolean }) {
    return this.ctx.bot.chat.setting(chatId, input)
  }

  readSwitch (chatId: string, msgs: BotMessage[]) {
    return this.ctx.bot.chat.readSwitch(chatId, msgs)
  }

  getReadIndex (chatId: string) {
    return this.ctx.bot.chat.readIndex(chatId)
  }

  getMinIndex (chatId: string) {
    return this.ctx.bot.chat.minIndex(chatId)
  }

  getStrangers () {
    return this.ctx.bot.chat.strangers()
  }

  getStrangerConversations () {
    return this.ctx.bot.chat.strangerConversations()
  }

  getOnlineStatus (secUserIds: string[], source?: string) {
    return this.ctx.bot.user.onlineStatus(secUserIds, source)
  }

  heartbeat () {
    return this.ctx.bot.user.heartbeat()
  }

  activeSwitch () {
    return this.ctx.bot.user.activeSwitch()
  }

  getEmojiList () {
    return this.ctx.bot.media.emojiList()
  }

  getVideoUrl (tkey: string) {
    return this.ctx.bot.media.videoUrl(tkey)
  }

  uploadImage (input: MediaInput) {
    return this.ctx.bot.media.image(input)
  }

  uploadVideo (input: MediaInput) {
    return this.ctx.bot.media.video(input)
  }

  uploadMedia (input: MediaInput, name?: string) {
    return this.ctx.bot.media.file(input, name)
  }

  getAwemeDetail (awemeIds: string[], options?: { originType?: string, requestSource?: number, conversationShortId?: string }) {
    return this.ctx.bot.media.awemeDetail(awemeIds, options)
  }

  /** 抖音请求事件 → karin 请求事件 */
  async makeRequest (ev: RequestEvent): Promise<void> {
    try {
      if (ev.type === 'friend.request') {
        const contact = contactFriend(ev.applicantUid)
        createPrivateApplyRequest({
          bot: this,
          subEvent: 'friendApply',
          contact,
          sender: senderFriend(ev.applicantUid),
          eventId: `douyin-friend-request-${ev.applicantUid}-${Date.now()}`,
          rawEvent: ev.raw,
          time: Math.floor(Date.now() / 1000),
          srcReply: elems => this.sendMsg(contact, elems),
          content: { applierId: ev.applicantUid, message: ev.content ?? '', flag: ev.applicantUid },
        })
        return
      }

      // group.join-request：推送不含申请人信息，拉取审核列表补全后再派发
      const chatId = chatIdOf({
        conversationId: ev.conversationId,
        conversationShortId: ev.conversationShortId,
        conversationType: ev.conversationType,
      })
      const list = await this.ctx.bot.grp.requests(chatId)
      // 审核状态 1=待处理（SDK 枚举未导出，按字面量）
      const pending = ev.requestId
        ? list.find(r => r.requestId === ev.requestId)
        : list.find(r => r.status === 1)
      if (!pending) {
        logger.debug('[douyin] 入群申请审核列表未命中，忽略')
        return
      }

      const contact = contactGroup(ev.conversationShortId || ev.conversationId)
      createGroupApplyRequest({
        bot: this,
        subEvent: 'groupApply',
        contact,
        sender: senderGroup(pending.applicantUid, 'member'),
        eventId: `douyin-group-request-${pending.requestId}-${Date.now()}`,
        rawEvent: ev.raw,
        time: Math.floor(Date.now() / 1000),
        srcReply: elems => this.sendMsg(contact, elems),
        content: {
          applierId: pending.applicantUid,
          inviterId: pending.inviterUid ?? '',
          reason: pending.reason ?? ev.content ?? '',
          flag: pending.requestId,
          groupId: ev.conversationShortId || ev.conversationId,
        },
      })
    } catch (err) {
      logger.error('[douyin] 处理请求事件失败:', err)
    }
  }
}

/** 当前秒级时间戳 */
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

/** 群成员变更去重表：`${群id}:${uid}:${增加|减少}` → 派发时间戳（status 与 notice 双通道会各自下发同一变更） */
const memberSeen = new Map<string, number>()
/** 记录并返回是否为窗口期内首次（2 分钟内视为同一变更已派发过，仅 status 通道在派发前检查） */
function claimMemberChange (key: string): boolean {
  const seen = memberSeen.get(key)
  if (seen && Date.now() - seen < 120000) return false
  memberSeen.set(key, Date.now())
  // 防无限增长：超过 500 条时清空（与参考插件同策略）
  if (memberSeen.size > 500) memberSeen.clear()
  return true
}

/** 群会话 ID（`0:2:{群id}`）→ 群 id；status 的 conversationId 可能为纯群 id，原样兜底 */
function groupPeerOf (conversationId: string): string {
  return conversationId.startsWith('0:2:') ? conversationId.slice(4) : conversationId
}

/** bot 自身 uid 判定：SDK 大数无精度保护，尾部可能截 0，前 15 位比对兜底 */
function isSelfUid (selfUid: string, uid: string): boolean {
  return uid === selfUid || (uid.length === selfUid.length && uid.slice(0, 15) === selfUid.slice(0, 15))
}

/** karin 标准接口中抖音平台不支持的方法名（按名称批量绑定报错 stub，对齐参考插件简洁写法） */
const UNSUPPORTED = [
  'setInvitedJoinGroupResult', 'sendLike', 'pokeUser', 'createResId',
  'sendForwardMsg', 'sendLongMsg',
  'setGroupMute', 'setGroupAllMute', 'setGroupCard', 'setGroupAdmin',
  'setGroupMemberTitle', 'setGroupSpecialTitle', 'setGroupNotice', 'delGroupNotice',
  'setEssenceMsg', 'deleteEssenceMsg', 'getGroupHighlights', 'setGroupPortrait',
  'setGroupRemark', 'getGroupHonor', 'getNotJoinedGroupInfo', 'getGroupMuteList',
  'getGroupAtAllRemain', 'getAtAllCount',
  'uploadFile', 'uploadGroupFile', 'uploadPrivateFile', 'downloadFile', 'getFileUrl',
  'getPrivateFileUrl', 'getRkey', 'getGroupFileList', 'getGroupFileSystemInfo',
  'getGroupFileUrl', 'getGroupRootFiles', 'getGroupFilesByFolder', 'createGroupFileFolder',
  'deleteGroupFile', 'deleteGroupFolder', 'renameGroupFolder', 'moveGroupFile',
  'setAvatar', 'deleteFriend', 'deleteUnidirectionalFriend', 'getUnidirectionalFriendList',
  'sendGroupSign', 'sendGroupAiRecord', 'sendAiCharacter', 'getAiCharacters',
  'ocrImage', 'getImage', 'getRecord', 'getWordSlices', 'fetchCustomFace', 'getGroupSystemMsg',
] as const

/** 打印不支持日志并抛错（模块级函数，供批量绑定 stub 调用） */
function unsupported (method: string): never {
  logger.error(`[douyin] 不支持的操作: ${method}（抖音平台无此能力）`)
  throw new Error(`[douyin] 抖音平台不支持: ${method}`)
}

// 批量绑定不支持的接口方法（不再逐个手写 stub）
// writable/configurable 必须为 true：node-karin registerBot 会对 sendMsg/sendForwardMsg 等做钩子包装赋值，
// 若为只读属性会抛 "Cannot assign to read only property" 导致注册失败
for (const name of UNSUPPORTED) {
  Object.defineProperty(AdapterDouyin.prototype, name, {
    value: (): never => unsupported(name),
    writable: true,
    configurable: true,
  })
}

/** 已注册 bot 索引：platformUid → 适配器实例 */
const bots = new Map<string, AdapterDouyin>()
/** 主动停用的账号：关闭连接时不再提示重连（SDK stop 同样会触发 close 事件） */
const manualStop = new Set<string>()
/** 好友/群列表防漂移刷新定时器：platformUid → timer */
const refreshTimers = new Map<string, NodeJS.Timeout>()

/** 启动 30 分钟好友/群列表周期刷新（防群名/成员漂移），断线期间失败仅告警一次 */
function startRefreshTimer (ctx: DouyinAccount): void {
  stopRefreshTimer(ctx.platformUid)
  const timer = setInterval(() => {
    refreshContacts(ctx).catch(err => logger.warn(
      `[douyin][${ctx.platformUid}] 联系人列表刷新失败: ${err instanceof Error ? err.message : String(err)}`
    ))
  }, 30 * 60 * 1000)
  refreshTimers.set(ctx.platformUid, timer)
}

/** 停止账号的周期刷新定时器 */
function stopRefreshTimer (uid: string): void {
  const timer = refreshTimers.get(uid)
  if (timer) clearInterval(timer)
  refreshTimers.delete(uid)
}

let autoReadRegistered = false

/** 注册「匹配到相应插件自动已读」全局钩子（幂等，仅注册一次；不阻塞插件执行） */
function setupAutoRead (): void {
  if (autoReadRegistered) return
  autoReadRegistered = true
  hooks.eventCall((e, _plugin, next) => {
    if (e.event === 'message' && config().autoReadOnMatch) {
      const bot = e.bot as unknown as AdapterDouyin | undefined
      if (bot?.ctx?.bot) autoReadConversation(bot, e.contact)
    }
    next()
  }, { priority: 100 })
}

/** 自动已读单个会话：解析 chatId 后调用 SDK 已读接口（失败仅 debug） */
async function autoReadConversation (bot: AdapterDouyin, contact: Contact): Promise<void> {
  try {
    const chatId = await resolveChatId(bot.ctx, contact)
    if (!chatId) return
    const result = await bot.ctx.bot.msg.read(chatId)
    if (result.statusCode !== 0) {
      logger.warn(`[douyin] 自动已读失败: statusCode=${result.statusCode} ${result.statusMsg}`)
    }
  } catch (err) {
    logger.debug(`[douyin] 自动已读异常: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 注册单个账号为 karin bot：绑定事件、注册、启动 WS 接收 */
export async function createBot (ctx: DouyinAccount): Promise<AdapterDouyin> {
  // 重复登录/重复注册：先卸载旧实例
  const prev = bots.get(ctx.platformUid)
  if (prev) await destroyBot(prev)

  const bot = new AdapterDouyin(ctx)
  ctx.bot.on('message', msg => bot.makeMessage(msg))
  ctx.bot.on('message:edited', msg => bot.makeMessage(msg))
  ctx.bot.on('notice', ev => bot.makeNotice(ev))
  ctx.bot.on('request', ev => bot.makeRequest(ev))
  ctx.bot.on('read', ev => logger.debug(`[douyin][${ctx.platformUid}] 已读回执: ${ev.conversationId}`))
  ctx.bot.on('status', ev => bot.makeStatus(ev))
  ctx.bot.on('voip', ev => logger.debug(`[douyin][${ctx.platformUid}] 语音来电: ${ev.callerUid}`))
  // WS 断线 SDK 自带指数退避自动重连（1s→30s 封顶、无限次）；此处仅观测与提示
  ctx.bot.on('reconnecting', ev => {
    if (!manualStop.has(ctx.platformUid)) {
      logger.warn(`[douyin][${ctx.platformUid}] 连接断开，第 ${ev.attempt} 次重连（${ev.delayMs}ms 后）`)
    }
  })
  ctx.bot.on('close', ev => {
    if (manualStop.has(ctx.platformUid)) {
      logger.debug(`[douyin][${ctx.platformUid}] 连接已关闭（主动操作）`)
      return
    }
    logger.warn(`[douyin][${ctx.platformUid}] 连接被断开（${ev.reason || ev.code || '未知原因'}），SDK 自动重连中`)
  })

  bots.set(ctx.platformUid, bot)
  bot.adapter.index = registerBot('webSocketClient', bot)
  manualStop.delete(ctx.platformUid)
  await ctx.bot.start()
  // im 活跃心跳上报（登录后打一次；对齐参考插件 L1150，防连接静默掉线）
  ctx.bot.user.heartbeat().catch(err => logger.debug(
    `[douyin] 心跳上报失败: ${err instanceof Error ? err.message : String(err)}`
  ))
  startRefreshTimer(ctx)
  logger.debug(`[douyin] 账号 ${ctx.platformUid}(${ctx.config.name || '未命名'}) 已上线`)
  return bot
}

/** 卸载 bot：断开连接、停止周期刷新并从 karin 注销 */
export async function destroyBot (bot: AdapterDouyin): Promise<void> {
  manualStop.add(bot.ctx.platformUid)
  stopRefreshTimer(bot.ctx.platformUid)
  bots.delete(bot.ctx.platformUid)
  bot.ctx.bot.stop()
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
          `[douyin] 启用账号失败 ${name}: ${err instanceof Error ? err.message : String(err)}`
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
    applyAccountEnable(oldCfg, nowCfg)
  })
}

/** 启动适配器：挂载媒体代理、恢复配置中启用的账号并注册 */
export async function initAdapter (): Promise<void> {
  mountMediaRoute()
  setupAutoRead()
  setupConfigHotApply()
  loadContactCache()
  const m = getAccountManager()
  await m.restore()
  await Promise.all([...m.accounts.values()].map(ctx => createBot(ctx)))
}

/** 扫码登录并注册适配器（供指令层调用） */
export async function login (options: LoginOptions = {}): Promise<DouyinAccount> {
  const ctx = await getAccountManager().login(options)
  await createBot(ctx)
  return ctx
}
