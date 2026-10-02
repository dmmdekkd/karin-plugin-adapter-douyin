import { createDecipheriv } from 'node:crypto'
import { Readable } from 'node:stream'
import { app, config, logger } from 'node-karin'
import { decryptCencMp4 } from 'douyin.ts'
import type { Request, Response } from 'express'
import { AccountStore } from '@/store'
import { dir } from '@/dir'
import { DESKTOP_PC_UA } from '@/utils/im'

/** 幂等挂载标记（跨模块重载防重复挂载） */
const MOUNTED = Symbol.for('karin.douyin.media.mounted')

/** 抖音富媒体代理 URL（挂载在 Karin HTTP 服务下，代理请求携带账号 Cookie + Referer；skey 供代理内解密图片） */
export function mediaUrl (uid: string, url: string, skey?: string): string {
  return `http://127.0.0.1:${config.port()}/dm/${uid}?u=${encodeURIComponent(url)}${skey ? `&k=${skey}` : ''}`
}

/** AES-256-GCM 解密抖音图片（前 12 字节 IV + 密文 + 后 16 字节 AuthTag，密钥为消息 skey） */
function decryptImage (buf: Buffer, skey: string): Buffer | undefined {
  if (buf.length < 29) return undefined
  try {
    const d = createDecipheriv('aes-256-gcm', Buffer.from(skey, 'hex'), buf.subarray(0, 12))
    d.setAuthTag(buf.subarray(buf.length - 16))
    return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()])
  } catch {
    return undefined
  }
}

/** 按魔数识别图片类型（转码档为 WebP，origin 档可能为 HEIC） */
function imageContentType (buf: Buffer): string {
  const head = buf.subarray(0, 12).toString('hex')
  if (head.startsWith('ffd8ff')) return 'image/jpeg'
  if (head.startsWith('89504e47')) return 'image/png'
  if (head.startsWith('52494646') && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'image/heic'
  if (head.startsWith('474946')) return 'image/gif'
  return 'application/octet-stream'
}

/** 幂等挂载媒体代理路由：按账号 Cookie 拉取抖音私有资源；带 skey 的图片解密后转发，其余流式转发 */
export function mountMediaRoute (): void {
  const holder = globalThis as unknown as Record<symbol, boolean>
  if (holder[MOUNTED]) return
  holder[MOUNTED] = true
  const store = new AccountStore(dir.accountsDir)
  app.use('/dm/:uid', async (req: Request, res: Response) => {
    const url = String(req.query.u ?? '')
    const uid = String(req.params.uid ?? '')
    if (!/^https?:\/\//.test(url)) {
      res.status(400).end('bad url')
      return
    }
    try {
      const headers: Record<string, string> = {
        Referer: 'https://www.douyin.com/',
        'User-Agent': DESKTOP_PC_UA,
      }
      const cookie = store.load(uid)?.cookie
      if (cookie) headers.Cookie = cookie
      const upstream = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30_000) })
      if (!upstream.ok) {
        res.status(upstream.status).end('upstream error')
        return
      }
      if (!upstream.body) {
        res.status(502).end('empty upstream')
        return
      }
      const skey = String(req.query.k ?? '')
      if (/^[0-9a-f]{64}$/i.test(skey)) {
        const plain = decryptImage(Buffer.from(await upstream.arrayBuffer()), skey)
        if (!plain) {
          res.status(502).end('decrypt error')
          return
        }
        res.setHeader('Content-Type', imageContentType(plain))
        res.setHeader('Content-Length', String(plain.length))
        res.end(plain)
        return
      }
      // 32 位 hex 密钥 = CENC 加密视频（AES-128 CBC 逐样本解密）
      if (/^[0-9a-f]{32}$/i.test(skey)) {
        const plain = decryptCencMp4(Buffer.from(await upstream.arrayBuffer()), skey)
        res.setHeader('Content-Type', 'video/mp4')
        res.setHeader('Content-Length', String(plain.length))
        res.end(plain)
        return
      }
      const contentType = upstream.headers.get('content-type')
      const contentLength = upstream.headers.get('content-length')
      if (contentType) res.setHeader('Content-Type', contentType)
      if (contentLength) res.setHeader('Content-Length', contentLength)
      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res)
    } catch (err) {
      logger.error(`[douyin] 媒体代理失败 ${url}:`, err)
      if (!res.headersSent) res.status(502).end('proxy error')
      res.destroy()
    }
  })
  logger.debug('[douyin] 媒体代理已挂载到 Karin HTTP 服务: /dm')
}
