/** PDF 文本层抽取验证：plain / flate / 中文 CID 三条路径 + 扫描件与损坏文件的报错。 */
import { readFileSync } from 'node:fs'
import { parsePdf } from '../lib/pdf.mjs'

const BASE = 'C:/Users/ASUS/Documents/deepseek-harness/default-workspace/kb-notebook/_probe'

let pass = true
const check = (label, cond, extra = '') => {
  if (!cond) pass = false
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}

// --- 1. 未压缩 ASCII
const plain = parsePdf(readFileSync(`${BASE}/plain.pdf`))
check('plain：认出文本层', plain.hasTextLayer === true)
check('plain：标题正确', plain.text.includes('Return Policy Handbook'), JSON.stringify(plain.text.split('\n')[0]))
check('plain：正文三行都在', plain.text.includes('30 working days') && plain.text.includes('Fresh food'), '')
check('plain：第二段独立成行', plain.text.includes('Contact support for refund status.'))
console.log('\n--- plain.pdf ---\n' + plain.text.split('\n').map((l) => '  ' + l).join('\n'))

// --- 2. Flate 压缩
const fl = parsePdf(readFileSync(`${BASE}/flate.pdf`))
check('flate：解压出文本', fl.hasTextLayer === true)
check('flate：标题正确', fl.text.includes('Compressed PDF Test Document'))
check('flate：正文在', fl.text.includes('FlateDecode stream'))
check('flate：第三行在', fl.text.includes('Building 7'))
check('flate：独立段落断开了', fl.text.includes('Separate paragraph'))
console.log('\n--- flate.pdf ---\n' + fl.text.split('\n').map((l) => '  ' + l).join('\n'))

// --- 3. 中文 CID + ToUnicode
const cn = parsePdf(readFileSync(`${BASE}/cid-cn.pdf`))
check('cid：认出文本层', cn.hasTextLayer === true)
check('cid：标题还原为中文', cn.text.includes('退货政策'), JSON.stringify(cn.text.split('\n')[0]))
check('cid：含数字行还原正确', cn.text.includes('签收后三十天内可申请退款'))
check('cid：第三行还原正确', cn.text.includes('生鲜品一经开封不予退货'))
check('cid：第二段还原正确', cn.text.includes('换货请联系客服'))
check('cid：没有残留乱码', !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(cn.text), '')
console.log('\n--- cid-cn.pdf ---\n' + cn.text.split('\n').map((l) => '  ' + l).join('\n'))

// --- 4. 无文本层（模拟扫描件：只有图片 XObject，没有 BT/ET）
const imgOnly = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Length 5 >>\nstream\nq Q\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
  'latin1',
)
const scanned = parsePdf(imgOnly)
check('扫描件：不谎报有文本', scanned.hasTextLayer === false)
check('扫描件：给出可读原因', /OCR|文本层/.test(scanned.reason ?? ''), scanned.reason)

// --- 5. 损坏输入
try {
  parsePdf(Buffer.from('hello'))
  check('非 PDF 应报错', false)
} catch (err) {
  check('非 PDF 报错清晰', /PDF/.test(err.message), err.message)
}

// --- 6. 加密 PDF
const enc = Buffer.from('%PDF-1.4\n1 0 obj << /Encrypt 9 0 R >> endobj\n%%EOF\n', 'latin1')
const encrypted = parsePdf(enc)
check('加密 PDF：明确说明原因', encrypted.hasTextLayer === false && /加密/.test(encrypted.reason ?? ''), encrypted.reason)

console.log('\n' + (pass ? 'ALL PASS' : 'HAS FAILURES'))
process.exit(pass ? 0 : 1)
