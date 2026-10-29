/**
 * 数据填补验证：同键参考 / 格式标准化 / 无可靠依据 三条路径，
 * 以及「不自动覆盖」「可撤销」「留痕」三条硬规则。
 */
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const HOME = 'C:/Users/ASUS/Documents/deepseek-harness/default-workspace/kb-notebook/packages/kb-notebook/.testhome-fill'
process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })

const store = await import('../lib/store.mjs')
const { parseDocument } = await import('../lib/parsers.mjs')
const { chunkDocument } = await import('../lib/text.mjs')
const fill = await import('../lib/fill.mjs')

let pass = true
const check = (label, cond, extra = '') => {
  if (!cond) pass = false
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}

const db = store.openStore()
const database = store.createDatabase(db, { name: '填补测试库', description: '含缺口的价目表' })
const DB = database.id

const csv = `型号,名称,价格,库存,上市日期
A-100,标准版,199,120,2025-01-05
A-100,标准版,199,,2025-01-05
A-200,专业版,399,50,2025/3/8
A-300,企业版,1299,,2025-03-20`

const parsed = parseDocument({ name: '产品表.csv', text: csv })
const doc = store.upsertDocument(db, {
  dbid: DB,
  name: '产品表.csv',
  format: parsed.format,
  text: parsed.text,
  records: parsed.records,
  fields: parsed.fields,
  mode: 'overwrite',
})
store.insertChunks(db, { dbid: DB, docid: doc.docid, chunks: chunkDocument(parsed.text, {}) })
store.insertRecords(db, { dbid: DB, docid: doc.docid, records: parsed.records })

/* ---------------- 1. 缺口检测 ---------------- */
console.log('\n=== 1. 缺口检测 ===')
const gaps = fill.detectGaps(db, DB, {})
for (const g of gaps) console.log(`  [${g.issue}] 第 ${g.rowNo} 行「${g.field}」= ${JSON.stringify(g.value)}`)
check('检测到 2 个空值', gaps.filter((g) => g.issue === 'empty').length === 2)
check('检测到 1 个格式不一致', gaps.filter((g) => g.issue === 'format').length === 1, JSON.stringify(gaps.find((g) => g.issue === 'format')))

/* ---------------- 2. 生成建议（不动原数据） ---------------- */
console.log('\n=== 2. 生成建议 ===')
const before = db.prepare('SELECT cells FROM records WHERE docid = ? ORDER BY row_no').all(doc.docid).map((r) => r.cells)
const proposal = fill.proposeFixes(db, DB, {})
check('生成了 3 条建议', proposal.created === 3, JSON.stringify(proposal))
const after = db.prepare('SELECT cells FROM records WHERE docid = ? ORDER BY row_no').all(doc.docid).map((r) => r.cells)
check('原数据一字未动', JSON.stringify(before) === JSON.stringify(after))

const pending = fill.listSuggestions(db, { dbid: DB })
for (const s of pending) {
  console.log(`  第 ${s.rowNo} 行「${s.field}」 ${JSON.stringify(s.oldValue)} → ${JSON.stringify(s.newValue)}`)
  console.log(`    方法=${s.method}  状态=${s.status}`)
  console.log(`    依据=${s.basis}`)
}

const sameKey = pending.find((s) => s.field === '库存' && s.rowNo === 3)
check('A-100 缺库存：同键参考补出 120', sameKey?.method === 'same-key' && sameKey.newValue === '120', `${sameKey?.method}/${sameKey?.newValue}`)
check('同键依据写明了参考行号', /第 2 行/.test(sameKey?.basis ?? ''), sameKey?.basis)

const fmt = pending.find((s) => s.field === '上市日期')
check('2025/3/8 被识别为格式问题', fmt?.method === 'format', fmt?.method)
check('格式建议是 2025-03-08', fmt?.newValue === '2025-03-08', fmt?.newValue)
check('格式依据引用了原值', /2025\/3\/8/.test(fmt?.basis ?? ''), fmt?.basis)

const noBasis = pending.find((s) => s.field === '库存' && s.rowNo === 5)
check('A-300 缺库存：标记无可靠依据', noBasis?.status === 'unreliable' && noBasis.method === 'none', `${noBasis?.status}/${noBasis?.method}`)
check('无依据时不给假值', noBasis?.newValue === '', JSON.stringify(noBasis?.newValue))
check('无依据的依据说明写清了原因', /无可靠依据/.test(noBasis?.basis ?? ''), noBasis?.basis)

