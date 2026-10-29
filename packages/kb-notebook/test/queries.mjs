/** 长问句召回形态验证：真实用户不会只输入两个字的词。 */
process.env.DSH_HOME = 'C:/Users/ASUS/Documents/deepseek-harness/default-workspace/kb-notebook/.testhome'

const { openStore, listDatabases } = await import('../lib/store.mjs')
const { SearchService, DEFAULT_THRESHOLD } = await import('../lib/search.mjs')

const db = openStore()
const search = new SearchService(db)
const all = listDatabases(db)
const ids = all.map((d) => d.id)

console.log('库:', all.map((d) => d.name).join(' / '))

const cases = [
  ['退货', true],
  ['退货要多久', true],
  ['退货要多久才能退款', true],
  ['生鲜可以退货吗', true],
  ['退款什么时候到账', true],
  ['年假有几天', true],
  ['加班能调休吗', true],
  ['A-200 多少钱', true],
  ['无人机航拍参数', false],
  ['今天天气怎么样', false],
  ['公司股票代码', false],
]

let pass = true
for (const [q, expect] of cases) {
  const r = search.search({ dbids: ids, query: q, limit: 5, threshold: DEFAULT_THRESHOLD })
  const ok = r.insufficient === !expect
  if (!ok) pass = false
  const top = r.hits[0]
  const detail = top
    ? `${top.docName} L${top.startLine}-${top.endLine} rel=${top.relevance.toFixed(2)} cov=${(top.coverage ?? 0).toFixed(2)}`
    : '—'
  console.log(
    `${ok ? 'PASS' : 'FAIL'} [${q}] kept=${r.hits.length} top=${detail} dropTh=${r.droppedBelowThreshold} dropCov=${r.droppedByCoverage}`,
  )
}
console.log(pass ? 'ALL PASS' : 'HAS FAILURES')
