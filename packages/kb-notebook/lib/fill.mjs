/**
 * 数据填补层。
 *
 * 硬规则（来自需求）：
 *   1. 只产出「建议」，绝不自动改原数据；采纳动作必须由人显式触发。
 *   2. 每条建议都要能说清依据（basis）；说不清的标 unreliable，不伪造。
 *   3. 采纳后保留 old_value，可回滚。
 *
 * 三种方法：
 *   same-key   同表内除本字段外其他字段完全一致的行，取它们的值（最强依据）
 *   similar-row 部分字段相同的行作为参考（较弱，basis 里写明匹配了哪些字段）
 *   format     值本身可解析，只是格式与同列主流格式不一致 → 建议统一格式
 * 找不到依据时 new_value 为空、status='unreliable'、basis 写明为什么。
 */
import { chunkDocument } from './text.mjs'
import { inferType } from './parsers.mjs'
import { audit, now, sha256 } from './store.mjs'

const norm = (v) => String(v ?? '').trim()

/** 把记录还原成可切块的正文，字段顺序沿用表头顺序。 */
export function recordsToText(docName, fields, records) {
  const header = fields.map((f) => f.name)
  const lines = [`# ${docName}`, '', `字段：${header.join(' | ')}`, '']
  for (const r of records) {
    const parts = []
    for (const key of header) {
      const v = norm(r.cells?.[key])
      if (v !== '') parts.push(`${key}: ${v}`)
    }
    if (parts.length > 0) lines.push(`[行 ${r.rowNo}] ${parts.join('；')}`)
  }
  return lines.join('\n')
}

/** 读出某个库（或某个文档）的结构化记录。docid 本身唯一，给了就不再叠加 dbid 条件。 */
function loadRecords(db, dbid, docid) {
  const sql = docid
    ? 'SELECT * FROM records WHERE docid = ? ORDER BY row_no'
    : 'SELECT * FROM records WHERE dbid = ? ORDER BY docid, row_no'
  return db.prepare(sql).all(docid ?? dbid).map((r) => {
    let cells = {}
    try {
      cells = JSON.parse(r.cells)
    } catch {
      cells = {}
    }
    return { id: r.id, docid: r.docid, rowNo: r.row_no, cells }
  })
}

function fieldsOf(db, docid) {
  const row = db.prepare('SELECT name, meta FROM documents WHERE id = ?').get(docid)
  if (!row) return { name: docid, fields: [] }
  let fields = []
  try {
    fields = JSON.parse(row.meta ?? '{}').fields ?? []
  } catch {
    fields = []
  }
  // meta 里没存字段时，退回从记录本身推
  if (fields.length === 0) {
    const all = loadRecords(db, '', docid)
    const keys = new Set()
    for (const r of all) for (const k of Object.keys(r.cells)) keys.add(k)
    fields = [...keys].map((k) => ({ name: k, type: inferType(all.map((r) => r.cells[k])) }))
  }
  return { name: row.name, fields }
}

/* ------------------------------------------------------------ 缺口检测 */

/**
 * 找出需要填补的位置。
 * @returns {{docid:string, docName:string, rowNo:number, field:string, value:string, issue:string}[]}
 */
export function detectGaps(db, dbid, { docid } = {}) {
  const records = loadRecords(db, dbid, docid)
  const byDoc = new Map()
  for (const r of records) {
    if (!byDoc.has(r.docid)) byDoc.set(r.docid, [])
    byDoc.get(r.docid).push(r)
  }

  const gaps = []
  for (const [docId, rows] of byDoc) {
    const { name, fields } = fieldsOf(db, docId)
    for (const f of fields) {
      const values = rows.map((r) => norm(r.cells[f.name]))
      const filled = values.filter((v) => v !== '')
      // 同列里出现次数最多的「形状」当作主流格式
      const dominant = dominantShape(filled)
      for (const r of rows) {
        const v = norm(r.cells[f.name])
        if (v === '') {
          gaps.push({ docid: docId, docName: name, rowNo: r.rowNo, field: f.name, value: '', issue: 'empty' })
          continue
        }
        if (f.type === 'date' && dominant && shapeOf(v) !== dominant) {
          gaps.push({ docid: docId, docName: name, rowNo: r.rowNo, field: f.name, value: v, issue: 'format' })
        }
      }
    }
  }
  return gaps
}