/* ---------------- 2.1 幂等：已有未处理建议不重复刷 ---------------- */
console.log('\n=== 2.1 幂等 ===')
const again = fill.proposeFixes(db, DB, {})
check('已有 pending/unreliable 的不重复生成', again.created === 0 && again.skipped === 3, JSON.stringify(again))

/* ---------------- 3. 无依据的不能采纳 ---------------- */
console.log('\n=== 3. 无依据不能采纳 ===')
let blocked = null
try {
  fill.decideSuggestion(db, noBasis.id, { accept: true })
} catch (err) {
  blocked = err
}
check('采纳无依据建议被拒', blocked !== null, blocked?.message)

/* ---------------- 4. 拒绝 ---------------- */
console.log('\n=== 4. 拒绝一条 ===')
const rejected = fill.decideSuggestion(db, fmt.id, { accept: false, operator: 'tester' })
check('拒绝后状态为 rejected', rejected.status === 'rejected')
check('拒绝记录了操作人', rejected.decidedBy === 'tester' && Boolean(rejected.decidedAt))
const stillOld = db.prepare('SELECT cells FROM records WHERE docid = ? AND row_no = 4').get(doc.docid)
check('拒绝不改变原数据', JSON.parse(stillOld.cells).上市日期 === '2025/3/8', JSON.parse(stillOld.cells).上市日期)

/* ---------------- 5. 采纳并写回 ---------------- */
console.log('\n=== 5. 采纳并写回 ===')
const accepted = fill.decideSuggestion(db, sameKey.id, { accept: true, operator: 'tester' })
check('采纳后状态为 accepted', accepted.status === 'accepted')
check('保留了原值（空）', accepted.oldValue === '')
const rec3 = JSON.parse(db.prepare('SELECT cells FROM records WHERE docid = ? AND row_no = 3').get(doc.docid).cells)
check('原记录已写入新值 120', rec3.库存 === '120', JSON.stringify(rec3))
const chunksAfter = db.prepare('SELECT text FROM chunks WHERE docid = ?').all(doc.docid).map((r) => r.text).join('\n')
check('文档正文已重建（检索能看到新值）', chunksAfter.includes('库存: 120'), chunksAfter.split('\n').find((l) => l.includes('[行 3]')))

/* ---------------- 6. 撤销 ---------------- */
console.log('\n=== 6. 撤销 ===')
const reverted = fill.revertSuggestion(db, sameKey.id, { operator: 'tester' })
check('撤销后状态为 reverted', reverted.status === 'reverted')
const rec3b = JSON.parse(db.prepare('SELECT cells FROM records WHERE docid = ? AND row_no = 3').get(doc.docid).cells)
check('撤销把原值写回去了', rec3b.库存 === '' || rec3b.库存 === undefined, JSON.stringify(rec3b.库存))
const chunksRevert = db.prepare('SELECT text FROM chunks WHERE docid = ?').all(doc.docid).map((r) => r.text).join('\n')
check('正文也回退了', !chunksRevert.split('\n').find((l) => l.startsWith('[行 3]'))?.includes('库存'), chunksRevert.split('\n').find((l) => l.startsWith('[行 3]')))

/* ---------------- 7. 留痕 ---------------- */
console.log('\n=== 7. 审计留痕 ===')
const entries = store.listAudit(db, { limit: 20, dbid: DB })
const actions = entries.map((e) => e.action)
check('有 fill.propose 记录', actions.includes('fill.propose'))
check('有 fill.accept 记录', actions.includes('fill.accept'))
check('有 fill.reject 记录', actions.includes('fill.reject'))
check('有 fill.revert 记录', actions.includes('fill.revert'))
const acceptEntry = entries.find((e) => e.action === 'fill.accept')
const detail = JSON.parse(acceptEntry.detail)
check('采纳日志含原值/新值/操作人', detail.oldValue === '' && detail.newValue === '120' && detail.operator === 'tester', JSON.stringify(detail))

/* ---------------- 8. 处理后允许重新评估 ---------------- */
console.log('\n=== 8. 处理后重新提议 ===')
const repropose = fill.proposeFixes(db, DB, {})
check('已处理的建议会重新评估（第 3 行仍空、日期仍不统一）', repropose.created >= 2, JSON.stringify(repropose))

store.closeStore()
rmSync(HOME, { recursive: true, force: true })

console.log('\n' + (pass ? 'ALL PASS' : 'HAS FAILURES'))
process.exit(pass ? 0 : 1)
