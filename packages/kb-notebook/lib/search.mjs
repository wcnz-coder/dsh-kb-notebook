/**
 * 检索层：多库隔离的 bigram 倒排 + BM25 + 阈值判定。
 *
 * 隔离保证：每个知识库单独一份索引，检索时只查绑定库，绝不跨库合并倒排。
 * 这样即使两个库有同名文档、相同片段，也不会互相影响评分或串出内容。
 */
import { Bm25Index, normalizeScores, queryTerms, tokenize } from './text.mjs'
import { allChunks, getDatabase } from './store.mjs'

/** 严格模式默认阈值：低于它的命中视为「依据不足」。 */
export const DEFAULT_THRESHOLD = 0.42
/** 覆盖度下限：命中词占「库里真实存在的查询词」的比例低于它，不算有依据。 */
export const MIN_COVERAGE = 0.34

export class SearchService {
  constructor(db) {
    this.db = db
    this.cache = new Map() // dbid -> { index: Bm25Index, rows: Map(id -> chunk) }
  }

  invalidate(dbid) {
    if (dbid === undefined) this.cache.clear()
    else this.cache.delete(dbid)
  }

  ensure(dbid) {
    const cached = this.cache.get(dbid)
    if (cached) return cached
    const index = new Bm25Index()
    const rows = new Map()
    for (const chunk of allChunks(this.db, dbid)) {
      index.add(chunk.id, tokenize(chunk.text))
      rows.set(chunk.id, chunk)
    }
    const entry = { index, rows }
    this.cache.set(dbid, entry)
    return entry
  }

  /**
   * 检索。
   * @param {{ dbids: string[], query: string, limit?: number, threshold?: number }} args
   * @returns {{ hits: object[], insufficient: boolean, threshold: number, scanned: number }}
   */
  search({ dbids, query, limit = 8, threshold = DEFAULT_THRESHOLD }) {
    const terms = queryTerms(query)
    if (terms.length === 0 || dbids.length === 0) {
      return { hits: [], insufficient: true, threshold, scanned: 0, terms }
    }
    const perDb = Math.max(limit, 6)
    let scanned = 0
    const merged = []
    for (const dbid of dbids) {
      const meta = getDatabase(this.db, dbid)
      if (!meta || !meta.enabled) continue
      const { index, rows } = this.ensure(dbid)
      if (index.size === 0) continue
      scanned += index.size
      // 召回用 OR（只要命中一个有效词就进来），质量交给阈值 + 覆盖度两道闸：
      // 硬性要求「单条片段覆盖多个查询词」会把多主题问句（"退货要多久才能退款"）
      // 整条误杀——两个主题本来就分处不同片段。
      const found = index.search(terms, { limit: perDb, minMatched: 1 })
      for (const hit of found) {
        const row = rows.get(hit.id)
        if (!row) continue
        merged.push({
          dbid,
          dbName: meta.name,
          docid: row.docid,
          docName: row.doc_name,
          chunkId: row.id,
          ord: row.ord,
          section: row.section,
          startLine: row.start_line,
          endLine: row.end_line,
          text: row.text,
          score: hit.score,
          matched: hit.matched,
          coverage: hit.coverage,
          availableTerms: hit.available,
        })
      }
    }
    merged.sort((a, b) => b.score - a.score)
    const scored = normalizeScores(merged).slice(0, limit)
    const top = scored[0]?.relevance ?? 0
    const aboveThreshold = scored.filter((h) => h.relevance >= threshold)
    const kept = aboveThreshold.filter((h) => (h.coverage ?? 1) >= MIN_COVERAGE)
    return {
      hits: kept,
      insufficient: kept.length === 0,
      threshold,
      scanned,
      terms,
      // 供面板展示「为什么没依据」：最高分拿到多少、以及被哪道闸拦下
      topRelevance: top,
      droppedBelowThreshold: scored.length - aboveThreshold.length,
      droppedByCoverage: aboveThreshold.length - kept.length,
      topCoverage: scored[0]?.coverage ?? 0,
    }
  }
}

const clip = (text, max = 700) => {
  const t = String(text ?? '').trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

/**
 * 把命中渲染成注入给模型、以及回显给用户的证据块。
 * 每条带稳定编号 [K1][K2]，模型被要求引用这些编号，引用体检据此回查。
 */
export function renderEvidence(hits, { strict = true } = {}) {
  if (hits.length === 0) return ''
  const lines = ['<kb-evidence>', '以下是本轮从用户所选知识库中检索到的原文片段，编号供引用使用：']
  hits.forEach((hit, i) => {
    const loc =
      hit.startLine > 0 ? `第 ${hit.startLine}-${hit.endLine} 行` : `第 ${hit.ord + 1} 段`
    lines.push('')
    lines.push(`[K${i + 1}] 知识库「${hit.dbName}」/ 文档「${hit.docName}」/ ${loc}${hit.section ? ` / 小节「${hit.section}」` : ''}`)
    lines.push(clip(hit.text))
  })
  lines.push('</kb-evidence>')
  if (strict) {
    lines.push(
      '',
      '<kb-rule>',
      '本轮处于严格模式：',
      '1. 只能依据上面 <kb-evidence> 中的内容作答，不得使用你自己的常识、行业惯例或记忆补充事实。',
      '2. 每一个结论句后面必须带引用编号，格式如 [K1]；一条结论由多条片段支撑时写 [K1][K3]。',
      '3. 证据不足以回答的部分，明确写出「当前所选数据库中未找到足够依据」，并说明缺什么。',
      '4. 禁止把未出现在证据里的内容写成事实，也不要编造文档名、行号或库名。',
      '</kb-rule>',
    )
  }
  return lines.join('\n')
}

/** 无依据时的硬提示：让模型按固定话术回退，而不是自由发挥。 */
export function renderInsufficient({ query, dbNames }) {
  const scope = dbNames.length > 0 ? dbNames.map((n) => `「${n}」`).join('、') : '（未绑定任何知识库）'
  return [
    '<kb-rule>',
    `严格模式：本轮已检索知识库 ${scope}，针对「${clip(query, 80)}」没有找到达到相关度阈值的内容。`,
    '按以下方式回答：',
    '1. 第一句明确写「当前所选数据库中未找到足够依据」。',
    '2. 说明你检索了哪些知识库，以及缺的是哪类信息。',
    '3. 询问用户是补充数据，还是允许本次改用通用回答。',
    '4. 不要凭常识直接给出结论性答案。',
    '</kb-rule>',
  ].join('\n')
}

const CITE_RE = /\[K(\d+)\]/g

/**
 * 引用体检：把模型回答里的 [Kn] 与本次检索到的片段对齐。
 * 返回 { used, dangling, missing, total }：
 *   dangling —— 回答引用了不存在的编号（等于编造出处）
 *   missing  —— 回答有实质内容却一条引用都没有
 */
export function checkCitations(answer, hits) {
  const used = new Set()
  for (const m of String(answer ?? '').matchAll(CITE_RE)) used.add(Number(m[1]))
  const valid = new Set(hits.map((_, i) => i + 1))
  const dangling = [...used].filter((n) => !valid.has(n))
  const body = String(answer ?? '')
    .replace(CITE_RE, '')
    .replace(/当前所选数据库中未找到足够依据/g, '')
    .trim()
  const missing = body.length > 60 && used.size === 0
  return { used: [...used].sort((a, b) => a - b), dangling, missing, total: hits.length }
}
