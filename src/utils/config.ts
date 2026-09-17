import fs from 'node:fs'
import path from 'node:path'
import { dir } from '@/dir'
import {
  watch,
  logger,
  filesByExt,
  copyConfigSync,
  requireFileSync,
} from 'node-karin'
import type { Config } from '@/types'

/** 默认配置 账号由扫码登录后自动生成 */
const defConfig: Config = {
  accounts: [],
  autoReadOnMatch: false,
}

/**
 * @description 初始化配置文件
 */
copyConfigSync(dir.defConfigDir, dir.ConfigDir, ['.json'])

/**
 * @description 读取配置
 */
export const config = (): Config => {
  try {
    const cfg = requireFileSync(`${dir.ConfigDir}/config.json`) as Partial<Config>
    return { ...defConfig, ...cfg }
  } catch {
    return defConfig
  }
}

/** 将当前配置写回 config.json */
function writeConfig (cfg: Config): void {
  fs.writeFileSync(path.join(dir.ConfigDir, 'config.json'), JSON.stringify(cfg, null, 2))
}

/**
 * @description 扫码登录成功后自动生成账号配置：不存在则追加，已存在则恢复启用
 */
export function upsertAccount (name: string): void {
  if (!name) return
  const cfg = config()
  const existing = cfg.accounts.find(a => a.name === name)
  if (existing) {
    if (existing.enable === false) {
      existing.enable = true
      writeConfig(cfg)
    }
    return
  }
  cfg.accounts.push({ name, enable: true })
  writeConfig(cfg)
}

/** 配置变更监听器 */
type ConfigListener = (old: Config, now: Config) => void
const listeners = new Set<ConfigListener>()

/**
 * @description 注册配置变更监听，配置保存后立即生效（幂等）
 */
export function onConfigChange (fn: ConfigListener): void {
  listeners.add(fn)
}

/**
 * @description 监听配置文件
 */
setTimeout(() => {
  const list = filesByExt(dir.ConfigDir, '.json', 'abs')
  list.forEach(file => watch(file, (old, now) => {
    /** 合并默认值后触发监听器，配置立即生效 */
    const oldCfg: Config = { ...defConfig, ...((old ?? {}) as Partial<Config>) }
    const newCfg: Config = { ...defConfig, ...((now ?? {}) as Partial<Config>) }
    const changes = diffConfig(oldCfg, newCfg)
    if (changes.length > 0) logger.info(`[douyin] 检测到配置文件更新：${changes.join('；')}`)
    listeners.forEach(fn => fn(oldCfg, newCfg))
  }))
}, 2000)

/** @description 计算新旧配置的变更摘要（人类可读） */
function diffConfig (oldCfg: Config, newCfg: Config): string[] {
  const items: string[] = []
  if (oldCfg.autoReadOnMatch !== newCfg.autoReadOnMatch) {
    items.push(`匹配自动已读 ${oldCfg.autoReadOnMatch ? '开启' : '关闭'}→${newCfg.autoReadOnMatch ? '开启' : '关闭'}`)
  }
  const oldMap = new Map<string, boolean>((oldCfg.accounts || []).map(a => [a.name ?? '', a.enable !== false]))
  const newMap = new Map<string, boolean>((newCfg.accounts || []).map(a => [a.name ?? '', a.enable !== false]))
  for (const [name, enable] of newMap) {
    if (!name) continue
    const prev = oldMap.get(name)
    if (prev === enable) continue
    items.push(prev === undefined
      ? `新增账号「${name}」已${enable ? '启用' : '停用'}`
      : `账号「${name}」${prev ? '启用' : '停用'}→${enable ? '启用' : '停用'}`)
  }
  for (const name of oldMap.keys()) {
    if (name && !newMap.has(name)) items.push(`移除账号「${name}」`)
  }
  return items
}
