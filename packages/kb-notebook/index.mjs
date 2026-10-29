/**
 * kb-notebook — Host 半部。
 *
 * 四条注入链路（对应严格模式的硬机制）：
 *   1. agent/pre-step      —— 在模型看到本轮问题前，检索绑定库并把证据挂进这条消息
 *   2. agent/request       —— 严格模式下压温度
 *   3. systemPrompt.section—— 常驻规则段，说明 <kb-evidence> / <kb-rule> 的语义
 *   4. webServer 路由      —— 面板与宿主浏览器的数据通道
 *
 * 不做的事：不 append 任何新 type 的 session event（会导致会话无法重开），
 * 插件自有数据全部落 kb.sqlite。
 */
import { readFile } from 'node:fs/promises'
import {
  audit,
  closeStore,
  createDatabase,
  deleteDatabase,
  deleteDocument,
  deleteNote,
  duplicateDatabase,
  exportDatabase,
  getBindings,
  getDatabase,
  insertChunks,
  insertRecords,
  listAudit,
  listDatabases,
  listDocuments,
  listNotes,
  openStore,
  saveNote,
  setBindings,
  updateDatabase,
  upsertDocument,
} from './lib/store.mjs'
import { chunkDocument } from './lib/text.mjs'
import { parseDocument } from './lib/parsers.mjs'
import {
  DEFAULT_THRESHOLD,
  SearchService,
  checkCitations,
  renderEvidence,
  renderInsufficient,
} from './lib/search.mjs'
import { detectGaps, proposeFixes, listSuggestions, decideSuggestion, revertSuggestion } from './lib/fill.mjs'

export const name = 'kb-notebook'
export const inject = ['webServer']

const ROUTE = '/__kb'

/* ------------------------------------------------------------ HTTP helpers */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      // 25MB 上限：够跑批量文档导入，又不至于把宿主内存打满
      if (size > 25 * 1024 * 1024) {
        reject(new Error('请求体超过 25MB 上限'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const raw = await readBody(req)
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`请求体不是合法 JSON：${err.message}`)
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

const fail = (res, err) => sendJson(res, 400, { ok: false, error: err?.message ?? String(err) })

/**
 * 访问闸。插件路由挂在宿主 webServer 上，默认不带鉴权，等于把本机知识库
 * 暴露给任何能连 127.0.0.1 的进程，因此这里做两道基础校验：
 *   1. Host 必须回环地址 —— 挡住 DNS rebinding（攻击者域名解析到 127.0.0.1 后 Host 头伪造不了）
 *   2. 浏览器请求（带 Origin）必须同源 —— 挡跨站表单/脚本直接打这台机器
 * 非浏览器客户端（不带 Origin 的本机脚本）放行，由 Host 校验兜底。
 */
function guard(req, res) {
  const host = String(req.headers.host ?? '').toLowerCase()
  const hostname = host.replace(/:\d+$/, '')
  const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
  if (!isLoopback) {
    sendJson(res, 403, { ok: false, error: `仅允许本机访问（Host=${host || '空'}）` })
    return false
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    let originHost = ''
    try {
      originHost = new URL(origin).host.toLowerCase()
    } catch {
      originHost = ''
    }
    if (originHost !== host) {
      sendJson(res, 403, { ok: false, error: '跨源请求被拒绝' })
      return false
    }
  }
  return true
}

/* ------------------------------------------------------------- 消息内容提取 */

/** 从 messages 里取最后一条 user 消息的纯文本。 */
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    const blocks = Array.isArray(m.content) ? m.content : []
    const text = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return ''
}

/**
 * 把证据块追加到最后一条 user 消息的 content 末尾。
 * 只扩 content 数组，不新建 message —— 保住 id/source，避免宿主校验失败。
 */
function appendEvidence(messages, block) {
  if (!block) return messages
  const out = messages.slice()
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const m = out[i]
    if (!m || m.role !== 'user') continue
    const content = Array.isArray(m.content) ? m.content : []
    out[i] = { ...m, content: [...content, { type: 'text', text: `\n\n${block}` }] }
    return out
  }
  return messages
}

/* ------------------------------------------------------------------- apply */

