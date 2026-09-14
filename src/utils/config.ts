import { dir } from '@/dir'
import {
  watch,
  logger,
  filesByExt,
  copyConfigSync,
  requireFileSync,
} from 'node-karin'
import type { Config } from '@/types'

/** 默认配置 */
const defConfig: Config = {
  accounts: [{ name: '主号', enable: true }],
  receiverMode: 'android_websocket',
  skipMssdk: true,
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

/**
 * @description 监听配置文件
 */
setTimeout(() => {
  const list = filesByExt(dir.ConfigDir, '.json', 'abs')
  list.forEach(file => watch(file, (old, now) => {
    logger.info([
      '[douyin] 检测到配置文件更新',
      `旧数据: ${old}`,
      `新数据: ${now}`,
    ].join('\n'))
  }))
}, 2000)
