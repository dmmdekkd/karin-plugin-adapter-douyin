import karin, { restartDirect } from 'node-karin'
import { autoCheck, checkUpdate, performUpdate } from '@/core/update'
import { dir } from '@/dir'

/** 自动更新定时任务 每日 04:00 检查 Karin 启动时注册 */
export const task = karin.task('抖音适配器自动更新', '0 4 * * *', autoCheck, { name: dir.name })

/** #抖音检查更新 */
export const check = karin.command(/^#?抖音检查更新$/, async (e) => {
  await e.reply(await checkUpdate())
  return true
}, { name: '抖音检查更新', permission: 'master' })

/** #抖音更新 */
export const update = karin.command(/^#?抖音更新$/, async (e) => {
  await e.reply('正在更新，请稍候...')
  const result = await performUpdate()
  await e.reply(result.text)
  if (result.needRestart) {
    await restartDirect()
  }
  return true
}, { name: '抖音更新', permission: 'master' })
