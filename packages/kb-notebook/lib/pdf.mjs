/**
 * PDF 文本层抽取（无依赖）。
 *
 * PDF 不是 zip，必须自己走一遍对象流。这里做的是「文本层」抽取，不做排版还原：
 *   1. 扫出所有 stream，FlateDecode 的用 zlib 解压
 *   2. 从字体资源里收集 ToUnicode CMap（Identity-H 的中文 PDF 靠它才能还原字符）
 *   3. 在内容流里找 BT…ET 文本块，按 Tj/TJ 取出字符串，按 Td/TD/T* 断行
 *
 * 明确的边界：扫描件（整页是图片）没有文本层，会返回空并给出可读的原因，
 * 不会假装读到了内容；Type3 位图字体、加密 PDF 同样抽不出来。
 */
import { inflateSync, constants as zlibConstants } from 'node:zlib'

/** 所有 stream 及其字典（做最小解压）。 */
function extractStreams(buf) {
  const out = []
  const marker = Buffer.from('stream')
  const endMarker = Buffer.from('endstream')
  let pos = 0
  while (pos < buf.length) {
    const at = buf.indexOf(marker, pos)
    if (at < 0) break
    // 确认是独立的关键字，不是 "endstream" 里的片段
    const prev = at > 0 ? buf[at - 1] : 0x0a
    if (prev !== 0x0a && prev !== 0x0d && prev !== 0x20) {
      pos = at + marker.length
      continue
    }
    let dataStart = at + marker.length
    if (buf[dataStart] === 0x0d) dataStart += 1
    if (buf[dataStart] === 0x0a) dataStart += 1
    const dataEnd = buf.indexOf(endMarker, dataStart)
    if (dataEnd < 0) break

    // 往前找这段 stream 的字典，判断压缩方式
    const dictStart = Math.max(0, buf.lastIndexOf(Buffer.from('<<'), at))
    const dict = buf.toString('latin1', dictStart, at)

    let data = buf.subarray(dataStart, dataEnd)
    if (/\/FlateDecode/.test(dict)) {
      try {
        data = inflateSync(data, { finishFlush: zlibConstants.Z_SYNC_FLUSH })
      } catch {
        // 少数生成器写的 /Length 不准，尾部残留会让 inflate 报错；
        // 截到最后一个完整块再试一次，仍失败就跳过这段
        try {
          data = inflateSync(data.subarray(0, Math.floor(data.length / 2)), {
            finishFlush: zlibConstants.Z_SYNC_FLUSH,
          })
        } catch {
          pos = dataEnd + endMarker.length
          continue
        }
      }
    }
    out.push({ dict, data })
    pos = dataEnd + endMarker.length
  }
  return out
}

/** 把 <0041> 这类十六进制串读成码点。 */
function hexToCode(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  if (clean.length === 0) return null
  if (clean.length <= 2) return parseInt(clean, 16)
  return parseInt(clean, 16)
}

/** 从字节里按 2 字节大端读 CID（Identity-H 编码）。 */
function bytesToCids(raw) {
  const cids = []
  for (let i = 0; i + 1 < raw.length; i += 2) cids.push((raw[i] << 8) | raw[i + 1])
  if (raw.length % 2 === 1) cids.push(raw[raw.length - 1])
  return cids
}

/** 收集所有 ToUnicode CMap 的 cid -> 字符 映射（多个字体合并）。 */
function collectCMaps(streams) {
  const map = new Map()
  for (const { data } of streams) {
    const text = data.toString('latin1')
    if (!text.includes('beginbfchar') && !text.includes('beginbfrange')) continue

    for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        const cid = hexToCode(pair[1])
        const dst = pair[2]
        let ch = ''
        for (let i = 0; i + 4 <= dst.length; i += 4) ch += String.fromCharCode(parseInt(dst.slice(i, i + 4), 16))
        if (ch === '' && cid !== null) ch = String.fromCharCode(parseInt(dst, 16))
        if (cid !== null && ch !== '') map.set(cid, ch)
      }
    }

    for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      // 两种形态：<lo> <hi> <dst>  与  <lo> <hi> [<d1> <d2> ...]
      for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
        const lo = hexToCode(m[1])
        const hi = hexToCode(m[2])
        if (lo === null || hi === null || hi < lo || hi - lo > 0xffff) continue
        const dst = m[3]
        if (dst.startsWith('[')) {
          const items = [...dst.matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1])
          for (let i = 0; i <= hi - lo && i < items.length; i += 1) {
            map.set(lo + i, String.fromCharCode(parseInt(items[i], 16)))
          }
        } else {
          const base = hexToCode(dst.slice(1, -1))
          if (base === null) continue
          for (let i = 0; i <= hi - lo; i += 1) map.set(lo + i, String.fromCharCode(base + i))
        }
      }
    }
  }
  return map
}

