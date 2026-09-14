import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getBuffer } from '@/utils/http'

/** karin 元素 file 字段（url/路径/base64/data URL）→ 原始字节 */
export async function fileToBytes (file: string): Promise<Uint8Array> {
  if (file.startsWith('base64://')) return Uint8Array.from(Buffer.from(file.slice(9), 'base64'))
  // data URL：karin 截图/本地图片常用形态（data:image/png;base64,...）
  const dataUrl = /^data:[^;,]+;base64,(.+)$/is.exec(file)
  if (dataUrl) return Uint8Array.from(Buffer.from(dataUrl[1], 'base64'))
  if (/^https?:\/\//i.test(file)) return await getBuffer(file)
  // karin 流转后可能传入裸 base64（如 base64:// 前缀已被剥离的图片数据）
  if (file.length > 100 && /^[A-Za-z0-9+/=\r\n]+$/.test(file)) {
    return Uint8Array.from(Buffer.from(file, 'base64'))
  }
  const path = file.startsWith('file://') ? fileURLToPath(file) : file
  return Uint8Array.from(fs.readFileSync(path))
}

const FILE_MAGIC: Array<[string, Uint8Array]> = [
  ['png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47])],
  ['jpg', Uint8Array.from([0xff, 0xd8, 0xff])],
  ['gif', Uint8Array.from([0x47, 0x49, 0x46, 0x38])],
  ['pdf', Uint8Array.from([0x25, 0x50, 0x44, 0x46])],
  ['zip', Uint8Array.from([0x50, 0x4b, 0x03, 0x04])],
]

/** 魔数嗅探文件扩展名（发送侧 name 缺失时补全 format/审核需要） */
export function sniffFileExt (data: Uint8Array): string {
  for (const [ext, magic] of FILE_MAGIC) {
    if (magic.every((byte, index) => data[index] === byte)) return ext
  }
  if (data.length >= 12 && data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) return 'mp4'
  if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) return 'mp3'
  return ''
}
