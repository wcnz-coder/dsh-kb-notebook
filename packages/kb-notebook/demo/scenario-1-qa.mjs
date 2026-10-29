/**
 * 演示一：知识问答（严格引用，无依据就明说）
 *
 * 走一遍真实链路：建库 → 导入三份资料 → 绑定到会话 → 连续提五个问题。
 * 每个问题都打印「真正被塞进模型上下文的那段证据」，
 * 这样「回答到底有没有依据」不是嘴上说的，而是看得见的。
 */
import { boot, freshHome, head, indent, line, sample, step } from './_harness.mjs'

freshHome('scenario-1-qa')
const kb = await boot()

head('演示一 · 知识问答：严格依据选中知识库')

step(1, '建库并导入资料')
const { database } = await kb.call('database.create', {
  name: '售后知识库',
  description: '售后政策、员工手册、产品价目',
  color: '#7c5cff',
})
line('知识库', `${database.name}（${database.id}）`)

for (const file of ['售后政策.md', '员工手册.md', '价目表.csv']) {
  const r = await kb.call('import', { dbid: database.id, name: file, text: sample(file) })
  line(`导入 ${file}`, `${r.chunks} 个片段 · ${r.records ?? 0} 条结构化记录`)
}

step(2, '新建对话并绑定这个库')
const sessionId = 'sess_demo_qa'
const bind = await kb.call('bind', { session: sessionId, dbids: [database.id], mode: 'strict' })
line('绑定结果', `已绑定 ${bind.bound.length} 个库 · 严格模式`)
line('范围提示', bind.notice ?? '（首次绑定，无变化提示）')

step(3, '严格模式的模型参数')
const cfg = await kb.requestConfig(sessionId, { provider: 'deepseek', model: 'chat', temperature: 0.9 })
line('请求温度', `${cfg.temperature}（原 0.9，严格模式下被压到 ≤0.2）`)

step(4, '连续提问：有依据 / 没依据，各走各的路')

const questions = [
  '退货要多久',
  '退款什么时候到账',
  '年假有几天',
  'A-200 多少钱',
  '无人机航拍参数是多少',
  '今天天气怎么样',
]

for (const [i, q] of questions.entries()) {
  const { injected } = await kb.ask(sessionId, q, { turn: i + 1 })
  const state = await kb.call('state', undefined, { url: `/__kb/state?session=${encodeURIComponent(sessionId)}`, method: 'GET' })
  const ev = state.lastEvidence
  const cites = injected.match(/\[K\d+\]\s+知识库[^\n]*/g) ?? []
  console.log(`\n  ── 问：${q}`)
  if (ev.insufficient) {
    line('结论', '当前所选数据库中未找到足够依据')
    line('原因', `最高相关度 ${ev.topRelevance.toFixed(2)}（阈值 ${ev.threshold}）`)
    indent(injected.split('\n').slice(0, 5).join('\n'))
  } else {
    line('命中', `${ev.hits.length} 条`)
    for (const c of cites) console.log(`      ${c}`)
  }
}

step(5, '展开一条引用的原文（用户点开引用看到的）')
const last = await kb.call('search', { dbids: [database.id], query: '退款什么时候到账' })
const top = last.hits[0]
const chunk = (await kb.call('chunk', { chunkId: top.chunkId })).chunk
line('定位', `${chunk.dbName} / ${chunk.docName} / 第 ${chunk.startLine}-${chunk.endLine} 行 / 小节「${chunk.section}」`)
console.log(indent(chunk.text))

step(6, '跨库隔离：换一个空库，同样的问题查不到任何东西')
const { database: emptyDb } = await kb.call('database.create', { name: '空白库' })
const isolated = await kb.call('search', { dbids: [emptyDb.id], query: '退货要多久' })
line('空库检索', `${isolated.hits.length} 条命中 · insufficient=${isolated.insufficient}`)

step(7, '审计日志：每一次检索都留痕')
const { entries } = await kb.call('audit', { limit: 6 })
for (const e of entries) {
  line(e.ts.slice(11, 19), `${e.action.padEnd(10)} ${e.detail ? JSON.stringify(e.detail).slice(0, 90) : ''}`)
}

console.log('\n演示一完成。\n')
