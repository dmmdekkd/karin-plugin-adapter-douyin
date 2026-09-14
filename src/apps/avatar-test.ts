/**
 * #抖音头像 / #抖音群头像 指令：测试适配器 getAvatarUrl / getGroupAvatarUrl
 *
 * 用法：
 * - #抖音头像            → 自身头像
 * - #抖音头像 <uid>      → 指定用户头像
 * - #抖音群头像          → 第一个群的头像
 * - #抖音群头像 <群ID>   → 指定群头像
 */
import karin, { logger, segment } from 'node-karin'
import type { Elements, Notice } from 'node-karin'

export const douyinAvatar = karin.command(
  /^#抖音头像(?:\s+(\S+))?$/,
  async (e) => {
    const uid = e.msg.replace(/^#抖音头像\s*/, '').trim() || e.selfId
    try {
      const url = await e.bot.getAvatarUrl(uid)
      if (!url) {
        await e.reply(`未获取到头像（uid=${uid}）`)
        return
      }
      const elements: Elements[] = [segment.image(url), segment.text(`\n${url}`)]
      await e.reply(elements)
    } catch (error) {
      await e.reply(`获取头像失败: ${(error as Error).message}`)
    }
  },
  { name: '抖音头像测试', permission: 'master' },
)

export const douyinGroupAvatar = karin.command(
  /^#抖音群头像(?:\s+(\S+))?$/,
  async (e) => {
    try {
      let groupId = e.msg.replace(/^#抖音群头像\s*/, '').trim()
      if (!groupId) {
        const groups = await e.bot.getGroupList()
        groupId = groups[0]?.groupId ?? ''
        if (!groupId) {
          await e.reply('暂无群会话，请指定群ID：#抖音群头像 <群ID>')
          return
        }
      }
      const url = await e.bot.getGroupAvatarUrl(groupId)
      if (!url) {
        await e.reply(`未获取到群头像（groupId=${groupId}）`)
        return
      }
      const elements: Elements[] = [segment.image(url), segment.text(`\n${url}`)]
      await e.reply(elements)
    } catch (error) {
      await e.reply(`获取群头像失败: ${(error as Error).message}`)
    }
  },
  { name: '抖音群头像测试', permission: 'master' },
)

/** #抖音回应 [消息ID] [faceId] / #抖音取消回应 [消息ID] [faceId]：测试 setMsgReaction；缺省消息ID时回应触发指令的消息 */
export const douyinReaction = karin.command(
  /^#抖音(取消)?回应(?:\s+(\S+))?(?:\s+(\d+))?$/,
  async (e) => {
    const isSet = !e.msg.includes('取消')
    const first = (e.msg.match(/^#抖音(?:取消)?回应(?:\s+(\S+))?/) ?? [])[1] ?? ''
    const faceId = Number((e.msg.match(/#抖音(?:取消)?回应(?:\s+\S+)?\s+(\d+)\s*$/) ?? [])[1] ?? 1)
    // 纯数字首参视为 faceId，消息ID 缺省取当前触发消息
    const messageId = /^\d+$/.test(first) ? e.messageId : first || e.messageId
    const face = /^\d+$/.test(first) ? Number(first) : faceId
    try {
      await e.bot.setMsgReaction(e.contact, messageId, face, isSet)
      await e.reply(`表情回应${isSet ? '已添加' : '已移除'}: faceId=${face} msgId=${messageId}`)
    } catch (error) {
      await e.reply(`表情回应失败: ${(error as Error).message}`)
    }
  },
  { name: '抖音表情回应测试', permission: 'master' },
)

/** 表情回应事件打印：捕获群 reaction 通知 */
export const douyinReactionLog = karin.on('notice', (data: Notice) => {
  if (data.subEvent !== 'groupMessageReaction') return
  const reaction = data.content as { messageId: string; faceId: number; count: number; isSet: boolean }
  logger.info(
    `[抖音] 表情回应事件: messageId=${reaction.messageId} faceId=${reaction.faceId} ` +
    `count=${reaction.count} isSet=${reaction.isSet}`,
  )
})
