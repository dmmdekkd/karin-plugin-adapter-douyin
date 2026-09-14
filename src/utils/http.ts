import axios from 'node-karin/axios'
import { logger } from 'node-karin'

const DEFAULT_UA
  = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

/**
 * @description 下载资源为 Buffer（图片/视频等）
 * @param url 资源地址
 * @param timeoutMs 超时毫秒，默认 30s
 */
export const getBuffer = async (url: string, timeoutMs = 30000): Promise<Buffer> => {
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      headers: { 'User-Agent': DEFAULT_UA },
    })
    return Buffer.from(res.data)
  } catch (error) {
    logger.error(`[douyin] 资源下载失败: ${url}`, error)
    throw error
  }
}

/**
 * @description 请求 JSON 接口
 */
export const getJson = async <T> (url: string, timeoutMs = 30000): Promise<T> => {
  const res = await axios.get<T>(url, {
    timeout: timeoutMs,
    headers: { 'User-Agent': DEFAULT_UA },
  })
  return res.data
}
