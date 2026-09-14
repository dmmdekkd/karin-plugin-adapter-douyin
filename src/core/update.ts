import { checkPkgUpdate, logger, updatePkg } from 'node-karin'
import { dir } from '@/dir'

/** 检查更新 返回结果文本 */
export async function checkUpdate (): Promise<string> {
  const result = await checkPkgUpdate(dir.name)
  if (result.status === 'yes') {
    return `检查到新版本: ${result.local} → ${result.remote}\n发送 #抖音更新 进行更新`
  }
  if (result.status === 'no') {
    return `当前已是最新版本: ${result.local}`
  }
  return `检查更新失败: ${result.error.message}`
}

/** 执行更新 返回结果文本与是否需要重启 */
export async function performUpdate (): Promise<{ text: string, needRestart: boolean }> {
  const check = await checkPkgUpdate(dir.name)
  if (check.status === 'no') return { text: `已是最新版本: ${check.local}`, needRestart: false }
  if (check.status === 'error') return { text: `更新失败: ${check.error.message}`, needRestart: false }

  const result = await updatePkg(dir.name)
  if (result.status === 'ok') {
    return { text: `更新成功: ${result.local} → ${result.remote}`, needRestart: true }
  }
  return { text: `更新失败: ${result.data}`, needRestart: false }
}

/** 自动检查并静默更新 更新成功仅打印日志提示重启 不自动重启 */
export async function autoCheck (): Promise<void> {
  try {
    const result = await checkPkgUpdate(dir.name)
    if (result.status !== 'yes') return

    const updated = await updatePkg(dir.name)
    if (updated.status === 'ok') {
      logger.info(`${logger.violet(`[插件:${updated.remote}]`)} ${logger.green(dir.name)} 自动更新完成 ${logger.green(`${updated.local} → ${updated.remote}`)} 重启 Karin 后生效`)
    } else {
      logger.warn(`[抖音适配器] 自动更新失败: ${updated.data}`)
    }
  } catch (error) {
    logger.warn(`[抖音适配器] 自动更新检查失败: ${(error as Error).message}`)
  }
}
