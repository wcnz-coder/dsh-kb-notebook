/**
 * 解析层：把上传的文件变成 { format, text, records, fields }。
 * text 用于切块与检索；records/fields 供结构化层（字段映射、类型识别、数据填补）。
 *
 * 覆盖：Markdown / 纯文本 / CSV / TSV / JSON / JSONL / YAML / Excel / Word / PDF。
 * 二进制格式（xlsx/docx/pdf）全部自行解包，不依赖 pandoc、libreoffice 或任何 npm 包。
 */
import { parseXlsx, parseDocx, isZipBuffer } from './office.mjs'
import { parsePdf } from './pdf.mjs'

const CSV_DELIMS = [',', ';', '\t', '|']

/** 极简 RFC4180 CSV 解析：支持引号包裹、双引号转义、字段内换行。 */
export function parseCsv(input, delimiter) {
  const text = String(input ?? '').replace(/^\uFEFF/, '')
  const delim = delimiter ?? guessDelimiter(text)
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') {
      quoted = true
      continue
    }
    if (ch === delim) {
      row.push(field)
      field = ''
      continue
    }
    if (ch === '\r') continue
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''))
}

function guessDelimiter(text) {
  const head = text.split(/\r?\n/).slice(0, 5).join('\n')
  let best = ','
  let bestScore = -1
  for (const d of CSV_DELIMS) {
    const counts = head.split(/\r?\n/).map((l) => l.split(d).length - 1)
    const score = counts.length > 0 ? Math.min(...counts) : 0
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

/** 字段类型推断：number / integer / date / boolean / string。用于结构化层的类型识别。 */
export function inferType(values) {
  const sample = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '').slice(0, 200)
  if (sample.length === 0) return 'string'
  const isInt = sample.every((v) => /^-?\d+$/.test(String(v).trim()))
  if (isInt) return 'integer'
  const isNum = sample.every((v) => /^-?\d*\.?\d+$/.test(String(v).trim()))
  if (isNum) return 'number'
  const isBool = sample.every((v) => /^(true|false|yes|no|y|n|是|否)$/i.test(String(v).trim()))
  if (isBool) return 'boolean'
  const isDate = sample.every((v) => /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?([ T]\d{1,2}:\d{2}(:\d{2})?)?$/.test(String(v).trim()))
  if (isDate) return 'date'
  return 'string'
}

/** 表格 → 记录 + 文本。文本按「行号 + 字段: 值」形式，便于检索后精确定位到行。 */
function tabularToDocument(rows, { name, delimiter }) {
  if (rows.length === 0) return { format: 'csv', text: '', records: [], fields: [] }
  const header = rows[0].map((h, i) => String(h).trim() || `column_${i + 1}`)
  const records = []
  const textLines = [`# ${name}`, '', `字段：${header.join(' | ')}`, '']
  for (let i = 1; i < rows.length; i += 1) {
    const cells = {}
    const parts = []
    for (let c = 0; c < header.length; c += 1) {
      const value = rows[i][c] ?? ''
      cells[header[c]] = value
      if (String(value).trim() !== '') parts.push(`${header[c]}: ${value}`)
    }
    records.push({ rowNo: i + 1, cells })
    // 行号写进正文，切块后 locator 能把引用精确指回「第几行」
    textLines.push(`[行 ${i + 1}] ${parts.join('；')}`)
  }
  const fields = header.map((h) => ({
    name: h,
    type: inferType(records.map((r) => r.cells[h])),
    empty: records.filter((r) => String(r.cells[h] ?? '').trim() === '').length,
  }))
  return { format: 'csv', delimiter, text: textLines.join('\n'), records, fields }
}

function jsonToDocument(data, { name }) {
  const list = Array.isArray(data) ? data : [data]
  const records = []
  const lines = [`# ${name}`, '']
  list.forEach((item, i) => {
    records.push({ rowNo: i + 1, cells: item && typeof item === 'object' ? item : { value: item } })
    lines.push(`[记录 ${i + 1}] ${flattenToText(item)}`)
  })
  const keys = new Set()
  for (const r of records) {
    if (r.cells && typeof r.cells === 'object') for (const k of Object.keys(r.cells)) keys.add(k)
  }
  const fields = [...keys].map((k) => ({
    name: k,
    type: inferType(records.map((r) => r.cells?.[k])),
    empty: records.filter((r) => String(r.cells?.[k] ?? '').trim() === '').length,
  }))
  return { format: 'json', text: lines.join('\n'), records, fields }
}

function flattenToText(value, prefix = '') {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'object') return `${prefix ? `${prefix}: ` : ''}${String(value)}`
  if (Array.isArray(value)) return value.map((v) => flattenToText(v, prefix)).filter(Boolean).join('；')
  return Object.entries(value)
    .map(([k, v]) => flattenToText(v, prefix ? `${prefix}.${k}` : k))
    .filter(Boolean)
    .join('；')
}

/** 纯文本 / Markdown：原样作为正文。 */
function plainToDocument(text, { name, format }) {
  const records = []
  const fields = []
  return { format, text: `# ${name}\n\n${text}`, records, fields }
}

