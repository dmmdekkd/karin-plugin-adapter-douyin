# 更新日志

## 1.0.1 · 2026-09-30

### 新增

- `#抖音状态` / `#抖音退出登录` 账号管理指令（仅主人可用）：查看已登录账号在线状态；按昵称或 uid 下线账号并删除本地会话，无参数且仅一个在线账号时直接退出
- SDK 独有能力透传至 bot 实例（21 个）：`sendTyping` / `addGroupMembers` / `getGroupRequests` / `createGroup` / `getChatInfo` / `deleteChat` / `setChatSetting` / `readSwitch` / `getReadIndex` / `getMinIndex` / `getStrangers` / `getStrangerConversations` / `getOnlineStatus` / `heartbeat` / `activeSwitch` / `getEmojiList` / `getVideoUrl` / `uploadImage` / `uploadVideo` / `uploadMedia` / `getAwemeDetail`，其他插件可通过 `e.bot.xxx` 直接调用
- status 会话状态事件接入：群成员变更（commandType=7）补漏派发增减通知，与系统消息通道互斥去重（2 分钟窗口），bot 自身进出群不派发（含大数精度丢失前缀比对兜底）

### 调整

- 登录成功后上报一次 im 心跳（heartbeat），防止连接静默掉线

## 1.0.0 · 2026-09-14

首个发布版本。

### 核心协议

- Android Frontier WebSocket 长连接收消息，HTTP cookie 通道（cmd=100）统一发送
- 桌面客户端登录链路：设备注册（imdesktop）→ ttwid 预热 → 扫码 → MFA（短信/密码）
- x-ss-stub 请求签名、a_bogus 设备指纹签名体系

### 消息能力

- 文本/图片/视频/文件发送（TOS/VOD 上传，文件支持 GCM 加密通道）
- @提及发送（richTextInfos + mentionedUsers 字段）
- 引用回复收发（refMsgInfo 嵌套结构无 schema 解析）
- 合并转发发送（messageType=136，fake/messageID 双节点类型）与接收（longMsg + getForwardMsg）
- 文件接收识别（messageType=150 兼容解析）

### 通知与动作

- 消息表情回应收发（cmd=705 set_property / cmd=500 property 推送）
- 好友/群通知事件分发至 karin request/notice
- 消息撤回、历史消息分页（消息 ID 定位游标）

### 资料

- 自身资料刷新（profile/self 覆盖昵称与马赛克占位头像）
- 他人头像批量获取（im/user/info 接口）、群头像（conversationCoreInfo.icon）
- 昵称/头像/secUid 统一缓存（好友+群成员+陌生人预热）