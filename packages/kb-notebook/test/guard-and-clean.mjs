/** 重载后验：访问闸 + 清理探测数据 + 建演示库。 */
const base = 'http://127.0.0.1:56905/__kb'
const post = async (p, b) =>
  (await fetch(`${base}/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json()
const get = async (p) => (await fetch(`${base}/${p}`)).json()

// 1. 访问闸：伪造 Host 应被拒
const spoof = await fetch(`${base}/state`, { headers: { host: 'evil.example.com' } })
console.log('伪造 Host → HTTP', spoof.status, spoof.status === 403 ? '(已拦截 PASS)' : '(未拦截 FAIL)')

// 2. 跨源 Origin 应被拒
const cross = await fetch(`${base}/state`, { headers: { origin: 'http://evil.example.com' } })
console.log('跨源 Origin → HTTP', cross.status, cross.status === 403 ? '(已拦截 PASS)' : '(未拦截 FAIL)')

// 3. 清掉之前探测造的库
const st = await get('state?session=')
for (const d of st.databases) {
  await post('database.delete', { id: d.id })
  console.log('已删除探测库:', d.name)
}

const before = await get('state?session=')
console.log('清理后剩余库数:', before.databases.length, before.databases.length === 0 ? '(PASS)' : '(FAIL)')
