# karin-plugin-adapter-douyin

karin 抖音适配器插件，基于抖音桌面端 IM 协议实现私聊/群聊的完整接入。

## 功能特性

- **消息收发**：文本、@提及（真高亮）、图片、视频、语音接收、文件、表情回应
- **合并转发**：`node` 自定义节点 + `nodeDirect` 消息引用节点，双向支持
- **引用回复**：接收解析引用消息（reply 元素），发送自动补全引用信息
- **通知事件**：好友增减、群成员增减/管理变更、消息撤回、消息表情回应
- **账号管理**：扫码登录（桌面端设备注册，规避短信二次验证）、短信/密码 MFA
- **资料体系**：昵称/头像多级缓存，群头像、成员名片支持
- **历史消息**：分页拉取，支持消息 ID 定位游标

## 安装

在 karin 根目录执行：

```bash
pnpm add karin-plugin-adapter-douyin -w
```

登录：发送 `#抖音登录` 扫码；如需二次验证按提示使用 `#抖音验证 <验证码/密码>`。

## 测试指令

| 指令 | 说明 |
| --- | --- |
| `#抖音头像 [uid]` | 查看自身/指定用户头像 |
| `#抖音群头像 [群ID]` | 查看群头像 |
| `#抖音回应 [消息ID] [faceId]` | 表情回应（缺省消息ID时回应当前消息） |
| `#抖音取消回应 [消息ID] [faceId]` | 取消表情回应 |

faceId 对照见 `resources/reactions.json`（1-6 对应官方回应面板：爱心/大笑/惊讶/泪奔/赞/抱拳）。

## 更新日志

### 1.0.0（2026-09-14）

首个发布版本。

**核心协议**

- Android Frontier WebSocket 长连接收消息，HTTP cookie 通道（cmd=100）统一发送
- 桌面客户端登录链路：设备注册（imdesktop）→ ttwid 预热 → 扫码 → MFA（短信/密码）
- x-ss-stub 请求签名、a_bogus 设备指纹签名体系

**消息能力**

- 文本/图片/视频/文件发送（TOS/VOD 上传，文件支持 GCM 加密通道）
- @提及发送（richTextInfos + mentionedUsers 字段）
- 引用回复收发（refMsgInfo 嵌套结构无 schema 解析）
- 合并转发发送（messageType=136，fake/messageID 双节点类型）与接收（longMsg + getForwardMsg）
- 文件接收识别（messageType=150 兼容解析）

**通知与动作**

- 消息表情回应收发（cmd=705 set_property / cmd=500 property 推送）
- 好友/群通知事件分发至 karin request/notice
- 消息撤回、历史消息分页（消息 ID 定位游标）

**资料**

- 自身资料刷新（profile/self 覆盖昵称与马赛克占位头像）
- 他人头像批量获取（im/user/info 接口）、群头像（conversationCoreInfo.icon）
- 昵称/头像/secUid 统一缓存（好友+群成员+陌生人预热）
