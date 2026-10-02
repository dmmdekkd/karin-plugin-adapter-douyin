<div align="center">

# karin-plugin-adapter-douyin

karin 抖音适配器插件

基于 [douyin.ts](https://github.com/dmmdekkd/douyin.ts) SDK，支持抖音私聊 / 群聊消息收发与事件处理

</div>

## 🐬 安装教程

需要先准备 [karin](https://github.com/KarinJS/Karin)

#### 🔧 karin 根目录执行命令安装

```bash
pnpm add karin-plugin-adapter-douyin -w
```

## 使用教程

- `#抖音bot登录` 扫码登录新账号（触发短信/密码二次验证时，直接回复验证码或密码即可）
- `#抖音状态` 查看已登录账号（在线/离线）
- `#抖音退出登录 [昵称或uid]` 下线账号并删除本地会话（无参数且仅一个在线账号时直接退出）
- `#抖音检查更新` 检查插件是否有新版本
- `#抖音更新` 更新插件（更新成功自动重启）

以上指令默认仅主人可用。

## 配置说明

配置文件 `config/config.json`：

- `accounts` 账号列表（扫码登录成功后自动生成，不存在则追加、已存在则恢复启用）
- `autoReadOnMatch` 收到消息后自动标记已读（对方可见已读回执），默认 `false`

配置保存后无需重启：适配器会定时检测配置变化，自动连接新启用的账号、断开停用的账号。

## 账号安全与风控

### 登录双重验证（建议关闭）

抖音 App「设置 → 账号与安全 → 登录双重验证」开启后，新设备登录或异常登录会要求二次验证。机器人通过 Cookie 模拟登录，开启双重验证时容易触发风控拦截、登录后强制二次验证，导致掉线或消息收发异常。

**建议关闭双重验证**，保持 Cookie 登录稳定：

![抖音账号与安全-双重验证](docs/account-security.jpg)

### 抖音风控限制

可能出现消息仅回显到自身、对方看不到。

## 消息支持

- 收：文本、@提及（真高亮）、图片、视频、语音、文件、表情回应、引用回复、合并转发
- 发：文本、@、图片、视频、文件、表情回应、合并转发（`node` 自定义节点 + `nodeDirect` 消息引用节点）
- 引用回复：接收时解析引用消息（reply 元素），发送时对 5 分钟内收到的消息自动补全引用信息

## 事件支持

- message：私聊 / 群聊消息
- notice：消息撤回、表情回应、好友增减、群成员增减（status 通道补漏 + 2 分钟去重）、群管理员变更
- request：好友申请、入群申请（approve / reject）
- status：会话状态分流（部分群成员增减仅走 status，不产生系统消息）

## 其他框架集成

本插件面向 karin 运行时。若你希望在其他框架中使用抖音相关能力，可参考以下项目：

- [zhin-adapter-douyin](https://github.com/zhinjs/zhin-adapter-douyin)（Zhin 框架）
- [DouYin-Plugin](https://github.com/dmmdekkd/DouYin-Plugin)（Yunzai 框架）

## 相关链接

- 许可证：MIT（[LICENSE](LICENSE)）
- 更新日志：[CHANGELOG.md](CHANGELOG.md)
- SDK：https://github.com/dmmdekkd/douyin.ts
- karin：https://github.com/KarinJS/Karin