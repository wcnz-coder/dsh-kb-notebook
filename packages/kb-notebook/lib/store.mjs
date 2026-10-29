/**
 * 存储层：node:sqlite（Node ≥22.5 内置，零外部依赖）。
 *
 * 为什么不用 ctx.storageDomain：它要求由 @deepseek-ai/dsh-storage-domain 声明的
 * zod@4 schema，而该包不在 profile 的 node_modules 里、插件侧 import 不到。改用
 * 内置 SQLite 后，块数据量、倒排重建、多库隔离都能按需要优化，且卸载插件即删目录。
 *
 * 数据文件：$DSH_HOME/kb-notebook/kb.sqlite（默认 ~/.dsh/kb-notebook/kb.sqlite）。
 * 表：
 *   databases(id, name, description, color, icon, enabled, created_at, updated_at)
 *   documents(id, dbid, name, format, bytes, sha256, status, created_at, meta)
 *   chunks(id, dbid, docid, ord, text, start_line, end_line, section)
 *   records(id, dbid, docid, row_no, cells)          -- 结构化行的原始单元格
 *   bindings(session_id, dbid, mode, bound_at)       -- 会话级绑定，多库
 *   suggestions(id, dbid, docid, row_no, field, old_value, new_value, basis, source, status, created_at, decided_at, decided_by)
 *   audit(id, ts, action, dbid, docid, detail)
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS databases(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#4c8dff', icon TEXT NOT NULL DEFAULT 'book',
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents(
  id TEXT PRIMARY KEY, dbid TEXT NOT NULL, name TEXT NOT NULL, format TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ready',
  created_at TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_documents_dbid ON documents(dbid);
CREATE TABLE IF NOT EXISTS chunks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, dbid TEXT NOT NULL, docid TEXT NOT NULL,
  ord INTEGER NOT NULL, text TEXT NOT NULL, start_line INTEGER NOT NULL DEFAULT 0,
  end_line INTEGER NOT NULL DEFAULT 0, section TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_chunks_dbid ON chunks(dbid);
CREATE INDEX IF NOT EXISTS idx_chunks_docid ON chunks(docid);
CREATE TABLE IF NOT EXISTS records(
  id INTEGER PRIMARY KEY AUTOINCREMENT, dbid TEXT NOT NULL, docid TEXT NOT NULL,
  row_no INTEGER NOT NULL, cells TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_dbid ON records(dbid);
CREATE TABLE IF NOT EXISTS bindings(
  session_id TEXT NOT NULL, dbid TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'strict',
  bound_at TEXT NOT NULL, PRIMARY KEY(session_id, dbid)
);
CREATE TABLE IF NOT EXISTS suggestions(
  id TEXT PRIMARY KEY, dbid TEXT NOT NULL, docid TEXT NOT NULL, row_no INTEGER NOT NULL,
  field TEXT NOT NULL, old_value TEXT NOT NULL DEFAULT '', new_value TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL, basis TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_suggestions_dbid ON suggestions(dbid);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, action TEXT NOT NULL,
  dbid TEXT, docid TEXT, detail TEXT NOT NULL DEFAULT ''
);
-- notes：把回答存成笔记，citations 里存 [K] 回溯到的库/文档/行号，保证笔记也能溯源
CREATE TABLE IF NOT EXISTS notes(
  id TEXT PRIMARY KEY, session_id TEXT, dbid TEXT, title TEXT NOT NULL,
  body TEXT NOT NULL, citations TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_dbid ON notes(dbid);
`

export function dataRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'kb-notebook')
}

export function dbPath() {
  return join(dataRoot(), 'kb.sqlite')
}

let shared = null

/** 进程内单例：插件重挂载时复用连接，避免重复打开同一个 SQLite 文件。 */
export function openStore() {
  if (shared) return shared
  mkdirSync(dataRoot(), { recursive: true })
  const db = new DatabaseSync(dbPath())
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  shared = db
  return db
}

export function closeStore() {
  if (!shared) return
  try {
    shared.close()
  } catch {
    /* 已关闭 */
  }
  shared = null
}

const now = () => new Date().toISOString()
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** 审计：每一次写操作都留一条，DB 层的唯一写入口都经过它。 */
export function audit(db, action, { dbid = null, docid = null, detail = '' } = {}) {
  db.prepare('INSERT INTO audit(ts, action, dbid, docid, detail) VALUES(?,?,?,?,?)').run(
    now(),
    action,
    dbid,
    docid,
    typeof detail === 'string' ? detail : JSON.stringify(detail),
  )
}