/** 值的「形状」：区分 2026-01-05 / 2026/1/5 / 1,299 / 1299 等写法差异。 */
function shapeOf(v) {
  const s = norm(v)
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return 'Y-M-D'
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) return 'Y/M/D'
  if (/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(s)) return 'Y.M.D'
  if (/^-?\d{1,3}(,\d{3})+$/.test(s)) return 'thousands'
  if (/^-?\d+(\.\d+)?$/.test(s)) return 'plain-number'
  return 'text'
}

function dominantShape(values) {
  const tally = new Map()
  for (const v of values) tally.set(shapeOf(v), (tally.get(shapeOf(v)) ?? 0) + 1)
  let best = null
  let bestN = 0
  for (const [k, n] of tally) {
    if (n > bestN) {
      best = k
      bestN = n
    }
  }
  // 只有真出现两种以上形状时才谈「格式不一致」
  return tally.size > 1 ? best : null
}

/* ------------------------------------------------------------ 建议生成 */

/**
 * 为缺口生成建议（只写 suggestions 表，不动 records）。
 * @returns {{created:number, unreliable:number, skipped:number}}
 */
export function proposeFixes(db, dbid, { docid, operator = 'local' } = {}) {
  const gaps = detectGaps(db, dbid, { docid })
  if (gaps.length === 0) return { created: 0, unreliable: 0, skipped: 0, gaps: 0 }

  const records = loadRecords(db, dbid, docid)
  const byDoc = new Map()
  for (const r of records) {
    if (!byDoc.has(r.docid)) byDoc.set(r.docid, [])
    byDoc.get(r.docid).push(r)
  }

  // 已生成过且还没被处理的（pending 与 unreliable）不重复刷；处理过的允许重新评估
  const existing = new Set(
    db
      .prepare(`SELECT docid, row_no, field FROM suggestions WHERE dbid = ? AND status IN ('pending','unreliable')`)
      .all(dbid)
      .map((r) => `${r.docid}#${r.row_no}#${r.field}`),
  )

  let created = 0
  let unreliable = 0
  let skipped = 0
  const insert = db.prepare(
    `INSERT OR REPLACE INTO suggestions(id, dbid, docid, row_no, field, old_value, new_value, method, basis, status, created_at, decided_at, decided_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
  )

  for (const gap of gaps) {
    const key = `${gap.docid}#${gap.rowNo}#${gap.field}`
    if (existing.has(key)) {
      skipped += 1
      continue
    }
    const rows = byDoc.get(gap.docid) ?? []
    const guess = guessValue(rows, gap)

    const id = `sg_${sha256(`${dbid}|${key}|${gap.value}|${now()}`).slice(0, 12)}`
    const status = guess.method === 'none' ? 'unreliable' : 'pending'
    insert.run(
      id,
      dbid,
      gap.docid,
      gap.rowNo,
      gap.field,
      gap.value,
      guess.value ?? '',
      guess.method,
      guess.basis,
      status,
      now(),
    )
    created += 1
    if (status === 'unreliable') unreliable += 1
  }

  audit(db, 'fill.propose', {
    dbid,
    docid: docid ?? null,
    detail: { created, unreliable, skipped, operator },
  })
  return { created, unreliable, skipped, gaps: gaps.length }
}

