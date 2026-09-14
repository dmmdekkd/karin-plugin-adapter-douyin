import {
  logger,
  contactFriend, contactGroup,
  senderFriend, senderGroup,
  createPrivateApplyRequest, createGroupApplyRequest,
} from 'node-karin'
import { GroupJoinRequestStatus } from '@/core/im'
import type { RequestEvent } from '@/core/im'
import type { AdapterDouyin } from './index'

/** 抖音请求事件 → karin 请求事件 */
export async function dispatchRequest (bot: AdapterDouyin, ev: RequestEvent): Promise<void> {
  try {
    if (ev.type === 'friend.request') {
      const contact = contactFriend(ev.applicantUid)
      createPrivateApplyRequest({
        bot,
        subEvent: 'friendApply',
        contact,
        sender: senderFriend(ev.applicantUid),
        eventId: `douyin-friend-request-${ev.applicantUid}-${Date.now()}`,
        rawEvent: ev.raw,
        time: Math.floor(Date.now() / 1000),
        srcReply: elems => bot.sendMsg(contact, elems),
        content: { applierId: ev.applicantUid, message: ev.content ?? '', flag: ev.applicantUid },
      })
      return
    }

    // group.join-request：推送不含申请人信息，拉取审核列表补全后再派发
    const list = await bot.ctx.client.getGroupJoinRequests({ conversationShortId: ev.conversationShortId })
    const pending = ev.requestId
      ? list.find(r => r.requestId === ev.requestId)
      : list.find(r => r.status === GroupJoinRequestStatus.PENDING)
    if (!pending) {
      logger.debug('[douyin] 入群申请审核列表未命中，忽略')
      return
    }

    const contact = contactGroup(ev.conversationShortId || ev.conversationId)
    createGroupApplyRequest({
      bot,
      subEvent: 'groupApply',
      contact,
      sender: senderGroup(pending.applicantUid, 'member'),
      eventId: `douyin-group-request-${pending.requestId}-${Date.now()}`,
      rawEvent: ev.raw,
      time: Math.floor(Date.now() / 1000),
      srcReply: elems => bot.sendMsg(contact, elems),
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