export function apply(ctx) {
  const db = openStore()
  const search = new SearchService(db)
  const binds = new Map() // sessionId -> { mode, dbids }
  const turnSeen = new WeakMap() // agent -> 已检索的 turn
  const evidenceBySession = new Map() // sessionId -> 最近一次检索结果（供面板展开）
  const citationsBySession = new Map()
  // 最近一条助手回答（供「保存为笔记」一键取正文）。这里只缓存在内存：
  // 会话日志才是唯一真相源，缓存丢了也只是按钮不可用，不影响数据正确性。
  const lastAnswerBySession = new Map()

  const routes = []
  const route = (path, handler) => {
    routes.push(
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/${path}`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          try {
            await handler(req, res)
          } catch (err) {
            fail(res, err)
          }
        },
      }),
    )
  }

  /** 读绑定：优先内存缓存，miss 时回库。绑定变化由 bind 路由显式刷新。 */
  const bindingsOf = (sessionId) => {
    if (!sessionId) return []
    let cached = binds.get(sessionId)
    if (!cached) {
      cached = { mode: 'strict', dbids: getBindings(db, sessionId).map((b) => b.dbid) }
      binds.set(sessionId, cached)
    }
    return cached.dbids
  }

  const modeOf = (sessionId) => binds.get(sessionId)?.mode ?? 'strict'

  /**
   * 单文件入库。文本走 text、二进制走 base64/path；解析 → 切块 → 写库 → 返回预览。
   * 批量与单条共用这一条路径，保证两条入口行为一致。
   */
  const ingestOne = async (dbid, body) => {
    let fileName = String(body.name ?? 'untitled')
    let text = typeof body.text === 'string' ? body.text : undefined
    let buf
    if (text === undefined && typeof body.base64 === 'string') {
      buf = Buffer.from(body.base64, 'base64')
    }
    if (text === undefined && buf === undefined && typeof body.path === 'string') {
      // 本机路径导入：面板上的"选择文件"走后端读，浏览器拿不到绝对路径
      fileName = body.path.split(/[\\/]/).pop() || fileName
      buf = await readFile(body.path)
    }
    if (text === undefined && buf === undefined) throw new Error('缺少内容：需要 text / base64 / path 之一')

    const parsed = parseDocument({ name: fileName, text, buffer: buf })
    const chunks = chunkDocument(parsed.text, {})
    if (chunks.length === 0) throw new Error('解析后没有任何可入库内容（文件可能是空的）')

    const mode = body.mode === 'append' || body.mode === 'skip' ? body.mode : 'overwrite'
    const doc = upsertDocument(db, {
      dbid,
      name: fileName,
      format: parsed.format,
      text: parsed.text,
      records: parsed.records,
      fields: parsed.fields,
      mode,
    })
    if (doc.skipped) {
      return { ok: true, skipped: true, docid: doc.docid, name: fileName, chunks: 0, records: 0 }
    }
    insertChunks(db, { dbid, docid: doc.docid, chunks })
    if (parsed.records.length > 0) insertRecords(db, { dbid, docid: doc.docid, records: parsed.records })
    search.invalidate(dbid)
    return {
      ok: true,
      docid: doc.docid,
      name: fileName,
      format: parsed.format,
      chunks: chunks.length,
      records: parsed.records.length,
      fields: parsed.fields,
      preview: chunks.slice(0, 3).map((c) => ({ lines: `${c.startLine}-${c.endLine}`, text: c.text.slice(0, 200) })),
    }
  }

  /* ---------------------------------------------------------------- 路由 */

  route('state', async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const sessionId = url.searchParams.get('session') ?? ''
    const dbs = listDatabases(db)
    const bound = sessionId ? getBindings(db, sessionId) : []
    const last = evidenceBySession.get(sessionId)
    sendJson(res, 200, {
      ok: true,
      databases: dbs,
      bound,
      mode: bound[0]?.mode ?? 'strict',
      lastEvidence: last
        ? {
            query: last.query,
            turn: last.turn,
            insufficient: last.insufficient,
            threshold: last.threshold,
            topRelevance: last.topRelevance,
            hits: last.hits.map((h) => ({
              dbName: h.dbName,
              docName: h.docName,
              startLine: h.startLine,
              endLine: h.endLine,
              section: h.section,
              relevance: Number(h.relevance.toFixed(3)),
              text: h.text.length > 400 ? `${h.text.slice(0, 400)}…` : h.text,
            })),
          }
        : null,
      lastCitations: citationsBySession.get(sessionId) ?? null,
      lastAnswer: (() => {
        const a = lastAnswerBySession.get(sessionId)
        if (!a) return null
        return { text: a.text.slice(0, 8000), chars: a.text.length, turn: a.turn }
      })(),
    })
  })

  route('database.create', async (req, res) => {
    const body = await readJson(req)
    sendJson(res, 200, { ok: true, database: createDatabase(db, body) })
  })

  route('database.update', async (req, res) => {
    const body = await readJson(req)
    sendJson(res, 200, { ok: true, database: updateDatabase(db, body.id, body.patch ?? body) })
  })

  route('database.delete', async (req, res) => {
    const body = await readJson(req)
    deleteDatabase(db, body.id)
    search.invalidate(body.id)
    sendJson(res, 200, { ok: true })
  })

  route('database.duplicate', async (req, res) => {
    const body = await readJson(req)
    const copy = duplicateDatabase(db, body.id)
    search.invalidate(copy.id)
    sendJson(res, 200, { ok: true, database: copy })
  })

  // 整库导出：直接给 JSON 下载；format=md 时把文档正文拼成一份可读 Markdown
  route('database.export', async (req, res) => {
    const body = await readJson(req)
    const payload = exportDatabase(db, body.id)
    if (body.format === 'md') {
      const lines = [`# ${payload.database.name}`, '']
      if (payload.database.description) lines.push(`> ${payload.database.description}`, '')
      lines.push(`导出时间：${payload.exportedAt}`, '')
      for (const doc of payload.documents) {
        lines.push(`## ${doc.name}`, '', doc.text || '', '')
      }
      sendJson(res, 200, { ok: true, markdown: lines.join('\n'), name: `${payload.database.name}.md` })
      return
    }
    sendJson(res, 200, { ok: true, payload, name: `${payload.database.name}.json` })
  })

  /* ---------------- 笔记 ---------------- */

  route('notes.save', async (req, res) => {
    const body = await readJson(req)
    const sessionId = String(body.session ?? '')
    const title = String(body.title ?? '').trim() || '未命名笔记'
    // body 缺省时取该会话最近一条助手回答，前端因此只需一个按钮
    let text = String(body.body ?? '')
    if (text.trim() === '') {
      const cached = lastAnswerBySession.get(sessionId)
      if (!cached) throw new Error('这条对话里还没有可保存的回答')
      text = cached.text
    }
    // 引用来源：显式传入优先，否则用本轮检索命中的片段快照
    let citations = Array.isArray(body.citations) ? body.citations : []
    if (citations.length === 0) {
      const last = evidenceBySession.get(sessionId)
      if (last && last.hits.length > 0) {
        citations = last.hits.map((h, i) => ({
          marker: `K${i + 1}`,
          dbid: h.dbid,
          dbName: h.dbName,
          docName: h.docName,
          startLine: h.startLine,
          endLine: h.endLine,
          section: h.section,
          chunkId: h.chunkId,
        }))
      }
    }
    const dbid =
      String(body.dbid ?? '') || citations[0]?.dbid || (sessionId ? bindingsOf(sessionId)[0]?.dbid : '') || ''
    const note = saveNote(db, { sessionId, dbid, title, body: text, citations })
    sendJson(res, 200, { ok: true, note })
  })

  route('notes.list', async (req, res) => {
    const body = await readJson(req)
    sendJson(res, 200, {
      ok: true,
      notes: listNotes(db, {
        dbid: body.dbid ? String(body.dbid) : undefined,
        sessionId: body.session ? String(body.session) : undefined,
      }),
    })
  })

  route('notes.delete', async (req, res) => {
    const body = await readJson(req)
    deleteNote(db, String(body.id))
    sendJson(res, 200, { ok: true })
  })

  route('bind', async (req, res) => {
    const body = await readJson(req)
    const sessionId = String(body.session ?? '')
    if (sessionId === '') throw new Error('缺少 session')
    const dbids = Array.isArray(body.dbids) ? body.dbids.map(String) : []
    const mode = body.mode === 'loose' ? 'loose' : 'strict'
    const before = new Set(bindingsOf(sessionId))
    const result = setBindings(db, sessionId, dbids, mode)
    binds.set(sessionId, { mode, dbids: result.bindings.map((b) => b.dbid) })
    const scopeChanged = before.size !== dbids.length || dbids.some((d) => !before.has(d))
    sendJson(res, 200, {
      ok: true,
      changed: scopeChanged,
      notice: scopeChanged ? '知识库范围已变化，后续回答将基于新的范围重新检索。' : null,
      bound: result.bindings,
    })
  })

  route('documents', async (req, res) => {
    const body = await readJson(req)
    const rows = listDocuments(db, body.dbid)
    // 带上块数/记录数/字段定义，面板不用再逐个文档补请求
    const enriched = rows.map((d) => {
      const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE docid = ?').get(d.id)?.n ?? 0
      const records = db.prepare('SELECT COUNT(*) AS n FROM records WHERE docid = ?').get(d.id)?.n ?? 0
      let fields = []
      try {
        fields = JSON.parse(d.meta ?? '{}').fields ?? []
      } catch {
        fields = []
      }
      return {
        id: d.id,
        dbid: d.dbid,
        name: d.name,
        format: d.format,
        bytes: d.bytes,
        sha256: d.sha256,
        status: d.status,
        createdAt: d.created_at,
        chunkCount: chunks,
        recordCount: records,
        fields,
      }
    })
    sendJson(res, 200, { ok: true, documents: enriched })
  })

  route('documents.delete', async (req, res) => {
    const body = await readJson(req)
    deleteDocument(db, body.dbid, body.docid)
    search.invalidate(body.dbid)
    sendJson(res, 200, { ok: true })
  })

  /**
   * 导入：{dbid, name, text|base64|path, mode}
   * 二进制格式（xlsx/docx/pdf）必须走 base64 或 path，绝不能先 toString('utf8') 再传进来。
   */
  route('import', async (req, res) => {
    const body = await readJson(req)
    const dbid = String(body.dbid ?? '')
    if (!getDatabase(db, dbid)) throw new Error(`知识库不存在：${dbid}`)
    sendJson(res, 200, await ingestOne(dbid, body))
  })

  /** 批量导入：{dbid, files:[{name, text|base64|path}], mode}，逐条处理，失败不中断。 */
  route('import.batch', async (req, res) => {
    const body = await readJson(req)
    const dbid = String(body.dbid ?? '')
    if (!getDatabase(db, dbid)) throw new Error(`知识库不存在：${dbid}`)
    const files = Array.isArray(body.files) ? body.files : []
    if (files.length === 0) throw new Error('没有要导入的文件')
    const results = []
    for (const f of files) {
      try {
        const r = await ingestOne(dbid, { ...f, mode: body.mode })
        results.push({ name: r.name, ok: true, docid: r.docid, chunks: r.chunks, records: r.records, skipped: r.skipped })
      } catch (err) {
        results.push({ name: String(f?.name ?? f?.path ?? 'unknown'), ok: false, reason: err.message, code: err.code })
      }
    }
    const ok = results.filter((r) => r.ok)
    sendJson(res, 200, {
      ok: true,
      total: results.length,
      succeeded: ok.length,
      failed: results.length - ok.length,
      chunks: ok.reduce((s, r) => s + (r.chunks ?? 0), 0),
      // 失败的每一条都带明确原因，前端可直接导出成错误报告
      results,
    })
  })

  route('search', async (req, res) => {
    const body = await readJson(req)
    const dbids = Array.isArray(body.dbids) ? body.dbids.map(String) : []
    const query = String(body.query ?? '')
    const threshold = body.mode === 'loose' ? 0 : (body.threshold ?? DEFAULT_THRESHOLD)
    const result = search.search({ dbids, query, limit: body.limit ?? 8, threshold })
    sendJson(res, 200, {
      ok: true,
      ...result,
      hits: result.hits.map((h) => ({ ...h, relevance: Number(h.relevance.toFixed(3)) })),
    })
  })

  route('chunk', async (req, res) => {
    const body = await readJson(req)
    const id = Number(body.chunkId ?? body.id ?? NaN)
    if (!Number.isFinite(id)) throw new Error('缺少 chunkId')
    const row = db
      .prepare(
        `SELECT c.*, d.name AS doc_name, d.format AS doc_format, b.name AS db_name
         FROM chunks c JOIN documents d ON d.id = c.docid JOIN databases b ON b.id = c.dbid
         WHERE c.id = ?`,
      )
      .get(id)
    if (!row) throw new Error(`片段不存在：${id}`)
    // 字段名与 search 的 hit 对齐，前端展开引用时不用记两套命名
    sendJson(res, 200, {
      ok: true,
      chunk: {
        id: row.id,
        dbid: row.dbid,
        docid: row.docid,
        dbName: row.db_name,
        docName: row.doc_name,
        format: row.doc_format,
        order: row.ord,
        startLine: row.start_line,
        endLine: row.end_line,
        section: row.section,
        text: row.text,
      },
    })
  })

  /* ------------------------------------------------------------ 数据填补 */

  /** 查看某个文档（或整库）的结构化记录，供填补前预览。 */
  route('records', async (req, res) => {
    const body = await readJson(req)
    const rows = db
      .prepare(
        body.docid
          ? 'SELECT row_no, cells FROM records WHERE docid = ? ORDER BY row_no'
          : 'SELECT docid, row_no, cells FROM records WHERE dbid = ? ORDER BY docid, row_no',
      )
      .all(body.docid ?? body.dbid)
    sendJson(res, 200, {
      ok: true,
      records: rows.map((r) => ({ rowNo: r.row_no, docid: r.docid, cells: JSON.parse(r.cells) })),
    })
  })

  /** 只检测缺口，不生成建议 —— 面板上先给用户看「哪里有洞」。 */
  route('fill.detect', async (req, res) => {
    const body = await readJson(req)
    if (!getDatabase(db, body.dbid)) throw new Error(`知识库不存在：${body.dbid}`)
    const gaps = detectGaps(db, body.dbid, { docid: body.docid })
    const byIssue = gaps.reduce((m, g) => ({ ...m, [g.issue]: (m[g.issue] ?? 0) + 1 }), {})
    sendJson(res, 200, { ok: true, total: gaps.length, byIssue, gaps: gaps.slice(0, body.limit ?? 200) })
  })

  /** 生成建议（只写 suggestions 表，绝不改 records）。 */
  route('fill.propose', async (req, res) => {
    const body = await readJson(req)
    if (!getDatabase(db, body.dbid)) throw new Error(`知识库不存在：${body.dbid}`)
    const result = proposeFixes(db, body.dbid, { docid: body.docid, operator: body.operator ?? 'local' })
    sendJson(res, 200, { ok: true, ...result, suggestions: listSuggestions(db, { dbid: body.dbid, status: 'pending' }) })
  })

  route('fill.list', async (req, res) => {
    const body = await readJson(req)
    // dbid 省略时跨库列出（面板想知道"总共有多少条待确认"时会这么问）
    if (body.dbid && !getDatabase(db, body.dbid)) throw new Error(`知识库不存在：${body.dbid}`)
    sendJson(res, 200, { ok: true, suggestions: listSuggestions(db, { dbid: body.dbid, status: body.status }) })
  })

  /** 采纳 / 拒绝。采纳才写回原数据，并可撤销。 */
  route('fill.decide', async (req, res) => {
    const body = await readJson(req)
    const result = decideSuggestion(db, String(body.id ?? ''), {
      accept: body.accept === true,
      operator: body.operator ?? 'local',
    })
    // 写回后该库的块变了，索引必须失效
    search.invalidate(result.dbid)
    sendJson(res, 200, { ok: true, suggestion: result })
  })

  route('fill.revert', async (req, res) => {
    const body = await readJson(req)
    const result = revertSuggestion(db, String(body.id ?? ''), { operator: body.operator ?? 'local' })
    search.invalidate(result.dbid)
    sendJson(res, 200, { ok: true, suggestion: result })
  })

  route('audit', async (req, res) => {
    // GET 带 query（面板轮询方便），POST 带 body，两种都收
    let limit = 50
    let dbid
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://127.0.0.1')
      limit = Number(url.searchParams.get('limit') ?? 50) || 50
      dbid = url.searchParams.get('dbid') ?? undefined
    } else {
      const body = await readJson(req)
      limit = body.limit ?? 50
      dbid = body.dbid
    }
    // detail 在库里是 JSON 字符串，这里解析成对象，面板与演示脚本才能直接读字段
    const entries = listAudit(db, { limit, dbid }).map((e) => {
      let detail = e.detail
      if (typeof detail === 'string' && detail !== '') {
        try {
          detail = JSON.parse(detail)
        } catch {
          /* 非 JSON 的旧记录保持原样 */
        }
      }
      return { ...e, detail: detail ?? '' }
    })
    sendJson(res, 200, { ok: true, entries })
  })

  /* ------------------------------------------------------- pre-step 注入 */

  ctx.on('agent/pre-step', async (payload, next) => {
    const base = await next()
    try {
      if (!base || base.kind !== 'enter') return base
      const agent = payload.agent
      const sessionId = agent?.id ?? agent?.session?.id
      if (!sessionId) return base
      const dbids = bindingsOf(sessionId)
      if (dbids.length === 0) return base
      // 同一 turn 只检索一次：后续 step 复用已注入的证据，避免重复花算力和上下文
      if (turnSeen.get(agent) === payload.turn) return base
      const query = lastUserText(base.messages ?? payload.messages ?? [])
      if (query === '') return base
      turnSeen.set(agent, payload.turn)

      const mode = modeOf(sessionId)
      const threshold = mode === 'strict' ? DEFAULT_THRESHOLD : 0
      const result = search.search({ dbids, query, limit: 8, threshold })
      const dbNames = dbids.map((id) => getDatabase(db, id)?.name).filter(Boolean)
      evidenceBySession.set(sessionId, { ...result, query, turn: payload.turn, dbids })
      audit(db, 'retrieve', { detail: { session: sessionId.slice(0, 12), turn: payload.turn, query: query.slice(0, 120), hits: result.hits.length, insufficient: result.insufficient } })

      const block = result.insufficient
        ? renderInsufficient({ query, dbNames })
        : renderEvidence(result.hits, { strict: mode === 'strict' })
      return { ...base, messages: appendEvidence(base.messages, block) }
    } catch (err) {
      ctx.logger?.warn?.('kb-notebook: pre-step 检索失败', err)
      return base
    }
  })

  /* -------------------------------------------------------- 严格模式温度 */

  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    try {
      const sessionId = payload?.agent?.id ?? payload?.sessionId ?? payload?.session
      if (!sessionId || modeOf(sessionId) !== 'strict') return config
      if (bindingsOf(sessionId).length === 0) return config
      const temperature = Math.min(typeof config?.temperature === 'number' ? config.temperature : 1, 0.2)
      return { ...config, temperature }
    } catch {
      return config
    }
  })

  /* ------------------------------------------------------------ 常驻规则 */

  try {
    ctx.systemPrompt.section({
      name: 'kb-notebook',
      order: 150,
      text: [
        '知识库笔记本（kb-notebook）可能在本轮用户消息末尾附带 <kb-evidence> 与 <kb-rule> 块。',
        '看到 <kb-evidence> 时：其中的片段来自用户显式选定的知识库，是本轮唯一允许的事实来源。',
        '引用格式为 [K1][K2]，对应证据块里的片段编号；回答末尾列出引用清单（知识库 / 文档 / 行号）。',
        '看到"当前所选数据库中未找到足够依据"的要求时，不得凭常识给出结论，应说明缺什么并询问是否补充数据。',
        '没有 <kb-evidence> 时表示本轮未绑定知识库，不要声称内容来自知识库。',
        '如果用户明确要求"根据知识库 / 按我的资料 / 引用文档"回答，而本轮没有 <kb-evidence>，',
        '先说明"当前对话还没有绑定知识库"，并请用户点击输入框上方的知识库条选择数据库，',
        '不要先给出通用答案再说这不是知识库内容——顺序不能颠倒。',
      ].join('\n'),
    })
  } catch (err) {
    ctx.logger?.warn?.('kb-notebook: systemPrompt.section 注册失败', err)
  }

  /* ------------------------------------------------ 抓最近一条助手回答 */

  // session/event 是提交后的广播（emit），只读不改；用它把回答文本缓起来，
  // 让「保存为笔记」不必依赖前端去翻消息列表。
  try {
    ctx.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'assistant/message') return
        const sessionId = session?.id
        if (!sessionId) return
        const content = event.data?.message?.content ?? []
        const text = content
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
          .trim()
        if (text === '' || event.data?.interrupted) return
        lastAnswerBySession.set(sessionId, { text, turn: event.data?.turn ?? 0, at: Date.now() })
      } catch (err) {
        ctx.logger?.warn?.('kb-notebook: 记录助手回答失败', err)
      }
    })
  } catch (err) {
    ctx.logger?.warn?.('kb-notebook: session/event 订阅失败', err)
  }

  ctx.effect(() => {
    return () => {
      for (const dispose of routes) {
        try {
          dispose?.()
        } catch {
          /* 已释放 */
        }
      }
      binds.clear()
      evidenceBySession.clear()
      citationsBySession.clear()
      lastAnswerBySession.clear()
      closeStore()
    }
  })
}
