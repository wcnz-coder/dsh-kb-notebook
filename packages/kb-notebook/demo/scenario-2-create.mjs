/**
 * 演示二：基于库的创作
 *
 * 重点是"创作也不能脱离库"。同一句创作请求，喂给模型的东西只有
 * <kb-evidence> 里的原文；库里没有的题材会被明确挡回来。
 *
 * 另外演示：宽严两个模式对同一问题的差别、以及「回答存成笔记并带来源」。
 */
import { boot, freshHome, head, indent, line, sample, step } from './_harness.mjs'

freshHome('scenario-2-create')
const kb = await boot()

head('演示二 · 基于库的创作：改写 / 提纲 / 报告，全部落在证据上')

step(1, '准备素材')
const { database } = await kb.call('database.create', {
  name: '产品资料库',
  description: '对外发布用的产品与政策原文',
})
for (const file of ['售后政策.md', '价目表.csv']) {
  const r = await kb.call('import', { dbid: database.id, name: file, text: sample(file) })
  line(file, `${r.chunks} 片段 · 字段 ${(r.fields ?? []).map((f) => `${f.name}:${f.type}`).join(' / ') || '—'}`)
}

const sessionId = 'sess_demo_create'
await kb.call('bind', { session: sessionId, dbids: [database.id], mode: 'strict' })
line('会话绑定', '产品资料库 · 严格模式')

step(2, '创作请求一：把退货政策改写成给客户看的口吻')
{
  const { injected } = await kb.ask(sessionId, '把退货政策改写成给客户看的说明，口吻友好一点', { turn: 1 })
  line('注入证据', `${(injected.match(/\[K\d+\]/g) ?? []).length} 条片段`)
  line('证据来源', '只来自「售后政策.md」，模型没有可自由发挥的题材')
  const rule = injected.split('<kb-rule>')[1] ?? ''
  console.log('\n  ── 本轮下发的硬规则 ──')
  console.log(indent(rule.replace('</kb-rule>', '').trim(), '      '))
}

step(3, '创作请求二：库里没有的题材，必须挡回来')
{
  const { injected } = await kb.ask(sessionId, '写一篇关于我们公司无人机航拍能力的宣传稿', { turn: 2 })
  const blocked = injected.includes('未找到足够依据')
  line('结果', blocked ? '判定无足够依据（不会编造产品参数）' : '意外命中')
  console.log('\n  ── 下发给模型的原文 ──')
  console.log(indent(injected.trim(), '      '))
}

step(4, '创作请求三：写提纲（多片段组合）')
{
  const { injected } = await kb.ask(sessionId, '给客服团队写一份退换货处理提纲', { turn: 3 })
  const marks = injected.match(/\[K\d+\]\s+知识库[^\n]*/g) ?? []
  line('可用片段', `${marks.length} 条`)
  for (const m of marks) console.log(`      ${m}`)
}

step(5, '严格 vs 宽松：同一句问句的差别')
{
  const strict = await kb.call('search', { dbids: [database.id], query: '质保和库存', mode: 'strict' })
  const loose = await kb.call('search', { dbids: [database.id], query: '质保和库存', mode: 'loose' })
  line('严格模式', `${strict.hits.length} 条（阈值 ${strict.threshold}，相关度闸 + 覆盖度闸都开）`)
  line('宽松模式', `${loose.hits.length} 条（阈值 ${loose.threshold}，只按相关度排序取前 N）`)
}

step(6, '把这次创作的回答存成笔记（带来源）')
{
  // 真实场景里这段文本来自 assistant/message，这里直接给一段模拟回答
  const answer = '退货说明：签收后 30 个工作日内可申请退货…（模型基于 [K1] 改写）'
  const note = await kb.call('notes.save', {
    session: sessionId,
    dbid: database.id,
    title: '退货政策·客户版改写',
    body: answer,
  })
  line('笔记', `${note.note.title}（${note.note.body.length} 字）`)
  line('来源引用', `${note.note.citations.length} 条`)
  for (const c of note.note.citations) {
    console.log(`      [${c.marker}] ${c.dbName} / ${c.docName} / 第 ${c.startLine}-${c.endLine} 行`)
  }
}

step(7, '整库导出（JSON 结构，可迁移）')
{
  const r = await kb.call('database.export', { id: database.id })
  const dump = r.payload
  line('文件名', r.name)
  line('schema', dump.schema)
  line('文档', `${dump.documents.length} 篇 · 首篇正文可还原 ${dump.documents[0].text.length} 字`)
  line('记录', `${dump.records.length} 条结构化行`)
  line('笔记', `${dump.notes.length} 条`)
  const md = await kb.call('database.export', { id: database.id, format: 'md' })
  line('Markdown 导出', `${md.markdown.length} 字`)
}

console.log('\n演示二完成。\n')
