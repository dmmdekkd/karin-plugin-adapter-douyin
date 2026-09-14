'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseSections, validateIssue } = require('./issue-quality.cjs')
const bugConfirmation = `- [x] 已阅读文档
- [x] 已搜索
- [x] 已更新
- [x] 已脱敏
- [x] 理解关闭规则`
const featureConfirmation = `- [x] 已阅读并搜索
- [x] 不是个人排障
- [x] 会描述场景
- [x] 理解不承诺实现`
test('parseSections parses Issue Form markdown fields', () => {
  const sections = parseSections('### 问题描述\n\n详细描述\n\n### 预期行为\n\n正常返回')
  assert.equal(sections.get('问题描述'), '详细描述')
  assert.equal(sections.get('预期行为'), '正常返回')
})
test('validateIssue ignores legacy forms when they are edited later', () => {
  const body = `### 提交前检查
- [x] 我已经搜索过现有的 Issues
### 功能描述
旧版模板中的功能描述`
  assert.deepEqual(validateIssue({ title: 'Feature: 旧版功能建议仍需补充', body, labels: ['enhancement'] }).problems, [])
})
test('validateIssue accepts a complete bug report', () => {
  const body = `### 提交前确认
${bugConfirmation}
### 问题类型
消息收发（文本 / 图片 / 文件 / 语音 / 视频）
### 涉及平台
微信个人号 (ilink)
### 问题描述
更新插件后，发送图片消息一直提示上传失败，同一张图片以文件方式发送正常。
### 复现步骤
1. 在微信端向机器人发送一张图片
2. 机器人尝试回复同一张图片
3. 观察机器人日志
### 实际结果与完整日志
日志显示媒体上传接口返回错误，文本消息收发正常。\n\`\`\`text\n[10:00:01] upload media failed\n[10:00:02] reply text ok\n\`\`\`
### 预期行为
图片消息应正常上传并在微信端显示。
### 相关配置
accounts[0].nickname: 微信ClawBot\ndownloadFile: url
### 运行环境
- 插件版本：1.0.0\n- Karin 版本：1.17.0\n- Node.js 版本：24.13.0\n- 操作系统：Ubuntu 24.04\n- 适配器 / 协议端：karin-plugin-adapter-wxoc / 微信 ilink\n- 安装方式（插件市场 / npm / Git / Docker）：npm
### 复现频率
必现（每次都能复现）`
  assert.deepEqual(validateIssue({ title: 'Bug: 发送图片消息上传失败', body, labels: [{ name: 'bug' }] }).problems, [])
})
test('validateIssue rejects placeholder content and incomplete environment', () => {
  const body = `### 提交前确认
${bugConfirmation}
### 问题类型
消息收发（文本 / 图片 / 文件 / 语音 / 视频）
### 涉及平台
微信个人号 (ilink)
### 问题描述
test
### 复现步骤
*
### 实际结果与完整日志
如图
### 预期行为
无
### 相关配置
*
### 运行环境
- 插件版本：最新版\n- Karin 版本：\n- Node.js 版本：\n- 操作系统：\n- 适配器 / 协议端：\n- 安装方式（插件市场 / npm / Git / Docker）：
### 复现频率
仅出现一次`
  const result = validateIssue({ title: 'Bug:', body, labels: ['bug'] })
  assert.ok(result.problems.length >= 10)
  assert.ok(result.problems.some((problem) => problem.includes('标题过短')))
  assert.ok(result.problems.some((problem) => problem.includes('插件版本')))
})
test('validateIssue accepts a complete feature proposal', () => {
  const body = `### 提交前确认
${featureConfirmation}
### 建议类型
WebUI 或配置体验
### 涉及平台
微信个人号 (ilink)
### 需求背景
管理多个微信账号时，文件自动下载只能使用同一份全局配置，个别账号需要单独关闭，但当前无法按账号区分。
### 功能建议
允许为指定账号覆盖文件自动下载配置；没有单独配置的账号继续继承全局设置，并能随时恢复继承。
### 使用场景
测试账号关闭自动下载避免干扰，生产账号开启自动下载保存文件；管理员保存后，两个账号分别按自己的配置处理。
### 现有方案与不足
目前只能全局开关自动下载，切换时需要反复修改全局配置，维护成本高且容易误操作。
### 预期受益范围
使用该平台或模块的用户会受益
### 兼容性与风险
未配置的账号必须继续沿用现有全局行为。
### 补充材料
愿意协助测试。`
  assert.deepEqual(validateIssue({ title: 'Feature: 支持按账号覆盖文件自动下载配置', body, labels: ['enhancement'] }).problems, [])
})
test('validateIssue rejects duplicated feature answers', () => {
  const repeated = '希望增加按账号配置文件自动下载的功能，满足不同账号分别处理文件的实际使用需求。'
  const body = `### 提交前确认
${featureConfirmation}
### 建议类型
WebUI 或配置体验
### 涉及平台
微信个人号 (ilink)
### 需求背景
${repeated}
### 功能建议
${repeated}
### 使用场景
管理员维护多个用途不同的账号，需要让不同的账号分别处理文件消息。
### 现有方案与不足
当前只能全局配置，维护成本过高。
### 预期受益范围
使用该平台或模块的用户会受益`
  const result = validateIssue({ title: 'Feature: 支持按账号覆盖文件自动下载配置', body, labels: ['enhancement'] })
  assert.ok(result.problems.some((problem) => problem.includes('内容完全重复')))
})
