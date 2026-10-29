/**
 * 最小 ZIP 读取器。
 *
 * xlsx / docx / pptx 都是 zip 容器，宿主 profile 里没有任何现成的解压包，
 * 而 bunde 又不该拉外部依赖，所以这里自己按 ZIP 规范读中央目录。
 * 只支持 store(0) 与 deflate(8) 两种压缩方法 —— Office 文档只会用这两种；
 * ZIP64 也跳过，单个文档超过 4GB 不在本插件的场景里。
 */
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/** 从尾部向前找 End of Central Directory（注释最长 65535 字节）。 */
function findEocd(buf) {
  const minStart = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= minStart; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/**
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>} 条目名 -> 解压后的内容
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 zip：内容太短')
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录结尾')
  const entryCount = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset === 0 || cdOffset >= buf.length) throw new Error('不是有效的 zip：中央目录偏移越界')

  const files = new Map()
  let p = cdOffset
  for (let n = 0; n < entryCount; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue // 目录条目
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) continue
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    try {
      if (method === 0) files.set(name, Buffer.from(raw))
      else if (method === 8) files.set(name, inflateRawSync(raw))
      // 其他压缩方法（bzip2/lzma）Office 不会用，静默跳过
    } catch {
      // 单条损坏不影响整体：跳过这条，让上层按"缺内容"处理
    }
  }
  if (files.size === 0) throw new Error('zip 内没有可读条目')
  return files
}

/** 解 XML 实体（Office 的 sharedStrings / document.xml 里常见）。 */
export function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
}