/** 处理 PDF 字符串字面量里的转义。 */
function unescapePdfString(s) {
  const out = []
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (ch !== '\\') {
      out.push(ch)
      continue
    }
    const next = s[i + 1]
    if (next === undefined) break
    if (next === 'n') { out.push('\n'); i += 1 }
    else if (next === 'r') { out.push('\r'); i += 1 }
    else if (next === 't') { out.push('\t'); i += 1 }
    else if (next === 'b' || next === 'f') { i += 1 }
    else if (next === '(' || next === ')' || next === '\\') { out.push(next); i += 1 }
    else if (/[0-7]/.test(next)) {
      let oct = ''
      let k = i + 1
      while (k < s.length && oct.length < 3 && /[0-7]/.test(s[k])) {
        oct += s[k]
        k += 1
      }
      out.push(String.fromCharCode(parseInt(oct, 8)))
      i = k - 1
    } else { i += 1 }
  }
  return out.join('')
}

/** 把 `<0001><0002>` 这种连续多段 hex 字符串解码成文字。 */
function decodeHexRuns(src, cmap) {
  const bytes = []
  for (const seg of src.matchAll(/<([0-9a-fA-F\s]*)>/g)) {
    const hex = seg[1].replace(/\s+/g, '')
    for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  }
  if (bytes.length === 0) return ''
  if (cmap.size === 0) return Buffer.from(bytes).toString('latin1')
  let out = ''
  for (const cid of bytesToCids(Buffer.from(bytes))) {
    const ch = cmap.get(cid)
    if (ch !== undefined) out += ch
  }
  return out
}

/** 用一个内容流里的文本操作还原出文本行。 */
function extractFromContent(content, cmap) {
  const lines = []
  let current = ''

  const flush = () => {
    const t = current.replace(/[ \t]+$/g, '')
    lines.push(t)
    current = ''
  }

  // 逐段匹配文本操作符；按出现顺序消费，保证断行位置正确。
  // 注意：一个 Tj 的操作数可能是多个连写的 hex 段（<0004><0003><0001>Tj），
  // 只取最后一段会丢掉前面所有字，所以第一支必须贪婪吃掉整串。
  const tokenRe = /((?:<[0-9a-fA-F\s]*>\s*)+)Tj|\(((?:\\.|[^\\()])*)\)\s*Tj|\[((?:[^\[\]\\]|\\.)*)\]\s*TJ|T\*|(?:[-\d.]+\s+){2}Td|(?:[-\d.]+\s+){2}TD|'|"/g

  for (const m of content.matchAll(tokenRe)) {
    const tok = m[0]
    if (m[1] !== undefined) {
      current += decodeHexRuns(m[1], cmap)
    } else if (m[2] !== undefined) {
      current += unescapePdfString(m[2])
    } else if (m[3] !== undefined) {
      // TJ 数组：字符串片段之间可能有字距调整数字，负数大表示加空格
      for (const part of m[3].matchAll(/\(((?:\\.|[^\\()])*)\)|<([0-9a-fA-F\s]*)>|(-?\d+(?:\.\d+)?)/g)) {
        if (part[1] !== undefined) current += unescapePdfString(part[1])
        else if (part[2] !== undefined) current += decodeHexRuns(`<${part[2]}>`, cmap)
        else if (part[3] !== undefined && Number(part[3]) < -120) current += ' '
      }
    } else if (tok === 'T*' || tok === "'" || tok === '"') {
      flush()
    } else {
      // Td / TD：只在纵向位移非零时断行，横向移动是同行的字符间距
      const nums = tok.match(/-?\d+(?:\.\d+)?/g) ?? []
      if (nums.length >= 2 && Number(nums[1]) !== 0) flush()
    }
  }
  flush()
  return lines
}

/**
 * @param {Buffer} buf
 * @returns {{ text: string, hasTextLayer: boolean, reason?: string, lines: number }}
 */
export function parsePdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) throw new Error('不是有效的 PDF：内容太短')
  if (!buf.subarray(0, 1024).toString('latin1').includes('%PDF')) {
    throw new Error('不是有效的 PDF：缺少 %PDF 文件头')
  }
  if (/\/Encrypt\b/.test(buf.toString('latin1'))) {
    return { text: '', hasTextLayer: false, reason: 'PDF 已加密，无法抽取文本层', lines: 0 }
  }

  const streams = extractStreams(buf)
  if (streams.length === 0) {
    return { text: '', hasTextLayer: false, reason: 'PDF 内没有可解析的内容流', lines: 0 }
  }
  const cmap = collectCMaps(streams)

  const lines = []
  for (const { data } of streams) {
    const content = data.toString('latin1')
    // 只处理内容流：含文本对象标记的才算
    if (!/\bBT\b/.test(content)) continue
    lines.push(...extractFromContent(content, cmap))
  }

  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (text === '') {
    return {
      text: '',
      hasTextLayer: false,
      reason: 'PDF 没有文本层（可能是扫描件或纯图片页），需要先做 OCR 或另存为带文字的 PDF',
      lines: 0,
    }
  }
  return { text, hasTextLayer: true, lines: text.split('\n').length }
}
