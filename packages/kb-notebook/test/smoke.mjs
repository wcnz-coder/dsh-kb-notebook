/** 本地冒烟测试：不经宿主，直接跑存储 + 解析 + 检索三层。 */
process.env.DSH_HOME = process.env.KB_TEST_HOME || 'C:/Users/ASUS/Documents/deepseek-harness/default-workspace/kb-notebook/.testhome'

const { openStore, createDatabase, upsertDocument, insertChunks, insertRecords, listDatabases, setBindings, getBindings, audit, listAudit } = await import('../lib/store.mjs')
const { chunkDocument } = await import('../lib/text.mjs')
const { parseDocument } = await import('../lib/parsers.mjs')
const { SearchService, renderEvidence, renderInsufficient, checkCitations, DEFAULT_THRESHOLD } = await import('../lib/search.mjs')

const db = openStore()
const search = new SearchService(db)

// 清掉上一次测试残留，保证幂等
for (const d of listDatabases(db)) {
  db.prepare('DELETE FROM chunks WHERE dbid=?').run(d.id)
  db.prepare('DELETE FROM records WHERE dbid=?').run(d.id)
  db.prepare('DELETE FROM documents WHERE dbid=?').run(d.id)
  db.prepare('DELETE FROM databases WHERE id=?').run(d.id)
}

const productDb = createDatabase(db, { name: '产品手册', description: '售后政策', color: '#4c8dff' })
const hrDb = createDatabase(db, { name: '人事制度', description: '员工手册', color: '#7a5cff' })

const importText = (dbid, name, text) => {
  const parsed = parseDocument({ name, text })
  const chunks = chunkDocument(parsed.text, {})
  const doc = upsertDocument(db, { dbid, name, format: parsed.format, text: parsed.text, mode: 'overwrite' })
  insertChunks(db, { dbid, docid: doc.docid, chunks })
  if (parsed.records.length > 0) insertRecords(db, { dbid, docid: doc.docid, records: parsed.records })
  search.invalidate(dbid)
  return { doc, chunks, parsed }
}

const r1 = importText(productDb.id, '售后政策.md', `# 售后政策

## 退货

自签收之日起 30 个工作日内，凭订单号可申请退货。生鲜类商品不支持退货。

## 退款

退款按原路返回，通常 3-5 个工作日到账。超时未到账请联系客服 400-800-1234。

## 换货

换货需保证包装完整，7 个工作日内寄回。
`)

const r2 = importText(hrDb.id, '员工手册.md', `# 员工手册

## 年假

入职满一年享有 5 天年假，每满一年递增 1 天，上限 15 天。

## 调休

加班可申请调休，调休有效期为 3 个月。
`)

const r3 = importText(productDb.id, '价目表.csv', `型号,名称,价格,库存
A-100,标准版,199,120
A-200,专业版,399,
A-300,企业版,1299,8
`)

console.log('=== 导入结果 ===')
console.log('  售后政策.md →', r1.chunks.length, '块')
console.log('  员工手册.md →', r2.chunks.length, '块')
console.log('  价目表.csv →', r3.chunks.length, '块,', r3.parsed.records.length, '记录; 字段推断:', JSON.stringify(r3.parsed.fields))
console.log('  CSV 正文首段:\n' + r3.parsed.text.split('\n').slice(0, 5).map((l) => '    ' + l).join('\n'))

// 中文两字词是这次的关键验证点
const cases = [
  ['退货', [productDb.id], true],
  ['退款', [productDb.id], true],
  ['年假', [hrDb.id], true],
  ['换货', [productDb.id], true],
  ['无人机航拍', [productDb.id], false],
]

console.log('\n=== 检索（阈值', DEFAULT_THRESHOLD, '）===')
let pass = true
for (const [q, scope, expectHit] of cases) {
  const res = search.search({ dbids: scope, query: q, limit: 5, threshold: 0 })
  const ok = (res.hits.length > 0) === expectHit
  if (!ok) pass = false
  console.log(`  ${ok ? 'PASS' : 'FAIL'} "${q}" → ${res.hits.length} 命中${res.hits[0] ? ` (top: ${res.hits[0].docName} L${res.hits[0].startLine}-${res.hits[0].endLine}, rel=${res.hits[0].relevance.toFixed(2)})` : ''}`)
}

// 跨库隔离：查"年假"限定产品库，不应拿到人事库内容
const leak = search.search({ dbids: [productDb.id], query: '年假', limit: 5, threshold: 0 })
const leaked = leak.hits.filter((h) => h.dbid !== productDb.id)
console.log(`\n=== 跨库隔离 ===\n  ${leaked.length === 0 ? 'PASS' : 'FAIL'} 产品库检索"年假"未串入人事库 (${leak.hits.length} 命中)`)
if (leaked.length > 0) pass = false

// 严格模式阈值：无关问题应判 insufficient
const strict = search.search({ dbids: [productDb.id, hrDb.id], query: '无人机航拍', limit: 5, threshold: DEFAULT_THRESHOLD })
console.log(`  ${strict.insufficient ? 'PASS' : 'FAIL'} 无关问题判为"依据不足" (topRelevance=${strict.topRelevance?.toFixed(2)}, kept=${strict.hits.length})`)
if (!strict.insufficient) pass = false

// 证据块渲染
const good = search.search({ dbids: [productDb.id], query: '退款多久到账', limit: 3, threshold: 0.2 })
console.log('\n=== 证据块（截取前 12 行）===')
console.log(renderEvidence(good.hits, { strict: true }).split('\n').slice(0, 12).map((l) => '  ' + l).join('\n'))

// 引用体检
const answer = '退款按原路返回，通常 3-5 个工作日到账 [K1]。若超时请联系客服 [K9]。'
const check = checkCitations(answer, good.hits)
console.log('\n=== 引用体检 ===')
console.log('  使用:', check.used, '悬空(编造出处):', check.dangling, '缺引用:', check.missing)
const citeOk = check.dangling.length === 1 && check.missing === false
if (!citeOk) pass = false
console.log(`  ${citeOk ? 'PASS' : 'FAIL'} 正确识别出 [K9] 为编造出处`)

// 无依据话术
console.log('\n=== 无依据提示 ===')
console.log(renderInsufficient({ query: '无人机航拍', dbNames: ['产品手册', '人事制度'] }).split('\n').slice(0, 3).map((l) => '  ' + l).join('\n'))

// 绑定与审计
setBindings(db, 'sess_test', [productDb.id, hrDb.id], 'strict')
const binds = getBindings(db, 'sess_test')
console.log('\n=== 绑定 ===')
console.log('  ', binds.map((b) => `${b.name}(${b.mode})`).join(', '))
const auditRows = listAudit(db, { limit: 6 })
console.log('  审计最近 6 条:', auditRows.map((a) => a.action).join(' → '))

console.log('\n=== 总计 ===')
console.log(pass ? 'ALL PASS' : 'HAS FAILURES')
