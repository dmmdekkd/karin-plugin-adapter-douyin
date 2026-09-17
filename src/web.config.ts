import fs from 'node:fs'
import path from 'node:path'
import { components, defineConfig } from 'node-karin'
import { dir } from '@/dir'
import { config } from '@/utils/config'
import type { AccountConfig, Config } from '@/types'

/** WebUI 配置面板 */
export default defineConfig<{
  accounts?: Array<Record<string, unknown>>
  settings?: Array<Record<string, unknown>>
}>({
  /** 插件信息 */
  info: {
    id: dir.name,
    name: '抖音适配器',
    author: {
      name: 'dmmdekkd',
      home: 'https://github.com/dmmdekkd/karin-plugin-adapter-douyin',
      avatar: 'https://github.com/dmmdekkd.png',
    },
    icon: {
      name: 'smartphone',
      size: 24,
      color: '#161823',
    },
    version: dir.version,
    description: 'Karin 抖音适配器 基于 zijieapi IM 协议',
  },

  /** 动态渲染的组件 */
  components: () => {
    const cfg = config()

    return [
      /** 账号管理 账号由扫码登录后自动生成 此处仅展示并支持启用/停用 */
      components.accordionPro.create(
        'accounts',
        (cfg.accounts || []).map(account => ({
          title: account.name || '未命名账号',
          subtitle: account.enable === false ? '已停用' : '已启用',
          name: account.name || '',
          enable: account.enable !== false,
        })),
        {
          label: '账号列表 扫码登录后自动生成',
          children: components.accordion.createItem('account', {
            title: '新账号',
            subtitle: '扫码登录后自动生成',
            children: [
              components.input.string('name', { label: '账号备注', description: '扫码登录后自动生成，不可手动修改', color: 'danger', isDisabled: true }),
              components.switch.create('enable', { label: '启用', color: 'danger', defaultSelected: true }),
            ],
          }),
        }
      ),

      /** 基础配置 */
      components.accordion.create('settings', {
        label: '基础配置',
        children: [
          components.accordion.createItem('behavior', {
            title: '行为开关',
            subtitle: '功能开关',
            children: [
              components.switch.create('autoReadOnMatch', {
                label: '匹配插件自动已读',
                description: '消息被任一插件匹配处理时自动标记会话已读',
                color: 'danger',
                defaultSelected: cfg.autoReadOnMatch === true,
              }),
            ],
          }),
        ],
      }),
    ]
  },

  /** 手风琴按分组返回数组 每项为该组的字段集合 依次展开 */
  save: (input) => {
    try {
      const payload: Record<string, unknown> = {}
      for (const group of Array.isArray(input.settings) ? input.settings : []) {
        if (group && typeof group === 'object') Object.assign(payload, group)
      }

      /** 账号列表 手风琴 Pro 返回数组 过滤掉空账号（账号仅由扫码登录生成） */
      const accounts: AccountConfig[] = (Array.isArray(input.accounts) ? input.accounts : [])
        .filter(item => String(item.name || '').trim())
        .map(item => ({
          name: String(item.name),
          enable: item.enable !== false,
        }))

      const data: Config = {
        accounts,
        autoReadOnMatch: payload.autoReadOnMatch === true,
      }

      fs.writeFileSync(path.join(dir.ConfigDir, 'config.json'), JSON.stringify(data, null, 2))
      return { success: true, message: '保存成功' }
    } catch (err) {
      return { success: false, message: `保存失败：${err instanceof Error ? err.message : String(err)}` }
    }
  },
})