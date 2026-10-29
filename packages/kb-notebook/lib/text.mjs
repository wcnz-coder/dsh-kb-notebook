/**
 * 文本处理：归一化、切词、切块、BM25。
 *
 * 设计取舍：不使用 SQLite FTS5 的 trigram 分词器。实测 trigram 对中文两字词
 * （"退货""年假""退款"）完全零命中，而中文里最常见的正是两字词。因此这里自己
 * 做 bigram 倒排：中文按 2 字滑窗、英文按词，查询侧走同一套切分，保证召回一致。
 */

/** 全角转半角 + 小写 + 压缩空白。检索与切词都先过它。 */
export function normalize(input) {
  if (typeof input !== 'string') return ''
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0)
    if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0)
    else if (code === 0x3000) out += ' '
    else out += ch
  }
  return out.toLowerCase().replace(/\s+/g, ' ').trim()
}

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const WORD = /[a-z0-9]+(?:[._-][a-z0-9]+)*/g

/**
 * 切词 → term 数组（可重复，重复次数即词频）。
 * 中文连续段做 2 字滑窗；单字段落补一个 unigram，避免一字查询无召回。
 * 英文/数字按词切。
 */
export function tokenize(input) {
  const text = normalize(input)
  const terms = []
  let hanRun = ''
  const flushHan = () => {
    if (hanRun.length === 0) return
    if (hanRun.length === 1) terms.push(hanRun)
    else for (let i = 0; i + 1 < hanRun.length; i += 1) terms.push(hanRun.slice(i, i + 2))
    hanRun = ''
  }
  for (const ch of text) {
    if (HAN.test(ch)) {
      hanRun += ch
      continue
    }
    flushHan()
  }
  flushHan()
  for (const m of text.match(WORD) ?? []) terms.push(m)
  return terms
}

/** 查询切词：去重，便于构造 AND/OR 集合。 */
export function queryTerms(input) {
  return [...new Set(tokenize(input))]
}

/**
 * 把一篇文档切成带行号定位的块。
 * 返回 [{ order, text, startLine, endLine, section }]，行号 1-based，直接用于引用。
 */
export function chunkDocument(text, options = {}) {
  const targetSize = options.targetSize ?? 900
  const maxSize = options.maxSize ?? 1800
  const lines = String(text ?? '').split(/\r?\n/)
  const chunks = []
  let buf = []
  let bufStart = 0
  let section = ''

  const push = (endLine) => {
    if (buf.length === 0) return
    const joined = buf.join('\n').trim()
    if (joined.length > 0) {
      chunks.push({
        order: chunks.length,
        text: joined,
        startLine: bufStart,
        endLine,
        section,
      })
    }
    buf = []
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const lineNo = i + 1
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      // 先把上一段落结算掉再换小节名，否则块内容会挂到下一节的标题上
      push(lineNo - 1)
      section = heading[2].slice(0, 120)
    }
    if (buf.length === 0) bufStart = lineNo
    buf.push(line)
    const size = buf.reduce((n, l) => n + l.length + 1, 0)
    if (size >= targetSize && /^\s*$/.test(line)) push(lineNo)
    else if (size >= maxSize) push(lineNo)
  }
  push(lines.length)
  return chunks
}

/**
 * BM25 打分器。
 * docs: [{ id, tokens, length }]，索引由调用方构建一次并缓存。
 */
export class Bm25Index {
  constructor({ k1 = 1.4, b = 0.72 } = {}) {
    this.k1 = k1
    this.b = b
    this.postings = new Map() // term -> Map(docId -> tf)
    this.docLength = new Map()
    this.totalLength = 0
  }

  add(id, tokens) {
    this.docLength.set(id, tokens.length)
    this.totalLength += tokens.length
    const tf = new Map()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const [term, count] of tf) {
      let list = this.postings.get(term)
      if (!list) {
        list = new Map()
        this.postings.set(term, list)
      }
      list.set(id, count)
    }
  }

  remove(id) {
    const len = this.docLength.get(id)
    if (len === undefined) return
    this.totalLength -= len
    this.docLength.delete(id)
    for (const [term, list] of this.postings) {
      if (list.delete(id) && list.size === 0) this.postings.delete(term)
    }
  }

  get size() {
    return this.docLength.size
  }

  /**
   * 打分。返回 [{ id, score, matched }]，按 score 降序。
   * 任一 term 命中即可召回（OR），命中数用于相关度加成，避免长尾噪声排前面。
   */
  search(terms, { limit = 30, minMatched = 1 } = {}) {
    if (terms.length === 0 || this.size === 0) return []
    const n = this.size
    const avg = this.totalLength / n || 1
    // 只把库里真实存在的词算进"需要命中几个"。中文问句切出来的相邻 bigram
    // 常常是伪词（"退货要多久" → 退货/货要/要多/多久，后三个库里根本没有），
    // 若拿 query 总词数当门槛，一个有效命中会被永久卡死。
    const available = []
    for (const term of terms) {
      const list = this.postings.get(term)
      if (list && list.size > 0) available.push([term, list])
    }
    if (available.length === 0) return []
    const need = Math.min(minMatched, available.length)
    const scores = new Map()
    const matched = new Map()
    for (const [term, list] of available) {
      const df = list.size
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      for (const [id, tf] of list) {
        const len = this.docLength.get(id) ?? avg
        const denom = tf + this.k1 * (1 - this.b + (this.b * len) / avg)
        const gain = idf * ((tf * (this.k1 + 1)) / (denom || 1))
        scores.set(id, (scores.get(id) ?? 0) + gain)
        matched.set(id, (matched.get(id) ?? 0) + 1)
      }
    }
    const out = []
    for (const [id, score] of scores) {
      const hits = matched.get(id) ?? 0
      if (hits < need) continue
      // 命中覆盖度加成：命中 2/3 个查询词应明显优于只命中 1 个的长文档
      out.push({
        id,
        score: score * (1 + 0.35 * ((hits - 1) / available.length)),
        matched: hits,
        // 覆盖度以「库里真实存在的查询词」为分母：问句里跨词的伪 bigram 不该拉低它
        coverage: hits / available.length,
        available: available.length,
      })
    }
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, limit)
  }
}

/** 把分数按本次检索的最高分归一化到 0..1，供严格模式的阈值判断使用。 */
export function normalizeScores(hits) {
  if (hits.length === 0) return []
  const top = hits[0].score || 1
  return hits.map((h) => ({ ...h, relevance: Math.max(0, Math.min(1, h.score / top)) }))
}
