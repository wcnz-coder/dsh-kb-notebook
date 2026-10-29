/** 对比「宿主进程内的检索行为」与磁盘代码：判断宿主是否需要重载。 */
const base = 'http://127.0.0.1:56905/__kb'
const post = async (p, b) =>
  (await fetch(`${base}/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json()

const st = await (await fetch(`${base}/state?session=sess_probe`)).json()
const dbid = st.databases[0]?.id
console.log('库:', st.databases.map((d) => d.name).join(','), '| id:', dbid)

for (const q of ['退货', '退货要多久', '退货要多久才能退款', '无人机航拍参数']) {
  const r = await post('search', { dbids: [dbid], query: q, mode: 'strict' })
  console.log(
    `[${q}] kept=${r.hits?.length} insufficient=${r.insufficient} dropCov=${r.droppedByCoverage ?? 'n/a'} topCov=${r.topCoverage ?? 'n/a'}`,
  )
}
console.log('\n说明：dropCov / topCoverage 为 undefined 表示宿主内仍是旧代码（未重载）。')
