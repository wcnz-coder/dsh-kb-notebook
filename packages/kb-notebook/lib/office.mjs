/**
 * Office 二进制解析（xlsx / docx）。
 *
 * 只做"把表格和正文读成文本"，不做样式、公式计算、图片。
 * 表格按行输出，每行带 [行 N] 前缀，这样后续检索到的片段能回指到 Excel 行号；
 * Word 按段落输出，每段记一行，行号同样可回溯。
 */
import { readZip, unescapeXml } from './zip.mjs'

/* ------------------------------------------------------------------ xlsx */

/** 读 sharedStrings.xml：一维字符串表，单元格用索引引用它。 */
function readSharedStrings(files) {
  const xml = files.get('xl/sharedStrings.xml')
  if (!xml) return []
  const text = xml.toString('utf8')
  const out = []
  // 每个 <si> 是一格；富文本会有多个 <t>，拼起来
  for (const si of text.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const parts = [...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]))
    out.push(parts.join(''))
  }
  return out
}

/** 列号字母转 0 基索引：A→0, Z→25, AA→26。 */
function colIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? ''
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** 找出所有工作表文件，按 sheet1..N 自然序。 */
function sheetPaths(files) {
  return [...files.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]))
}

/** 读 workbook.xml 里的工作表名，用来给多个 sheet 加标题。 */
function sheetNames(files) {
  const xml = files.get('xl/workbook.xml')
  if (!xml) return []
  return [...xml.toString('utf8').matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map((m) => unescapeXml(m[1]))
}

/**
 * @returns {{ rows: string[][], sheets: {name: string, rows: string[][]}[], text: string }}
 */
export function parseXlsx(buf) {
  const files = readZip(buf)
  const shared = readSharedStrings(files)
  const paths = sheetPaths(files)
  if (paths.length === 0) throw new Error('xlsx 里没有工作表')
  const names = sheetNames(files)

  const sheets = []
  for (let i = 0; i < paths.length; i += 1) {
    const xml = files.get(paths[i]).toString('utf8')
    const rows = []
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = []
      let maxCol = -1
      for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cellMatch[1]
        const body = cellMatch[2]
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1]
        const type = /t="([^"]+)"/.exec(attrs)?.[1]
        const idx = ref ? colIndex(ref) : cells.length
        let value = ''
        if (type === 's') {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)
          value = v ? (shared[Number(v[1])] ?? '') : ''
        } else if (type === 'inlineStr') {
          value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('')
        } else if (type === 'str') {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)
          value = v ? unescapeXml(v[1]) : ''
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)
          value = v ? unescapeXml(v[1]) : ''
        }
        while (cells.length < idx) cells.push('')
        cells[idx] = value
        if (idx > maxCol) maxCol = idx
      }
      if (cells.length > 0) rows.push(cells)
    }
    sheets.push({ name: names[i] ?? `Sheet${i + 1}`, rows })
  }

  // 多 sheet 时输出小节标题，让检索片段能标出属于哪张表
  const lines = []
  for (const s of sheets) {
    if (sheets.length > 1) lines.push(`# ${s.name}`)
    else lines.push(`# ${s.name}`)
    if (s.rows.length === 0) continue
    const header = s.rows[0]
    lines.push(`字段：${header.map((h) => h || '(空)').join(' | ')}`)
    for (let r = 1; r < s.rows.length; r += 1) {
      const row = s.rows[r]
      const pairs = []
      for (let c = 0; c < Math.max(header.length, row.length); c += 1) {
        const key = header[c] || `列${c + 1}`
        const val = row[c]
        if (val !== undefined && val !== '') pairs.push(`${key}: ${val}`)
      }
      if (pairs.length > 0) lines.push(`[行 ${r + 1}] ${pairs.join('；')}`)
    }
  }

  const first = sheets[0].rows
  return {
    rows: first,
    sheets,
    // 第一个 sheet 的首行当表头，供字段映射与结构化入库
    header: first[0] ?? [],
    dataRows: first.slice(1),
    text: lines.join('\n'),
  }
}

/* ------------------------------------------------------------------ docx */

/** 段落切分：<w:p> 之间按段落，段内 <w:t> 拼文本，<w:br/> 转换行。 */
export function parseDocx(buf) {
  const files = readZip(buf)
  const doc = files.get('word/document.xml')
  if (!doc) throw new Error('docx 里找不到 word/document.xml（文件可能已损坏或是旧版 .doc）')
  let xml = doc.toString('utf8')

  // 表格单元格先转成制表符分隔，免得整张表挤成一行
  xml = xml.replace(/<\/w:tc>/g, '\t').replace(/<\/w:tr>/g, '\n')

  const lines = []
  for (const p of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const seg = p[1]
    let text = ''
    for (const m of seg.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:br\s*\/>|<w:tab\s*\/>/g)) {
      if (m[1] !== undefined) text += unescapeXml(m[1])
      else if (m[0].startsWith('<w:br')) text += '\n'
      else text += '\t'
    }
    lines.push(text.replace(/[ \t]+$/g, ''))
  }

  // 样式信息里能读到大纲级别，标题层级拿不到就按空行分段，不给假层级
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (body === '') throw new Error('docx 正文为空')
  return { text: body }
}

/* ------------------------------------------------------------- 自动分派 */

export function isZipBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length > 4 && buf.readUInt32LE(0) === LOCAL_SIG_ZIP
}

const LOCAL_SIG_ZIP = 0x04034b50
