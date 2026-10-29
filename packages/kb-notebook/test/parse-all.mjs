/**
 * parseDocument 全格式端到端：文本类 + 二进制类都要给出正确的 text/records/fields。
 * 用的是 _probe 下的真实样本文件（openpyxl / python-docx / 手写 PDF 生成）。
 */
import { readFileSync } from 'node:fs'
import { parseDocument } from '../lib/parsers.mjs'

const BASE = 'C:/Users/ASUS/Documents/deepseek-harness/default-workspace/kb-notebook/_probe'

let pass = true
const check = (label, cond, extra = '') => {
  if (!cond) pass = false
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}
const asFile = (name) => ({ name, buffer: readFileSync(`${BASE}/${name}`) })

/* ---------------- 文本类 ---------------- */
const md = parseDocument({
  name: 'policy.md',
  text: '# 退货政策\n\n签收后 30 个工作日内可退货。\n\n生鲜品开封后不予退货。',
})
check('md：格式识别', md.format === 'markdown')
check('md：正文保留', md.text.includes('30 个工作日'))
check('md：无记录', md.records.length === 0)

const csv = parseDocument({
  name: 'price.csv',
  text: '型号,名称,价格,库存\nA-100,标准版,199,120\nA-200,专业版,399,\n',
})
check('csv：记录数', csv.records.length === 2, `${csv.records.length} 条`)
check('csv：字段类型推断', JSON.stringify(csv.fields.map((f) => `${f.name}:${f.type}`)) === JSON.stringify(['型号:string', '名称:string', '价格:integer', '库存:integer']), csv.fields.map((f) => `${f.name}:${f.type}`).join(','))
check('csv：空值统计', csv.fields.find((f) => f.name === '库存').empty === 1)
check('csv：行号写进正文', csv.text.includes('[行 2] 型号: A-100'))

const json = parseDocument({ name: 'a.json', text: JSON.stringify([{ k: 'v', n: 1 }, { k: 'w' }]) })
check('json：记录数', json.records.length === 2)
check('json：正文含记录', json.text.includes('[记录 1] k: v'))

let jsonlErr = null
try {
  parseDocument({ name: 'bad.jsonl', text: '{"a":1}\nnot json\n' })
} catch (err) {
  jsonlErr = err
}
check('jsonl：坏行报错并带行号', jsonlErr !== null && /第 2 行/.test(jsonlErr.message), jsonlErr?.message)

/* ---------------- 二进制类 ---------------- */
const xlsx = parseDocument(asFile('test.xlsx'))
check('xlsx：格式识别', xlsx.format === 'xlsx')
check('xlsx：多表记录合并', xlsx.records.length === 5, `${xlsx.records.length} 条（产品清单 3 + 售后条款 2）`)
check('xlsx：字段来自表头', xlsx.fields.map((f) => f.name).join('|') === '型号|名称|价格|库存|备注', xlsx.fields.map((f) => f.name).join('|'))
check('xlsx：价格推断为整数', xlsx.fields.find((f) => f.name === '价格')?.type === 'integer')
check('xlsx：正文带行号', xlsx.text.includes('[行 2] 型号: A-100'))
check('xlsx：记录带 sheet 名', xlsx.records.every((r) => typeof r.sheet === 'string'), xlsx.records[0]?.sheet)

const docx = parseDocument(asFile('test.docx'))
check('docx：格式识别', docx.format === 'docx')
check('docx：正文完整', docx.text.includes('入职满一年享有 5 天年假') && docx.text.includes('调休有效期为 3 个月'))

const pdf = parseDocument(asFile('plain.pdf'))
check('pdf：格式识别', pdf.format === 'pdf')
check('pdf：正文抽出', pdf.text.includes('Return Policy Handbook'))

const cnPdf = parseDocument(asFile('cid-cn.pdf'))
check('pdf：中文 PDF 正文', cnPdf.text.includes('退货政策') && cnPdf.text.includes('换货请联系客服'))

/* ---------------- 错误路径 ---------------- */
let noText = null
try {
  // 造一个只有图片、没有文本层的 PDF
  const imgOnly = Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Length 3 >>\nstream\nq Q\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
    'latin1',
  )
  parseDocument({ name: 'scan.pdf', buffer: imgOnly })
} catch (err) {
  noText = err
}
check('pdf：扫描件报 PDF_NO_TEXT_LAYER', noText?.code === 'PDF_NO_TEXT_LAYER', noText?.message)

let needBinary = null
try {
  parseDocument({ name: 'x.xlsx', text: 'fake text content' })
} catch (err) {
  needBinary = err
}
check('xlsx：缺字节时报 NEED_BINARY', needBinary?.code === 'NEED_BINARY', needBinary?.message)

let unsupported = null
try {
  parseDocument({ name: 'a.exe', text: 'MZ' })
} catch (err) {
  unsupported = err
}
check('未知格式报 UNSUPPORTED_FORMAT', unsupported?.code === 'UNSUPPORTED_FORMAT')
check('未知格式的提示里列出了支持的扩展名', /xlsx/.test(unsupported?.message ?? '') && /pdf/.test(unsupported?.message ?? ''))

/* ---------- 扩展名丢失时按魔数兜底 ---------- */
const noExt = parseDocument({ name: 'noext', buffer: readFileSync(`${BASE}/test.xlsx`) })
check('无扩展名：靠魔数认成 xlsx', noExt.format === 'xlsx', noExt.format)
const noExtPdf = parseDocument({ name: 'noext2', buffer: readFileSync(`${BASE}/plain.pdf`) })
check('无扩展名：靠魔数认成 pdf', noExtPdf.format === 'pdf', noExtPdf.format)

console.log('\n' + (pass ? 'ALL PASS' : 'HAS FAILURES'))
process.exit(pass ? 0 : 1)
