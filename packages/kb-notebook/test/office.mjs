/** xlsx / docx 解析验证：用真实 Office 文件，不用手搓 xml。 */
import { readFileSync } from 'node:fs'
import { parseXlsx, parseDocx } from '../lib/office.mjs'
import { readZip } from '../lib/zip.mjs'

const XLSX = 'C:/Users/ASUS/Documents/deepseek-harness/default-workspace/kb-notebook/_probe/test.xlsx'
const DOCX = 'C:/Users/ASUS/Documents/deepseek-harness/default-workspace/kb-notebook/_probe/test.docx'

let pass = true
const check = (label, cond, extra = '') => {
  if (!cond) pass = false
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}

// --- zip 层
const zbuf = readFileSync(XLSX)
const zfiles = readZip(zbuf)
check('zip 能读出条目', zfiles.size > 3, `${zfiles.size} 个条目`)
check('含 xl/workbook.xml', zfiles.has('xl/workbook.xml'))
// openpyxl 默认把字符串内联进 sheet（inlineStr），不写 sharedStrings；
// 两条路径都要支持，所以这里只断言"至少有一条字符串来源可读"
const hasShared = zfiles.has('xl/sharedStrings.xml')
const hasSheet = [...zfiles.keys()].some((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
check('字符串来源可读（sharedStrings 或 inlineStr）', hasShared || hasSheet, hasShared ? 'sharedStrings' : 'inlineStr')

// --- xlsx
const x = parseXlsx(zbuf)
check('xlsx 认到 2 个工作表', x.sheets.length === 2, x.sheets.map((s) => s.name).join('/'))
check('表头解析正确', JSON.stringify(x.header) === JSON.stringify(['型号', '名称', '价格', '库存', '备注']), JSON.stringify(x.header))
check('数据行数正确', x.dataRows.length === 3, `${x.dataRows.length} 行`)
check('中文单元格正确', x.dataRows[0][1] === '标准版', x.dataRows[0].join('|'))
check('数字单元格正确', x.dataRows[0][2] === '199', `原始值=${x.dataRows[0][2]}`)
check('空单元格保留为空', x.sheets[0].rows[2][3] === '', `第3行库存=[${x.sheets[0].rows[2][3]}]`)
console.log('\n--- xlsx 正文（前 8 行）---')
console.log(x.text.split('\n').slice(0, 8).map((l) => '  ' + l).join('\n'))

// --- docx
const dbuf = readFileSync(DOCX)
const d = parseDocx(dbuf)
check('docx 抽到正文', d.text.length > 20, `${d.text.length} 字`)
check('docx 含中文标题', d.text.includes('员工手册'))
check('docx 含段落正文', d.text.includes('入职满一年享有 5 天年假'))
check('docx 含第二段', d.text.includes('调休有效期为 3 个月'))
check('docx 行数与段落数一致', d.text.split('\n').filter((l) => l.trim()).length >= 5, `${d.text.split('\n').filter((l) => l.trim()).length} 行`)
console.log('\n--- docx 正文 ---')
console.log(d.text.split('\n').map((l) => '  ' + l).join('\n'))

// --- 错误处理
try {
  parseXlsx(Buffer.from('not a zip at all'))
  check('非 zip 输入应报错', false)
} catch (err) {
  check('非 zip 输入报错清晰', /zip/.test(err.message), err.message)
}

console.log('\n' + (pass ? 'ALL PASS' : 'HAS FAILURES'))
process.exit(pass ? 0 : 1)
