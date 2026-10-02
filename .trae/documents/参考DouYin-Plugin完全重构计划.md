# 参考 DouYin-Plugin 完全重构计划

## 一、Summary

完全参考 Yunzai 版 [DouYin-Plugin/index.js](file:///D:/yunzai/Yunzai/plugins/DouYin-Plugin/index.js)（单文件 1369 行）的简洁风格重构本插件：

- **文件组织（已确认：完全重构结构）**：`src/adapter/` 从 10 文件压到 5 文件，收/发消息转换归并到单一模块，事件分发内联进主文件。
- **类型裁剪（已确认：yunzai 用到哪些就支持哪些）**：`parseContent` 只保留参考插件 `makeMessageSegs` 覆盖的 8 类（text/image/video/file/audio/emoji/location/forward），删除 link/userCard/share/chains/card/groupCard 6 类低频分支 → 兜底文本。
- **移除复杂逻辑**：发送侧 `resolveReplyOptions`/`resolveDirectNodes` 每次查历史 60 条 → 对齐参考插件 `replys` 内存缓存（收到消息即缓存、过期清理）；40+ 单行 unsupported 方法 → 循环批量绑定 prototype；删除 6 个低价值适配器文件。
- **统一命名与中文日志**：辅助函数对齐参考插件 `makeMessageSegs/makeMsg/makeBrief/sendBody` 风格，发送摘要日志统一为 `发送到 Group(x)/User(x): [类型:摘要]`。

目标产物：`pnpm exec tsc --noEmit` 与 `pnpm exec eslint src --ext .ts --max-warnings=0` 双绿，代码规模显著下降、逻辑平铺直叙。

---

## 二、现状分析（探索结论）

### 2.1 参考插件（DouYin-Plugin/index.js，1369 行）核心风格

| 组件 | 内容 |
|---|---|
| `connect(token)` L1024+ | `if (Bot[id]?.sdk) removeBot(id)` 防双连接 → `new douyin.Bot` → `Bot[id]={...}` → `Object.assign(Bot[id], 60 个 SDK 透传方法)` → 8 行 sdk.on 事件注册 → loadFriend/loadGroup → 30 分钟刷新定时器 `refresh.unref?.()` → `Bot.em('connect.'+id)` |
| `makeMessageSegs(msg)` L65 | **只处理 7 种类型**：at/text/image/video/file/audio(→record)/emoji(→image)/location + default → raw 透传。image 取 `thumbUrls?.[0] \|\| mediumUrls?.[0] \|\| largeUrls?.[0] \|\| originUrls?.[0]`；video = 封面 + `[视频] url` 文本；file = `[文件] name` 文本 |
| `makeMsg(data,msg,nested)` L115 | 发侧转换：text/ats/atAll/image/reply 累计变量 + `flush()` 闭包；image 独立消息、文本带 ats 发送；**reply 来源 `data.bot.replys[data.message_id]`（收消息时缓存，300 秒 setTimeout 删除，不查历史）** |
| `sendBody(data,{reply,body})` L283 | `ret.statusCode` 非 0 抛错；401/login/expire 正则提示重登 |
| `makeBrief({type,body,reply})` L248 | 3 行内联返回 `[图片:md5]/[视频:md5]/[文件:md5]` 发送摘要 |
| `loadFriend/loadGroup` L610/625 | `Bot.getMap`（Yunzai 核心特性）磁盘 Map 持久化联系人 |
| config 热重载 L1256 | 30 秒 setInterval 对比 token 列表：新增/变更 connect、删除 removeBot |
| `memberChangeNotice` L888+ | status commandType=7 补漏派发群成员增减；`isSelfUid`（前 15 位比对）；`chatIdToTarget`（chatId 反查群/好友） |

**不可迁移点**：`group.dismiss` 事件（SDK douyin.ts 0.2.1 不存在）；`Bot.getMap` 磁盘 Map（karin 无此特性，我们是 contact.ts 自研落盘）；`pickXxx` getter 式对象（面向 Yunzai 插件 API，我们是 karin `AdapterType` 接口，方法名受约束不可改）。

### 2.2 我们项目的复杂度清单（重构靶点）

| 文件 | 行数 | 复杂度 |
|---|---|---|
| [convert.ts](file:///d:/there/karin-project/karin-plugin-adapter-douyin/src/adapter/convert.ts) | 388 | 完整复刻 SDK `parseBody`（14 种类型分支 + `imageFromObject/mentionsFromValue/stripMentions` 3 个私有函数）+ 收/发双向转换 + forwardCache |
| [send.ts](file:///d:/there/karin-project/karin-plugin-adapter-douyin/src/adapter/send.ts) | 236 | `resolveReplyOptions`/`resolveDirectNodes` 每次发送查历史 60 条补全，较重 |
| [index.ts](file:///d:/there/karin-project/karin-plugin-adapter-douyin/src/adapter/index.ts) | 514 | 类 + 事件注册 + 连接管理 + 40+ 单行 unsupported 方法 |
| [notice.ts](file:///d:/there/karin-project/karin-plugin-adapter-douyin/src/adapter/notice.ts) | 185 | switch 9 分支派发（私聊仅日志等） |
| [contact.ts](file:///d:/there/karin-project/karin-plugin-adapter-douyin/src/adapter/contact.ts) | 124 | 缓存落盘 + resolveChatId/chatAddressOf（纯函数，无复杂逻辑，保留） |
| [media.ts](file:///d:/there/karin-project/karin-plugin-adapter-douyin/src/adapter/media.ts) | 102 | 媒体代理 + CENC 解密（保留） |
| [message.ts](file:///d:/there/karin-project/karin-plugin-adapter-douyin/src/adapter/message.ts) | 61 | dispatchMessage（并入主文件） |
| [request.ts](file:///d:/there/karin-project/karin-plugin-adapter-douyin/src/adapter/request.ts) | 68 | friend.request 直发；group.join-request 拉列表补全（并入主文件） |
| [autoRead.ts](file:///d:/there/karin-project/karin-plugin-adapter-douyin/src/adapter/autoRead.ts) | 36 | hooks.eventCall 注册（并入主文件） |
| [login.ts](file:///d:/there/karin-project/karin-plugin-adapter-douyin/src/adapter/login.ts) | 11 | login 包装（并入主文件） |

### 2.3 已确认的关键技术事实

- `registerBot(_: AdapterCommunication, bot: AdapterBase)`（node-karin 1.17.0 d.ts L3627），且 `AdapterBase<T> implements AdapterType<T>`（L3150）：**类标 abstract 但成员方法均未标 abstract**（L3152-3349 抽查无 abstract 关键字）→ 子类不强制实现全部方法，**40+ unsupported 可循环绑定 prototype**，TS 不会报错。
- forward 必须保留：`getForwardMsg(resId)` 依赖 convert.ts 的 `forwardCache`（loadForwardNodes 反查发送侧缓存的节点）。
- 循环依赖风险：contact 逻辑若并入 index.ts，将与 convert.ts 互引（convert 需要 `resolveChatId/chatAddressOf`）→ **contact.ts 保持独立**。
- 参考插件 reply 用 `data.bot.replys[message_id]` 内存缓存（300s 过期），不查历史 —— 可无损对齐。

---

## 三、重构方案

### 3.1 文件合并：`src/adapter/` 10 文件 → 5 文件

| 目标文件 | 合并来源（动作） |
|---|---|
| `index.ts`（主文件，预计 ~600 行） | 原有类/连接管理/热重载/initAdapter + 并入 `message.ts`（makeMessage）+ `notice.ts`（makeNotice）+ `request.ts`（makeRequest）+ `autoRead.ts`（setupAutoRead）+ `login.ts`（export login） |
| `convert.ts`（收+发统一，预计 ~260 行） | 原有 parseContent 裁剪后收侧 + 并入 `send.ts` 全部（sendKarinElements/sendReply/collectForwardNodes/replyCache/makeBrief） |
| `contact.ts` | 保留不动（纯函数、落盘缓存，并入会产生循环依赖） |
| `media.ts` | 保留不动 |
| — 删除 6 个 | `message.ts` / `notice.ts` / `request.ts` / `autoRead.ts` / `login.ts` / `send.ts` |

**主文件 `index.ts` 结构（对齐参考插件 connect 范式）**：

```
AdapterDouyin extends AdapterBase 类：
  - identity: adapter/account 属性（保留）
  - makeMessage(msg) / makeNotice(event) / makeRequest(event)：类私有方法
    （内容来自原 message/notice/request.ts，改用 this.bot 上下文，去掉多余参数透传）
  - 已实现方法保留：sendMsg/recallMsg/setMsgReaction/getFriendList/getNickname/getAvatarUrl/
    peerAvatarUrl/getGroupList/getGroupInfo/getGroupAvatarUrl/getGroupMemberList/
    getGroupMemberInfo/getStrangerInfo/getMsg/getHistoryMsg/http/getCookies/getCredentials/
    getCSRFToken/requireChatId/setFriendApplyResult/setGroupApplyResult/setGroupName/
    groupKickMember/setGroupQuit
  - unsupported 批量绑定（见 3.3）
模块级：
  - identity: bots Map / manualStop Set / refreshTimers Map（保留）
  - createBot/destroyBot/logoutBot/getBots/applyAccountEnable/setupConfigHotApply/initAdapter（保留）
  - setupAutoRead（来自 autoRead.ts，摘函数体，不另占文件）
  - export { login }（来自 login.ts，保留 `@/adapter` 导入面不变，apps/login.ts 无需改动）
```

**makeMessage 收侧**（原 message.ts）：`dispatchMessage` 改用 reference 插件式命名 `makeMessage`，保留 `createGroupMessage/createFriendMessage` 分派、空文本跳过、srcReply 闭包；**新增 `rememberReply(msg)`**——收到消息时将 `BotMessage` 写入 replyCache（详见 3.2），替代发送侧查历史。

**makeNotice 收侧**（原 notice.ts）：9 分支 switch 保留（reaction/私聊日志/friend 增减/recall/group 成员增减/admin/typing debug/群名变更/群头像变更），仅函数名对齐为 `makeNotice`，去掉跨模块状态（emoji 反查表不动）。

**makeRequest 收侧**（原 request.ts）：保留 friend.request 直发 + group.join-request 拉列表补全，函数名对齐 `makeRequest`。

### 3.2 `convert.ts` 裁剪 + 融合 send.ts（重点简化）

**收侧 `parseContent(content, messageType)` 裁剪为 8 类型**：

| 保留类型 | 消息类型值 | 产出 |
|---|---|---|
| text | 1、133（含 hint 73/90） | 文本 + ats（`mentionsFromValue` 保留，ats 需要） |
| image | 7 | image（`thumbUrls?.[0] \|\| mediumUrls?.[0] \|\| largeUrls?.[0] \|\| originUrls?.[0]`，对齐参考插件） |
| video | 8 | video + 封面 + `[视频] url` 文本（对齐参考插件） |
| file | 6、150 | 转 `[文件] name` 文本（对齐参考插件）或 file 元素（保留现状 file 元素） |
| audio | 17 | record（对齐参考插件） |
| emoji | aweType 507 或带 url | image（对齐参考插件） |
| location | 502 | location（保留） |
| forward | 136 | forward → `loadForwardNodes` 缓存 + 长消息（**必须保留**：getForwardMsg 依赖） |
| default | 其余 | 文本兜底（对齐参考插件 raw 透传降级） |

**删除 6 类低频分支**：link(26)/userCard(25)/share(800+null)/chains(152)/card(110)/groupCard(58) → 兜底文本。
同时删除不再被引用的辅助函数（`imageFromObject` 等按裁剪后实际引用保留，删除死代码）。

**发侧融合 send.ts**（移入 convert.ts）：

- `sendKarinElements` → 对齐参考插件命名改为 `makeMsg`（内部逻辑不变：合并转发单发 + text/ats 累计 + flush 闭包 + image/video/file 单发 + record 降级文本）。
- `sendBody`：对齐参考插件——`ret.statusCode !== 0` 抛错；401/login/expire 正则提示重登。
- `makeBrief`：3 行内联摘要 `[图片:md5]/[视频:md5]/[文件:md5]` 等；发送成功日志统一中文格式 `发送到 Group(群号)/User(用户号): {摘要}`（对齐参考插件 L343）。
- **`replyCache` 替换查历史**：
  - 新增模块级 `replyCache = new Map<string, ReplyCacheItem>()`
  - `rememberReply(msg)`（index.ts 收消息时调用）：`replyCache.set(serverMessageId, msg)` + `setTimeout(() => replyCache.delete(...), 300_000)`，键名对齐参考插件 `replys`
  - `sendReply`（原 `resolveReplyOptions`）：优先查 replyCache 构 `ReplyOptions`；**未命中 → 降级查历史 60 条补全（保留现状兜底），仍无 → 普通文本发送**
  - `resolveDirectNodes`（node subType='messageID'）：保留查历史 60 条兜底，逻辑不动
- `forwardCache/loadForwardNodes/cacheForwardNodes`、`normalizeNodeMessage`、`collectForwardNodes`、`mediaSource`（剥 `base64://` 前缀）全部随文件迁移保留。

### 3.3 unsupported 批量绑定（替代 40+ 单行）

```ts
const UNSUPPORTED = [
  'sendLike', 'pokeUser', 'createResId', 'setGroupMute', 'setGroupAllMute',
  'setGroupCard', 'setGroupAdmin', 'setGroupMemberTitle', 'setGroupSpecialTitle',
  'setGroupNotice', 'delGroupNotice', 'setEssenceMsg', 'deleteEssenceMsg',
  'getGroupHighlights', 'setGroupPortrait', 'setGroupRemark', 'getGroupHonor',
  'getNotJoinedGroupInfo', 'getGroupMuteList', 'getGroupAtAllRemain', 'getAtAllCount',
  'uploadFile', 'uploadGroupFile', 'uploadPrivateFile', 'downloadFile', 'getFileUrl',
  'getPrivateFileUrl', 'getRkey', 'getGroupFileList', 'getGroupFileSystemInfo',
  'getGroupFileUrl', 'getGroupRootFiles', 'getGroupFilesByFolder',
  'createGroupFileFolder', 'deleteGroupFile', 'deleteGroupFolder', 'renameGroupFolder',
  'moveGroupFile', 'setAvatar', 'deleteFriend', 'deleteUnidirectionalFriend',
  'getUnidirectionalFriendList', 'sendGroupSign', 'sendGroupAiRecord',
  'sendAiCharacter', 'getAiCharacters', 'ocrImage', 'getImage', 'getRecord',
  'getWordSlices', 'fetchCustomFace', 'getGroupSystemMsg'
] as const

for (const name of UNSUPPORTED) {
  Object.defineProperty(AdapterDouyin.prototype, name, {
    value () { return this.unsupported(name) }
  })
}
```

- **已确认**：`AdapterBase` 成员非 abstract，TS 不强制子类实现 → 批量绑定编译可通过，且运行时调用均有 `unsupported` 中文提示。
- **风险项（实现阶段验证）**：若个别方法名在 `AdapterType` 中签名不一致导致 TS 报错，回退为该单个方法手写一行；若某方法在 SDK 有真实能力（之前误标 unsupported），改用真实实现。其余保持批量绑定。

### 3.4 命名与风格统一

- 收侧转换统一入口 `makeMessageSegs`；发侧 `makeMsg`；单条发送 `sendBody`；摘要 `makeBrief`（对齐参考插件）。
- 删除 `toKarinElements/toHistoryElements` 双入口 → 合并为单一 `toElements`（forward 除外场景无差异，保留 A/B 重载若 getHistoryMsg 需要不同产物——实现时按实际调用点判定，倾向单函数 + 参数）。
- 全部中文注释/日志；禁止仅一次使用的常量（字面量内联）；导入不用 `as` 重命名；neostandard `@typescript-eslint/no-unused-vars` 未用参数加 `_` 前缀。
- 删除死代码：裁剪后 `convert.ts` 不再被引用的导出、（若有）无调用方辅助函数一律删除，不留兼容层。

### 3.5 不改动范围（明确排除）

- [apps/avatar-test.ts](file:///d:/there/karin-project/karin-plugin-adapter-douyin/src/apps/avatar-test.ts)（用户确认保留）
- `src/api/` `src/store/` `src/utils/` `src/apps/`（login 指令入口）`src/web.config.ts`：**不因本次重构调整**，仅当合并后某导入路径失效时做最小修正（如 `export { login }` 面保持不变，apps/login.ts 无需改）。
- `contact.ts`（落盘缓存逻辑）、`media.ts`（代理/解密）整体保留。
- SDK 行为不改（douyin.ts 0.2.1 无 group.dismiss，不补假事件）。

---

## 四、假设与决策（Assumptions & Decisions）

1. **用户已确认**：文件组织走「完全重构结构」（10→5 文件）；类型裁剪走「yunzai 用到哪些就支持哪些」（8 类 + 兜底）。
2. **forward 保留**：虽属低频，但 `getForwardMsg`/`createResId` 链路依赖 forwardCache，删除会导致功能回归 → 保留 136 解析 + 发送侧节点缓存。
3. **replyCache 采用参考插件语义**：收消息缓存 + 300s 过期；发送未命中才回退查历史，最大程度简化发送路径。
4. **unsupported 批量绑定**：以「编译通过 + 运行时 unsupported 提示」为准，不追求 100% 类型完美；个别报错方法单独处理（见 3.3 风险项）。
5. **不引入新依赖、不修改 SDK、不修改配置格式**——纯内部代码重组。
6. adapter 目录最终为 5 文件：`index.ts`、`convert.ts`、`contact.ts`、`media.ts`（`login.ts` 删除，login 并入 index.ts 内 `export` 面）。

---

## 五、验证步骤（Verification）

1. `pnpm exec tsc --noEmit` —— 全部类型通过（重点验证 unsupported 批量绑定）。
2. `pnpm exec eslint src --ext .ts --max-warnings=0` —— 0 警告（neostandard + no-unused-vars）。
3. 手工核对：`grep` 确认 6 个删除文件的 `@/adapter/xxx` 导入面已被新 index.ts 覆盖（`login`/`createBot`/`destroyBot`/`initAdapter` 等导出面不变，`apps/login.ts`、`src/index.ts`、`api/account.ts` 可编译）。
4. 快速回归核对：`createGroupMessage/createFriendMessage`、`getForwardMsg`、`rememberReply`→`sendReply` 三条链路在源码层面走查一遍（无运行时联调要求）。

---

## 六、实施步骤（供批准后执行）

1. 重写 `src/adapter/convert.ts`：裁剪 parseContent 为 8 类型 + 融合 send.ts（makeMsg/sendBody/makeBrief/replyCache/forward 缓存）。
2. 重写 `src/adapter/index.ts`：并入 makeMessage/makeNotice/makeRequest/setupAutoRead/export login + unsupported 批量绑定。
3. 删除 6 个文件：`message.ts`、`notice.ts`、`request.ts`、`autoRead.ts`、`login.ts`、`send.ts`。
4. 最小修正受影响导入（若有），不改 apps/api/store/utils。
5. `pnpm exec tsc --noEmit` + `pnpm exec eslint src --ext .ts --max-warnings=0`，全绿后结束。