/** xlsx → 文本 + 结构化记录。第一个 sheet 的表头同时作为字段定义来源。 */
function xlsxToDocument(parsed, { name }) {
  const records = []
  let fields = []
  parsed.sheets.forEach((sheet, si) => {
    const header = sheet.rows[0] ?? []
    if (si === 0) {
      fields = header.map((h, i) => {
        const col = h || `列${i + 1}`
        const values = sheet.rows.slice(1).map((r) => r[i])
        return {
          name: col,
          type: inferType(values),
          empty: values.filter((v) => String(v ?? '').trim() === '').length,
        }
      })
    }
    for (let r = 1; r < sheet.rows.length; r += 1) {
      const cells = {}
      sheet.rows[r].forEach((v, c) => {
        cells[header[c] || `列${c + 1}`] = v ?? ''
      })
      records.push({ rowNo: r + 1, cells, sheet: sheet.name })
    }
  })
  return { format: 'xlsx', text: parsed.text || `# ${name}\n`, records, fields }
}

/** pdf → 文本。没有文本层时抛出带原因的错误，而不是入库一篇空文档。 */
function pdfToDocument(parsed, { name }) {
  if (!parsed.hasTextLayer) {
    const err = new Error(parsed.reason ?? 'PDF 没有可抽取的文本层')
    err.code = 'PDF_NO_TEXT_LAYER'
    throw err
  }
  return { format: 'pdf', text: `# ${name}\n\n${parsed.text}`, records: [], fields: [], lines: parsed.lines }
}

/**
 * 主入口。
 * 二进制格式（xlsx/docx/pdf）必须有 buffer —— 把字节当 utf8 字符串传进来会损坏内容。
 * @param {{ name: string, text?: string, buffer?: Buffer|Uint8Array }} file
 */
export function parseDocument(file) {
  const name = file.name ?? 'untitled'
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  const buf = file.buffer ? Buffer.from(file.buffer) : null
  const raw = file.text ?? (buf ? buf.toString('utf8') : '')

  /* --- 二进制格式：先按扩展名，再按魔数兜底 --- */
  const wantXlsx = ext === 'xlsx' || ext === 'xlsm'
  const wantDocx = ext === 'docx'
  const wantPdf = ext === 'pdf'

  if (wantXlsx || wantDocx || wantPdf) {
    if (!buf) {
      const err = new Error(`.${ext} 是二进制格式，必须提供原始字节（buffer），不能按文本读取`)
      err.code = 'NEED_BINARY'
      throw err
    }
    if (wantXlsx) return xlsxToDocument(parseXlsx(buf), { name })
    if (wantDocx) {
      const d = parseDocx(buf)
      return { format: 'docx', text: `# ${name}\n\n${d.text}`, records: [], fields: [] }
    }
    return pdfToDocument(parsePdf(buf), { name })
  }

  // 扩展名丢了或写错时，用文件头兜底识别
  if (buf && buf.length > 8) {
    if (isZipBuffer(buf)) {
      const entries = buf.toString('latin1')
      // docx 的 word/ 与 xlsx 的 xl/ 是目录名，会以明文出现在中央目录里
      if (entries.includes('word/document.xml')) {
        const d = parseDocx(buf)
        return { format: 'docx', text: `# ${name}\n\n${d.text}`, records: [], fields: [] }
      }
      if (entries.includes('xl/workbook.xml')) return xlsxToDocument(parseXlsx(buf), { name })
    }
    if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return pdfToDocument(parsePdf(buf), { name })
  }

  if (['csv', 'tsv', 'txt', 'md', 'markdown', 'json', 'jsonl', 'ndjson', 'yml', 'yaml'].includes(ext)) {
    if (ext === 'json') {
      let data
      try {
        data = JSON.parse(raw)
      } catch (err) {
        throw new Error(`JSON 解析失败：${err.message}`)
      }
      return jsonToDocument(data, { name })
    }
    if (ext === 'jsonl' || ext === 'ndjson') {
      const items = []
      const bad = []
      raw.split(/\r?\n/).forEach((line, i) => {
        const t = line.trim()
        if (t === '') return
        try {
          items.push(JSON.parse(t))
        } catch (err) {
          bad.push({ line: i + 1, reason: err.message })
        }
      })
      if (bad.length > 0) {
        const err = new Error(`${bad.length} 行 JSON 无法解析（首个在第 ${bad[0].line} 行：${bad[0].reason}）`)
        err.details = bad
        throw err
      }
      return jsonToDocument(items, { name })
    }
    if (ext === 'csv' || ext === 'tsv') {
      return tabularToDocument(parseCsv(raw, ext === 'tsv' ? '\t' : undefined), { name })
    }
    if (ext === 'yml' || ext === 'yaml') {
      // YAML 只做「键: 值」级展平，不引第三方解析器
      return plainToDocument(raw, { name, format: 'yaml' })
    }
    return plainToDocument(raw, { name, format: ext === 'md' || ext === 'markdown' ? 'markdown' : 'text' })
  }

  const err = new Error(
    `暂不支持的文件类型 .${ext || '(无扩展名)'}。支持：md / markdown / txt / csv / tsv / json / jsonl / yml / yaml / xlsx / xlsm / docx / pdf。`,
  )
  err.code = 'UNSUPPORTED_FORMAT'
  throw err
}
