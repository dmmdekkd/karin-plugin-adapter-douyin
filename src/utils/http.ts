import axios from 'node-karin/axios'
import { logger } from 'node-karin'

/**
 * @description 下载资源为 Buffer（图片/视频等）
 * @param url 资源地址
 * @param headers 附加请求头（如抖音私有资源需带账号 Cookie/Referer）
 * @param timeoutMs 超时毫秒，默认 30s
 */
export const getBuffer = async (url: string, headers: Record<string, string> = {}, timeoutMs = 30000): Promise<Buffer> => {
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        ...headers,
      },
    })
    return Buffer.from(res.data)
  } catch (error) {
    logger.error(`[douyin] 资源下载失败: ${url}`, error)
    throw error
  }
}
