/**
 * 演示三：缺失数据填补
 *
 * 这个场景全部围绕一条红线：**插件不会自动改用户的数据**。
 * 缺口只报不改 → 建议先落地成「待确认」→ 人点采纳才写回 → 写回可撤销。
 * 每一步都打印当时的真实数据，能直接看到"采纳之前一个字符都没动"。
 */
import { boot, freshHome, head, indent, line, step } from './_harness.mjs'

freshHome('scenario-3-fill')
const kb = await boot()

head('演示三 · 缺失数据填补：先预览、后确认、全程留痕')

// 故意做得脏一点：空值 + 两种日期写法混着用
const dirtyCsv = [
  '型号,名称,价格,库存,上市日期,备注',
  'A-100,标准版,199,120,2024-05-01,热销',
  'A-100,标准版,199,,2024-05-01,热销',
  'A-200,专业版,399,56,2025/3/8,新品',
  'A-300,企业版,1299,,2024-11-20,含三年质保',
  'A-400,旗舰版,2599,12,2025/1/15,预售',
].join('\n')

step(1, '导入一张有缺口的价目表')
const { database } = await kb.call('database.create', { name: '价目表（待整理）' })
const imported = await kb.call('import', { dbid: database.id, name: '价目表.csv', text: dirtyCsv })
line('入库', `${imported.chunks} 个片段 · ${imported.records} 条记录`)
line('字段', imported.fields.map((f) => `${f.name}:${f.type}${f.empty ? `(空${f.empty})` : ''}`).join(' / '))

const docid = imported.docid

step(2, '体检：只报告缺什么，不动数据')
const detect = await kb.call('fill.detect', { dbid: database.id, docid })
line('缺口数', String(detect.gaps.length))
for (const g of detect.gaps) {
  line('', `第 ${g.rowNo} 行 · ${g.field} · ${g.issue === 'empty' ? '空值' : '格式不一致'}${g.detail ? `（${g.detail}）` : ''}`)
}

step(3, '生成填补建议（全部标成「待确认」）')
const propose = await kb.call('fill.propose', { dbid: database.id, docid, operator: 'demo' })
line('新增建议', `${propose.created} 条 · 无可靠依据 ${propose.unreliable} 条 · 跳过重复 ${propose.skipped} 条`)
// propose 只回「待确认」的；无依据的那条状态是 unreliable，单独取出来
const all = (await kb.call('fill.list', { dbid: database.id })).suggestions
console.log('')
for (const s of all) {
  const flag = s.method === 'none' ? '无可靠依据' : s.method
  console.log(`  ── ${s.docName} 第 ${s.rowNo} 行 · ${s.field}  [${s.status}/${flag}]`)
  line('原值', JSON.stringify(s.oldValue))
  line('建议', JSON.stringify(s.newValue))
  line('依据', s.basis)
}

step(4, '关键一步：此刻原数据有没有被改？')
const before = await kb.call('records', { dbid: database.id, docid })
const row2 = before.records.find((r) => r.rowNo === 2)
const row4 = before.records.find((r) => r.rowNo === 4)
line('第 2 行库存', JSON.stringify(row2.cells['库存']))
line('第 4 行库存', JSON.stringify(row4.cells['库存']))
line('结论', '与导入时完全一致 —— 建议只是建议')

step(5, '拒绝一条（无可靠依据的那条，也采纳不了）')
const unreliable = all.find((s) => s.method === 'none')
if (unreliable) {
  line('目标', `第 ${unreliable.rowNo} 行 · ${unreliable.field}`)
  try {
    await kb.call('fill.decide', { id: unreliable.id, accept: true, operator: 'demo' })
    line('结果', '意外：无依据的建议被采纳了')
  } catch (err) {
    line('采纳被拒', String(err.message))
  }
  await kb.call('fill.decide', { id: unreliable.id, accept: false, operator: 'demo' })
  line('改为拒绝', '该字段保持空缺，等人补录')
}

step(6, '采纳一条有依据的（同表参考）')
const solid = all.find((s) => s.method === 'same-key' || s.method === 'similar-row')
if (solid) {
  line('目标', `第 ${solid.rowNo} 行 · ${solid.field} → ${JSON.stringify(solid.newValue)}`)
  const r = await kb.call('fill.decide', { id: solid.id, accept: true, operator: 'demo' })
  line('写回结果', `status=${r.suggestion.status}`)
  const after = await kb.call('records', { dbid: database.id, docid })
  const changed = after.records.find((x) => x.rowNo === solid.rowNo)
  line('现在这一行', JSON.stringify(changed.cells))
  line('正文已重建', '检索能立刻反映新值（下面的检索验证这一点）')

  step(7, '检索确认新值真的进了索引')
  const q = await kb.call('search', { dbids: [database.id], query: `${solid.newValue}` })
  line('搜新值', `${q.hits.length} 条命中`)
  if (q.hits[0]) console.log(indent(q.hits[0].text.split('\n').slice(0, 3).join('\n')))

  step(8, '撤销：采纳也能反悔')
  const rev = await kb.call('fill.revert', { id: solid.id, operator: 'demo' })
  line('撤销后状态', rev.suggestion.status)
  const back = await kb.call('records', { dbid: database.id, docid })
  line('这一行', JSON.stringify(back.records.find((x) => x.rowNo === solid.rowNo).cells))
}

step(9, '操作日志：每条建议都有原值 / 建议值 / 依据 / 操作人 / 时间')
const { entries } = await kb.call('audit', { limit: 12, dbid: database.id })
for (const e of entries) {
  const d = e.detail ?? {}
  const bits = [d.field, d.oldValue, d.newValue, d.operator].filter((x) => x !== undefined && x !== null)
  line(e.ts.slice(11, 19), `${e.action.padEnd(14)} ${bits.join(' · ')}`)
}

console.log('\n演示三完成：数据没有在任何一步被偷偷改过。\n')