/** 核心推断：只认可复述的依据，凑不出来就说凑不出来。 */
function guessValue(rows, gap) {
  const target = rows.find((r) => r.rowNo === gap.rowNo)
  if (!target) return { method: 'none', basis: '找不到原始行' }

  /* 1) 同键参考：其他字段完全一致的行 */
  const sameKey = rows.filter((r) => {
    if (r.rowNo === gap.rowNo) return false
    const keys = Object.keys(target.cells).filter((k) => k !== gap.field)
    if (keys.length === 0) return false
    return keys.every((k) => norm(r.cells[k]) === norm(target.cells[k]))
  })
  const sameKeyValues = [...new Set(sameKey.map((r) => norm(r.cells[gap.field])).filter((v) => v !== ''))]
  if (sameKeyValues.length === 1 && sameKey.length > 0) {
    return {
      method: 'same-key',
      value: sameKeyValues[0],
      basis: `同表第 ${sameKey.map((r) => r.rowNo).join('、')} 行在其余 ${Object.keys(target.cells).length - 1} 个字段上与本行完全一致，取它们的「${gap.field}」值`,
    }
  }

  /* 2) 部分字段相同的行作参考 */
  const partial = rows
    .filter((r) => r.rowNo !== gap.rowNo)
    .map((r) => {
      const shared = Object.keys(target.cells).filter(
        (k) => k !== gap.field && norm(r.cells[k]) !== '' && norm(r.cells[k]) === norm(target.cells[k]),
      )
      return { row: r, shared }
    })
    .filter((x) => x.shared.length > 0 && norm(x.row.cells[gap.field]) !== '')
    .sort((a, b) => b.shared.length - a.shared.length)

  if (partial.length > 0) {
    const best = partial[0]
    const sameVal = partial.filter((x) => norm(x.row.cells[gap.field]) === norm(best.row.cells[gap.field]))
    return {
      method: 'similar-row',
      value: norm(best.row.cells[gap.field]),
      basis: `参考同表第 ${sameVal.map((x) => x.row.rowNo).join('、')} 行：与本行在「${best.shared.join('」「')}」上相同，其「${gap.field}」为 ${norm(best.row.cells[gap.field])}`,
    }
  }

  /* 3) 格式标准化：值本身能解析，只是与同列主流写法不一致 */
  if (gap.issue === 'format' && gap.value !== '') {
    const normalized = normalizeFormat(gap.value)
    if (normalized && normalized !== gap.value) {
      return {
        method: 'format',
        value: normalized,
        basis: `原值「${gap.value}」可无歧义解析为同一日期，按同列主流写法统一为「${normalized}」`,
      }
    }
  }

  /* 4) 没有依据 */
  const sibling = rows.filter((r) => r.rowNo !== gap.rowNo).length
  return {
    method: 'none',
    value: '',
    basis: `同表其余 ${sibling} 行里没有可参照的记录（缺少相同的键值），也没有可推导的规则——无可靠依据，需人工补录`,
  }
}

function normalizeFormat(v) {
  const s = norm(v)
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
  if (/^-?\d{1,3}(,\d{3})+$/.test(s)) return s.replace(/,/g, '')
  return null
}

/* ------------------------------------------------------------ 查询与决策 */

export function listSuggestions(db, { dbid, status } = {}) {
  // 带上文档名：面板与日志都要显示「哪篇文档的第几行」，缺了就没法定位
  const base = `SELECT s.*, d.name AS doc_name FROM suggestions s LEFT JOIN documents d ON d.id = s.docid`
  // dbid 可省（跨库统计待确认数），status 可省（列出全部状态）
  const where = []
  const args = []
  if (dbid) {
    where.push('s.dbid = ?')
    args.push(dbid)
  }
  if (status) {
    where.push('s.status = ?')
    args.push(status)
  }
  const sql = `${base}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY s.dbid, s.docid, s.row_no`
  const rows = db.prepare(sql).all(...args)
  return rows.map((r) => ({
    id: r.id,
    dbid: r.dbid,
    docid: r.docid,
    docName: r.doc_name ?? '',
    rowNo: r.row_no,
    field: r.field,
    oldValue: r.old_value,
    newValue: r.new_value,
    method: r.method,
    basis: r.basis,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
  }))
}

/**
 * 采纳或拒绝一条建议。采纳才写回 records，并重建该文档的块；
 * old_value 留在 suggestions 里，随时可反悔（revert）。
 */
