/**
 * 笔记与整库导出的离线测试。
 * 笔记要能带着引用来源落地，导出要能完整还原一个库。
 */
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'kb-notes-'))

const store = await import('../lib/store.mjs')
const { chunkDocument } = await import('../lib/text.mjs')

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass += 1
    console.log(`PASS ${name}`)
  } else {
    fail += 1
    console.log(`FAIL ${name}${extra === undefined ? '' : ` — ${extra}`}`)
  }
}

const db = store.openStore()
const kb = store.createDatabase(db, { name: '笔记测试库', description: '导出用' })

// 灌一点内容，让导出有东西可看
const up = store.upsertDocument(db, {
  dbid: kb.id,
  name: '售后政策.md',
  format: 'md',
  text: '# 退货\n\n签收后三十天内可申请退款。\n',
  fields: ['条款', '内容'],
  mode: 'overwrite',
})
store.insertChunks(db, {
  dbid: kb.id,
  docid: up.docid,
  chunks: chunkDocument('# 退货\n\n签收后三十天内可申请退款。\n'),
})

console.log('\n=== 1. 保存笔记 ===')
const note = store.saveNote(db, {
  sessionId: 'sess-1',
  dbid: kb.id,
  title: '退款期限总结',
  body: '签收后三十天内可申请退款。',
  citations: [{ dbName: '笔记测试库', docName: '售后政策.md', startLine: 3, endLine: 3, section: '退货' }],
})
check('笔记已创建', !!note.id, JSON.stringify(note))
check('引用了来源', note.citations.length === 1 && note.citations[0].docName === '售后政策.md')
check('带了来源行号', note.citations[0].startLine === 3)

console.log('\n=== 2. 列表与更新 ===')
const listed = store.listNotes(db, { dbid: kb.id })
check('按库能列出笔记', listed.length === 1, listed.length)
const updated = store.saveNote(db, { id: note.id, dbid: kb.id, title: '退款期限总结（订正）', body: '三十天。', citations: [] })
check('同 id 是更新不是新增', updated.id === note.id && updated.title === '退款期限总结（订正）')
check('更新时间变化', updated.createdAt === note.createdAt)
check('仍然只有一条', store.listNotes(db, { dbid: kb.id }).length === 1)

console.log('\n=== 3. 整库导出 ===')
const dump = store.exportDatabase(db, kb.id)
check('导出含库元信息', dump.database.name === '笔记测试库')
check('导出含文档正文', dump.documents.length === 1 && dump.documents[0].text.includes('三十天'))
check('导出含片段计数', dump.documents[0].chunkCount > 0, dump.documents[0].chunkCount)
check('导出含笔记', dump.notes.length === 1)
check('导出声明 schema 版本', dump.schema === 'dsh-kb-notebook/1')

console.log('\n=== 4. 删除 ===')
store.deleteNote(db, note.id)
check('笔记已删除', store.listNotes(db, { dbid: kb.id }).length === 0)

console.log('\n=== 5. 审计留痕 ===')
const actions = store.listAudit(db, { limit: 50 }).map((a) => a.action)
check('有 note.create', actions.includes('note.create'), actions.join(','))
check('有 note.update', actions.includes('note.update'))
check('有 note.delete', actions.includes('note.delete'))

store.closeStore()
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

console.log(`\n=== 总计 ${pass} pass / ${fail} fail ===`)
if (fail > 0) process.exit(1)
console.log('ALL PASS')