export function listAudit(db, { limit = 50, dbid } = {}) {
  const sql = dbid
    ? 'SELECT * FROM audit WHERE dbid = ? ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM audit ORDER BY id DESC LIMIT ?'
  return dbid ? db.prepare(sql).all(dbid, limit) : db.prepare(sql).all(limit)
}

/* ---------------------------------------------------------------- 数据库 */

export function listDatabases(db) {
  return db
    .prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM documents x WHERE x.dbid = d.id) AS doc_count,
              (SELECT COUNT(*) FROM chunks x WHERE x.dbid = d.id) AS chunk_count
       FROM databases d ORDER BY d.updated_at DESC`,
    )
    .all()
    .map((row) => ({ ...row, enabled: row.enabled === 1 }))
}

export function getDatabase(db, id) {
  const row = db.prepare('SELECT * FROM databases WHERE id = ?').get(id)
  return row ? { ...row, enabled: row.enabled === 1 } : null
}

export function createDatabase(db, input) {
  const name = String(input?.name ?? '').trim()
  if (name === '') throw new Error('知识库名称不能为空')
  const id = input?.id ?? `kb_${randomUUID().slice(0, 8)}`
  const ts = now()
  db.prepare(
    'INSERT INTO databases(id, name, description, color, icon, enabled, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    id,
    name,
    String(input?.description ?? ''),
    String(input?.color ?? '#4c8dff'),
    String(input?.icon ?? 'book'),
    input?.enabled === false ? 0 : 1,
    ts,
    ts,
  )
  audit(db, 'database.create', { dbid: id, detail: { name } })
  return getDatabase(db, id)
}

export function updateDatabase(db, id, patch) {
  const current = getDatabase(db, id)
  if (!current) throw new Error(`知识库不存在：${id}`)
  const next = {
    name: patch.name !== undefined ? String(patch.name).trim() : current.name,
    description: patch.description !== undefined ? String(patch.description) : current.description,
    color: patch.color !== undefined ? String(patch.color) : current.color,
    icon: patch.icon !== undefined ? String(patch.icon) : current.icon,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled ? 1 : 0,
  }
  if (next.name === '') throw new Error('知识库名称不能为空')
  db.prepare(
    'UPDATE databases SET name=?, description=?, color=?, icon=?, enabled=?, updated_at=? WHERE id=?',
  ).run(next.name, next.description, next.color, next.icon, next.enabled, now(), id)
  audit(db, 'database.update', { dbid: id, detail: patch })
  return getDatabase(db, id)
}

/** 删除库：连带清空文档、块、记录、建议与绑定，保证不串库残留。 */
export function deleteDatabase(db, id) {
  const current = getDatabase(db, id)
  if (!current) throw new Error(`知识库不存在：${id}`)
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM chunks WHERE dbid = ?').run(id)
    db.prepare('DELETE FROM records WHERE dbid = ?').run(id)
    db.prepare('DELETE FROM documents WHERE dbid = ?').run(id)
    db.prepare('DELETE FROM suggestions WHERE dbid = ?').run(id)
    db.prepare('DELETE FROM bindings WHERE dbid = ?').run(id)
    db.prepare('DELETE FROM databases WHERE id = ?').run(id)
    audit(db, 'database.delete', { dbid: id, detail: { name: current.name } })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return true
}

/** 复制库：复制元数据与全部文档/块/记录，新 id，名字加副本后缀。 */
export function duplicateDatabase(db, id) {
  const src = getDatabase(db, id)
  if (!src) throw new Error(`知识库不存在：${id}`)
  const copy = createDatabase(db, {
    name: `${src.name} 副本`,
    description: src.description,
    color: src.color,
    icon: src.icon,
  })
  const docs = db.prepare('SELECT * FROM documents WHERE dbid = ?').all(id)
  for (const doc of docs) {
    const newDocId = `doc_${randomUUID().slice(0, 8)}`
    db.prepare(
      'INSERT INTO documents(id, dbid, name, format, bytes, sha256, status, created_at, meta) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(newDocId, copy.id, doc.name, doc.format, doc.bytes, doc.sha256, doc.status, now(), doc.meta)
    for (const ch of db.prepare('SELECT * FROM chunks WHERE docid = ? ORDER BY ord').all(doc.id)) {
      db.prepare(
        'INSERT INTO chunks(dbid, docid, ord, text, start_line, end_line, section) VALUES(?,?,?,?,?,?,?)',
      ).run(copy.id, newDocId, ch.ord, ch.text, ch.start_line, ch.end_line, ch.section)
    }
    for (const rec of db.prepare('SELECT * FROM records WHERE docid = ? ORDER BY row_no').all(doc.id)) {
      db.prepare('INSERT INTO records(dbid, docid, row_no, cells) VALUES(?,?,?,?)').run(
        copy.id,
        newDocId,
        rec.row_no,
        rec.cells,
      )
    }
  }
  audit(db, 'database.duplicate', { dbid: copy.id, detail: { from: id } })
  return copy
}

/* ---------------------------------------------------------------- 文档入库 */

export function listDocuments(db, dbid) {
  return db.prepare('SELECT * FROM documents WHERE dbid = ? ORDER BY created_at DESC').all(dbid)
}

/** 同一来源重名 = 覆盖（先删旧文档的块，避免重复累积）。 */
export function upsertDocument(db, { dbid, name, format, text, records, fields, mode = 'overwrite' }) {
  if (!getDatabase(db, dbid)) throw new Error(`知识库不存在：${dbid}`)
  const existing = db.prepare('SELECT * FROM documents WHERE dbid = ? AND name = ?').all(dbid, name)
  if (existing.length > 0 && mode === 'skip') {
    return { skipped: true, docid: existing[0].id, chunks: 0 }
  }
  if (existing.length > 0 && mode === 'append') {
    // 追加模式：以新 id 入库，同名保留多份
  } else if (existing.length > 0) {
    for (const doc of existing) {
      db.prepare('DELETE FROM chunks WHERE docid = ?').run(doc.id)
      db.prepare('DELETE FROM records WHERE docid = ?').run(doc.id)
      db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id)
      audit(db, 'document.overwrite', { dbid, docid: doc.id, detail: { name } })
    }
  }
  const docid = `doc_${randomUUID().slice(0, 8)}`
  const meta = JSON.stringify({ fields: fields ?? [], chunks: 0 })
  db.prepare(
    'INSERT INTO documents(id, dbid, name, format, bytes, sha256, status, created_at, meta) VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(docid, dbid, name, format, Buffer.byteLength(text ?? '', 'utf8'), sha256(text ?? ''), 'ready', now(), meta)
  return { skipped: false, docid, chunks: 0 }
}

export function insertChunks(db, { dbid, docid, chunks }) {
  const stmt = db.prepare(
    'INSERT INTO chunks(dbid, docid, ord, text, start_line, end_line, section) VALUES(?,?,?,?,?,?,?)',
  )
  for (const ch of chunks) {
    stmt.run(dbid, docid, ch.order, ch.text, ch.startLine ?? 0, ch.endLine ?? 0, ch.section ?? '')
  }
  // 只更新 chunks 计数，保住 meta 里已有的 fields（数据填补要靠它还原字段顺序）
  const prev = db.prepare('SELECT meta FROM documents WHERE id = ?').get(docid)
  let meta = {}
  try {
    meta = JSON.parse(prev?.meta ?? '{}')
  } catch {
    meta = {}
  }
  db.prepare('UPDATE documents SET meta = ? WHERE id = ?').run(JSON.stringify({ ...meta, chunks: chunks.length }), docid)
  audit(db, 'document.import', { dbid, docid, detail: { chunks: chunks.length } })
  return chunks.length
}

export function insertRecords(db, { dbid, docid, records }) {
  const stmt = db.prepare('INSERT INTO records(dbid, docid, row_no, cells) VALUES(?,?,?,?)')
  for (const r of records) stmt.run(dbid, docid, r.rowNo, JSON.stringify(r.cells))
  return records.length
}

export function deleteDocument(db, dbid, docid) {
  db.prepare('DELETE FROM chunks WHERE docid = ?').run(docid)
  db.prepare('DELETE FROM records WHERE docid = ?').run(docid)
  db.prepare('DELETE FROM documents WHERE id = ? AND dbid = ?').run(docid, dbid)
  audit(db, 'document.delete', { dbid, docid })
  return true
}

/** 取出全部块（重建倒排用）。带文档名，供引用展示。 */
export function allChunks(db, dbid) {
  return db
    .prepare(
      `SELECT c.id, c.dbid, c.docid, c.ord, c.text, c.start_line, c.end_line, c.section, d.name AS doc_name
       FROM chunks c JOIN documents d ON d.id = c.docid
       WHERE c.dbid = ?`,
    )
    .all(dbid)
}

/* ---------------------------------------------------------------- 会话绑定 */

export function getBindings(db, sessionId) {
  return db
    .prepare(
      `SELECT b.dbid, b.mode, b.bound_at, d.name, d.enabled
       FROM bindings b JOIN databases d ON d.id = b.dbid
       WHERE b.session_id = ? ORDER BY b.bound_at`,
    )
    .all(sessionId)
    .map((r) => ({ ...r, enabled: r.enabled === 1 }))
}

export function setBindings(db, sessionId, dbids, mode = 'strict') {
  const current = new Set(getBindings(db, sessionId).map((b) => b.dbid))
  const next = new Set(dbids)
  db.exec('BEGIN')
  try {
    for (const dbid of next) {
      if (current.has(dbid)) {
        db.prepare('UPDATE bindings SET mode = ? WHERE session_id = ? AND dbid = ?').run(mode, sessionId, dbid)
        continue
      }
      if (!getDatabase(db, dbid)) throw new Error(`知识库不存在：${dbid}`)
      db.prepare('INSERT INTO bindings(session_id, dbid, mode, bound_at) VALUES(?,?,?,?)').run(
        sessionId,
        dbid,
        mode,
        now(),
      )
    }
    for (const dbid of current) {
      if (!next.has(dbid)) db.prepare('DELETE FROM bindings WHERE session_id = ? AND dbid = ?').run(sessionId, dbid)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  const changed = current.size !== next.size || [...next].some((d) => !current.has(d))
  if (changed) {
    audit(db, 'binding.set', {
      detail: { session: sessionId.slice(0, 12), added: [...next].filter((d) => !current.has(d)), removed: [...current].filter((d) => !next.has(d)) },
    })
  }
  return { changed, bindings: getBindings(db, sessionId) }
}

/* ---------------- 笔记（把回答存下来，并保留引用溯源） ---------------- */

export function saveNote(db, { id, sessionId = '', dbid = '', title, body, citations = [] }) {
  const at = now()
  const noteId = id || `note_${sha256(`${title}:${at}:${Math.random()}`).slice(0, 12)}`
  const exists = db.prepare('SELECT id, created_at FROM notes WHERE id = ?').get(noteId)
  const payload = JSON.stringify(citations)
  if (exists) {
    db.prepare('UPDATE notes SET title = ?, body = ?, citations = ?, updated_at = ? WHERE id = ?').run(
      title,
      body,
      payload,
      at,
      noteId,
    )
    audit(db, 'note.update', { dbid: dbid || null, detail: { id: noteId, title, citeCount: citations.length } })
  } else {
    db.prepare(
      'INSERT INTO notes(id, session_id, dbid, title, body, citations, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)',
    ).run(noteId, sessionId, dbid, title, body, payload, at, at)
    audit(db, 'note.create', { dbid: dbid || null, detail: { id: noteId, title, citeCount: citations.length } })
  }
  return getNote(db, noteId)
}

export function getNote(db, id) {
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id)
  if (!row) return null
  return { ...toNote(row) }
}

function toNote(row) {
  let citations = []
  try {
    citations = JSON.parse(row.citations)
  } catch {
    citations = []
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    dbid: row.dbid,
    title: row.title,
    body: row.body,
    citations,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listNotes(db, { dbid, sessionId } = {}) {
  const where = []
  const args = []
  if (dbid) {
    where.push('dbid = ?')
    args.push(dbid)
  }
  if (sessionId) {
    where.push('session_id = ?')
    args.push(sessionId)
  }
  const sql = `SELECT * FROM notes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`
  return db.prepare(sql).all(...args).map(toNote)
}

export function deleteNote(db, id) {
  db.prepare('DELETE FROM notes WHERE id = ?').run(id)
  audit(db, 'note.delete', { detail: { id } })
}

/** 整库导出：库元信息 + 文档 + 结构化记录 + 建议历史 + 笔记，一个 JSON 全带走。 */
export function exportDatabase(db, id) {
  const meta = getDatabase(db, id)
  if (!meta) throw new Error(`知识库不存在：${id}`)
  const docs = db.prepare('SELECT * FROM documents WHERE dbid = ? ORDER BY created_at').all(id)
  return {
    exportedAt: now(),
    schema: 'dsh-kb-notebook/1',
    database: meta,
    documents: docs.map((d) => {
      const chunks = db.prepare('SELECT text FROM chunks WHERE docid = ? ORDER BY ord').all(d.id)
      return {
        id: d.id,
        name: d.name,
        format: d.format,
        importedAt: d.created_at,
        chunkCount: chunks.length,
        recordCount: db.prepare('SELECT COUNT(*) c FROM records WHERE docid = ?').get(d.id).c,
        meta: safeJson(d.meta),
        // documents 表不存正文，正文以 chunks 为源；导出时按 ord 拼回去
        text: chunks.map((c) => c.text).join('\n\n'),
      }
    }),
    records: db.prepare('SELECT * FROM records WHERE dbid = ? ORDER BY docid, row_no').all(id).map((r) => ({
      docid: r.docid,
      rowNo: r.row_no,
      cells: safeJson(r.cells),
    })),
    suggestions: db.prepare('SELECT * FROM suggestions WHERE dbid = ? ORDER BY created_at').all(id),
    notes: listNotes(db, { dbid: id }),
  }
}

function safeJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export { now, sha256 }