export function decideSuggestion(db, id, { accept, operator = 'local' } = {}) {
  const row = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id)
  if (!row) throw new Error(`建议不存在：${id}`)
  // 先判有没有依据：没依据的建议连"采纳"这条路都不该走通
  if (row.method === 'none' && accept) {
    throw new Error('这条建议没有可靠依据（无可靠依据），不能采纳；请人工补录该字段')
  }
  // unreliable 表示"插件判断不出来"，人依然可以把它划掉（rejected = 先空着），
  // 所以只有已经 accepted / rejected / reverted 的才拒绝二次处理。
  if (row.status !== 'pending' && row.status !== 'unreliable') {
    throw new Error(`这条建议已处理过（当前状态 ${row.status}）`)
  }

  if (!accept) {
    db.prepare('UPDATE suggestions SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?').run(
      'rejected',
      now(),
      operator,
      id,
    )
    audit(db, 'fill.reject', {
      dbid: row.dbid,
      docid: row.docid,
      detail: { id, field: row.field, rowNo: row.row_no, oldValue: row.old_value, newValue: row.new_value, method: row.method, operator },
    })
    return listSuggestions(db, { dbid: row.dbid }).find((s) => s.id === id)
  }

  const rec = db.prepare('SELECT * FROM records WHERE docid = ? AND row_no = ?').get(row.docid, row.row_no)
  if (!rec) throw new Error(`找不到原始记录（docid=${row.docid} 行 ${row.row_no}），无法写回`)
  const cells = JSON.parse(rec.cells)
  cells[row.field] = row.new_value
  db.prepare('UPDATE records SET cells = ? WHERE id = ?').run(JSON.stringify(cells), rec.id)
  db.prepare('UPDATE suggestions SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?').run(
    'accepted',
    now(),
    operator,
    id,
  )

  rebuildDocumentText(db, row.dbid, row.docid)
  audit(db, 'fill.accept', {
    dbid: row.dbid,
    docid: row.docid,
    detail: { id, field: row.field, rowNo: row.row_no, oldValue: row.old_value, newValue: row.new_value, method: row.method, operator },
  })
  return listSuggestions(db, { dbid: row.dbid }).find((s) => s.id === id)
}

/** 撤销一条已采纳的建议：写回 old_value 并重建正文。 */
export function revertSuggestion(db, id, { operator = 'local' } = {}) {
  const row = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id)
  if (!row) throw new Error(`建议不存在：${id}`)
  if (row.status !== 'accepted') throw new Error(`只有已采纳的建议才能撤销（当前状态 ${row.status}）`)

  const rec = db.prepare('SELECT * FROM records WHERE docid = ? AND row_no = ?').get(row.docid, row.row_no)
  if (!rec) throw new Error('找不到原始记录，无法撤销')
  const cells = JSON.parse(rec.cells)
  cells[row.field] = row.old_value
  db.prepare('UPDATE records SET cells = ? WHERE id = ?').run(JSON.stringify(cells), rec.id)
  db.prepare('UPDATE suggestions SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?').run(
    'reverted',
    now(),
    operator,
    id,
  )

  rebuildDocumentText(db, row.dbid, row.docid)
  audit(db, 'fill.revert', {
    dbid: row.dbid,
    docid: row.docid,
    detail: { id, field: row.field, rowNo: row.row_no, oldValue: row.old_value, newValue: row.new_value, method: row.method, operator },
  })
  return listSuggestions(db, { dbid: row.dbid }).find((s) => s.id === id)
}

/** 用最新 records 重写文档正文与块，保证检索结果反映填补后的数据。 */
export function rebuildDocumentText(db, dbid, docid) {
  const doc = db.prepare('SELECT name FROM documents WHERE id = ? AND dbid = ?').get(docid, dbid)
  if (!doc) return false
  const { fields } = fieldsOf(db, docid)
  const records = loadRecords(db, dbid, docid)
  const text = recordsToText(doc.name, fields, records)

  db.prepare('UPDATE documents SET meta = ? WHERE id = ?').run(JSON.stringify({ fields }), docid)
  db.prepare('DELETE FROM chunks WHERE docid = ?').run(docid)
  const chunks = chunkDocument(text, {})
  const stmt = db.prepare(
    'INSERT INTO chunks(dbid, docid, ord, text, start_line, end_line, section) VALUES(?,?,?,?,?,?,?)',
  )
  for (const c of chunks) stmt.run(dbid, docid, c.order, c.text, c.startLine, c.endLine, c.section ?? '')
  return true
}
