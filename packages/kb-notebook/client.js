/**
 * kb-notebook — Client 半部。
 *
 * 只做两件事：
 *   1. 在输入框上方（conversation.input.dock）挂一条「知识库范围」条，显示当前对话绑定了哪些库
 *   2. 点开后展开面板：建库 / 导入 / 绑定 / 查看最近一次检索到的证据
 *
 * 约束（来自宿主 practices）：不 require 任何 @deepseek-ai/dsh-client-* 包，React 从模块表取；
 * 颜色只用 --dsw-alias-* 主题变量；类名统一加 kb- 前缀；组件内部自包错误边界，
 * 避免抛错导致整个 slot 条目空白。
 */
window.__ModuleLoader__.load({
  id: 'dsh-kb-notebook',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    const API = '/__kb'

    const css = {
      bar: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        padding: '6px 10px',
        margin: '0 0 6px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.28))',
        background: 'var(--dsw-alias-bg-subtle, rgba(128,128,128,.06))',
        font: 'inherit',
        fontSize: 12,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-text-secondary, inherit)',
      },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.28))',
        background: 'var(--dsw-alias-bg-elevated, transparent)',
        fontSize: 12,
        cursor: 'pointer',
      },
      dot: (color) => ({
        width: 6,
        height: 6,
        borderRadius: 999,
        background: color || 'var(--dsw-alias-accent, #4c8dff)',
        flex: '0 0 auto',
      }),
      btn: {
        padding: '3px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.3))',
        background: 'var(--dsw-alias-bg-elevated, transparent)',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      panel: {
        margin: '6px 0 10px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.28))',
        background: 'var(--dsw-alias-bg-elevated, transparent)',
        padding: 12,
        display: 'grid',
        gap: 10,
        fontSize: 13,
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      input: {
        flex: '1 1 140px',
        minWidth: 120,
        padding: '5px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.3))',
        background: 'var(--dsw-alias-bg-base, transparent)',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
      },
      muted: { color: 'var(--dsw-alias-text-tertiary, inherit)', fontSize: 12 },
      dbRow: {
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.18))',
      },
      ev: {
        borderLeft: '2px solid var(--dsw-alias-accent, #4c8dff)',
        paddingLeft: 8,
        marginTop: 6,
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },

      /* ---- 管理页 ---- */
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        height: '100%',
        minHeight: 0,
        padding: '16px 20px 20px',
        boxSizing: 'border-box',
        fontSize: 13,
        color: 'var(--dsw-alias-text-primary, inherit)',
      },
      header: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
        flexWrap: 'wrap',
        paddingBottom: 8,
        borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.2))',
      },
      cols: {
        display: 'grid',
        gridTemplateColumns: '292px minmax(0, 1fr)',
        gap: 16,
        flex: '1 1 auto',
        minHeight: 0,
      },
      left: { display: 'grid', alignContent: 'start', gap: 8, overflowY: 'auto', paddingRight: 2 },
      right: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, overflowY: 'auto' },
      card: {
        display: 'grid',
        gap: 6,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.22))',
        background: 'var(--dsw-alias-bg-subtle, rgba(128,128,128,.05))',
      },
      tabs: { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.2))' },
      tab: {
        padding: '5px 10px',
        border: 'none',
        borderBottom: '2px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-text-secondary, inherit)',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      tabActive: {
        borderBottomColor: 'var(--dsw-alias-accent, #4c8dff)',
        color: 'var(--dsw-alias-text-primary, inherit)',
        fontWeight: 600,
      },
      body: { display: 'grid', gap: 8, alignContent: 'start', minHeight: 0 },
      docRow: {
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        alignItems: 'center',
        gap: 8,
        padding: '6px 9px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.16))',
      },
      dbRowActive: {
        borderColor: 'var(--dsw-alias-accent, #4c8dff)',
        background: 'var(--dsw-alias-bg-elevated, rgba(76,141,255,.08))',
      },
      drop: {
        display: 'grid',
        gap: 8,
        justifyItems: 'center',
        padding: '18px 14px',
        borderRadius: 10,
        border: '1px dashed var(--dsw-alias-border-strong, rgba(128,128,128,.45))',
        background: 'var(--dsw-alias-bg-subtle, rgba(128,128,128,.04))',
        textAlign: 'center',
      },
      dropActive: {
        borderColor: 'var(--dsw-alias-accent, #4c8dff)',
        background: 'var(--dsw-alias-bg-elevated, rgba(76,141,255,.1))',
      },
      badge: {
        padding: '0 6px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.3))',
        fontSize: 11,
        fontWeight: 400,
        color: 'var(--dsw-alias-text-secondary, inherit)',
      },
      miniBtn: {
        padding: '2px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.28))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
      },
      err: {
        padding: '6px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-danger, #e5484d)',
        color: 'var(--dsw-alias-danger, #e5484d)',
        fontSize: 12,
      },
      errLine: { fontSize: 12, color: 'var(--dsw-alias-danger, #e5484d)' },
      ok: {
        padding: '6px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.3))',
        background: 'var(--dsw-alias-bg-subtle, rgba(128,128,128,.06))',
        fontSize: 12,
      },
    }

    async function api(path, body) {
      const res = await fetch(`${API}/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
      if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    }

    /** 从 slot props 或地址栏里找当前 session。 */
    function pickSessionId(props) {
      const candidates = [
        props?.sessionId,
        props?.session?.id,
        props?.session,
        props?.scope?.sessionId,
        props?.scope?.session,
      ]
      for (const c of candidates) if (typeof c === 'string' && c !== '') return c
      const m = /\/session\/([A-Za-z0-9_-]+)/.exec(window.location.pathname + window.location.hash)
      return m ? m[1] : ''
    }

    class Boundary extends React.Component {
      constructor(p) {
        super(p)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      render() {
        if (this.state.error) {
          return h(
            'div',
            { style: { ...css.bar, color: 'var(--dsw-alias-text-tertiary)' } },
            `知识库面板加载失败：${String(this.state.error?.message ?? this.state.error)}`,
          )
        }
        return this.props.children
      }
    }

    function ScopeBar(props) {
      const sessionId = useMemo(() => pickSessionId(props), [props])
      const [state, setState] = useState(null)
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [name, setName] = useState('')
      const [importPath, setImportPath] = useState('')
      const [noteTitle, setNoteTitle] = useState('')
      const [error, setError] = useState('')

      const refresh = useCallback(async () => {
        try {
          const data = await api(`state?session=${encodeURIComponent(sessionId)}`)
          setState(data)
          setError('')
        } catch (err) {
          setError(String(err.message ?? err))
        }
      }, [sessionId])

      useEffect(() => {
        refresh()
      }, [refresh])

      const databases = state?.databases ?? []
      const boundIds = new Set((state?.bound ?? []).map((b) => b.dbid))
      const bound = databases.filter((d) => boundIds.has(d.id))

      const guard = async (fn) => {
        setBusy(true)
        setError('')
        try {
          await fn()
          await refresh()
        } catch (err) {
          setError(String(err.message ?? err))
        } finally {
          setBusy(false)
        }
      }

      const toggleBind = (id) =>
        guard(async () => {
          const next = boundIds.has(id) ? [...boundIds].filter((x) => x !== id) : [...boundIds, id]
          const r = await api('bind', { session: sessionId, dbids: next, mode: state?.mode ?? 'strict' })
          setNotice(r.notice ?? '')
        })

      return h(
        Boundary,
        null,
        h(
          'div',
          { style: css.bar },
          h('span', { style: { opacity: 0.72 } }, '知识库'),
          bound.length === 0
            ? h('span', { style: css.muted }, sessionId ? '未绑定（本轮不会调用任何知识库）' : '未识别当前对话')
            : bound.map((d) =>
                h(
                  'span',
                  { key: d.id, style: css.chip, title: d.description || d.name },
                  h('span', { style: css.dot(d.color) }),
                  d.name,
                ),
              ),
          h(
            'button',
            { style: css.btn, onClick: () => setOpen((v) => !v), type: 'button' },
            open ? '收起' : '管理 / 切换',
          ),
          notice ? h('span', { style: css.muted }, notice) : null,
          error ? h('span', { style: { ...css.muted, color: 'var(--dsw-alias-danger, #d33)' } }, error) : null,
        ),
        open
          ? h(
              'div',
              { style: css.panel },
              h(
                'div',
                { style: css.row },
                h('input', {
                  style: css.input,
                  placeholder: '新知识库名称',
                  value: name,
                  onChange: (e) => setName(e.target.value),
                }),
                h(
                  'button',
                  {
                    style: css.btn,
                    disabled: busy || name.trim() === '',
                    onClick: () =>
                      guard(async () => {
                        await api('database.create', { name: name.trim() })
                        setName('')
                      }),
                    type: 'button',
                  },
                  '新建',
                ),
              ),
              databases.length === 0
                ? h('div', { style: css.muted }, '还没有知识库。先建一个，再导入数据。')
                : databases.map((d) =>
                    h(
                      'div',
                      { key: d.id, style: css.dbRow },
                      h(
                        'div',
                        null,
                        h(
                          'div',
                          { style: css.row },
                          h('span', { style: css.dot(d.color) }),
                          h('strong', { style: { fontWeight: 600 } }, d.name),
                          h('span', { style: css.muted }, `${d.doc_count} 篇 / ${d.chunk_count} 段`),
                        ),
                        d.description ? h('div', { style: css.muted }, d.description) : null,
                      ),
                      h(
                        'button',
                        { style: css.btn, disabled: busy, onClick: () => toggleBind(d.id), type: 'button' },
                        boundIds.has(d.id) ? '解除' : '绑定',
                      ),
                    ),
                  ),
              bound.length > 0
                ? h(
                    'div',
                    { style: css.row },
                    h('input', {
                      style: css.input,
                      placeholder: '导入到已绑定库的本机文件绝对路径（.md/.txt/.csv/.json）',
                      value: importPath,
                      onChange: (e) => setImportPath(e.target.value),
                    }),
                    h(
                      'button',
                      {
                        style: css.btn,
                        disabled: busy || importPath.trim() === '' || bound.length === 0,
                        onClick: () =>
                          guard(async () => {
                            await api('import', { dbid: bound[0].id, path: importPath.trim() })
                            setImportPath('')
                          }),
                        type: 'button',
                      },
                      '导入',
                    ),
                  )
                : null,
              bound.length > 0 && state?.lastAnswer
                ? h(
                    'div',
                    { style: css.row },
                    h('input', {
                      style: css.input,
                      placeholder: `保存最近一条回答为笔记（${state.lastAnswer.chars} 字）`,
                      value: noteTitle,
                      onChange: (e) => setNoteTitle(e.target.value),
                    }),
                    h(
                      'button',
                      {
                        style: css.btn,
                        disabled: busy,
                        onClick: () =>
                          guard(async () => {
                            const r = await api('notes.save', {
                              session: sessionId,
                              dbid: bound[0]?.id,
                              title: noteTitle.trim() || `笔记 ${new Date().toLocaleString('zh-CN')}`,
                            })
                            setNoteTitle('')
                            setNotice(`已存为笔记，带 ${r.note?.citations?.length ?? 0} 条来源引用`)
                          }),
                        type: 'button',
                      },
                      '保存为笔记',
                    ),
                  )
                : null,
              state?.lastEvidence
                ? h(
                    'div',
                    null,
                    h(
                      'div',
                      { style: css.row },
                      h('strong', { style: { fontSize: 12 } }, '最近一次检索'),
                      h(
                        'span',
                        { style: css.muted },
                        `${state.lastEvidence.hits.length} 条命中 · 阈值 ${state.lastEvidence.threshold} · 相关度 ${state.lastEvidence.topRelevance?.toFixed(2) ?? '—'}`,
                      ),
                    ),
                    state.lastEvidence.insufficient
                      ? h('div', { style: css.muted }, '未达到阈值：本轮按「无足够依据」处理。')
                      : state.lastEvidence.hits.map((hit, i) =>
                          h(
                            'div',
                            { key: `${hit.docName}-${i}`, style: css.ev },
                            h(
                              'div',
                              { style: css.muted },
                              `[K${i + 1}] ${hit.dbName} / ${hit.docName} / 第 ${hit.startLine}-${hit.endLine} 行 · 相关度 ${hit.relevance}`,
                            ),
                            hit.text,
                          ),
                        ),
                  )
                : null,
            )
          : null,
      )
    }

    /* ==================== 侧边栏图标 ==================== */

    function KbIcon(props) {
      const size = props?.size ?? 20
      const active = !!props?.active
      const color = active ? 'var(--dsw-alias-accent, #4c8dff)' : 'currentColor'
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', style: { display: 'block' } },
        h('path', {
          d: 'M5.5 4.6h8.6A2.4 2.4 0 0 1 16.5 7v13H8A2.5 2.5 0 0 1 5.5 17.5z',
          stroke: color,
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M16.5 7h1.4A1.6 1.6 0 0 1 19.5 8.6v9.7A2.7 2.7 0 0 0 16.8 15.7h-.3',
          stroke: color,
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
          opacity: 0.65,
        }),
        h('path', {
          d: 'M8.4 9h4.8M8.4 12.3h4.8',
          stroke: color,
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
      )
    }

    /* ==================== 知识库管理页 ==================== */

    function readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`))
        reader.onload = () => {
          const text = String(reader.result ?? '')
          const idx = text.indexOf(',')
          resolve(idx >= 0 ? text.slice(idx + 1) : text)
        }
        reader.readAsDataURL(file)
      })
    }

    function downloadText(name, content, type) {
      const blob = new Blob([content], { type: type || 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    }

    const TABS = [
      ['docs', '文档'],
      ['import', '导入'],
      ['fill', '数据填补'],
      ['audit', '操作日志'],
    ]

    function KbPanel() {
      const [dbs, setDbs] = useState([])
      const [cur, setCur] = useState('')
      const [tab, setTab] = useState('docs')
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [filter, setFilter] = useState('')

      const [newName, setNewName] = useState('')
      const [docs, setDocs] = useState([])
      const [editing, setEditing] = useState(null)
      const [pathInput, setPathInput] = useState('')
      const [importMode, setImportMode] = useState('overwrite')
      const [importResults, setImportResults] = useState([])
      const [dragging, setDragging] = useState(false)

      const [gaps, setGaps] = useState(null)
      const [suggestions, setSuggestions] = useState([])
      const [audit, setAudit] = useState([])

      const refreshDbs = useCallback(async () => {
        const data = await api('state')
        setDbs(data.databases ?? [])
        setCur((prev) => (prev && (data.databases ?? []).some((d) => d.id === prev) ? prev : (data.databases?.[0]?.id ?? '')))
      }, [])

      const loadDocs = useCallback(async (dbid) => {
        if (!dbid) {
          setDocs([])
          return
        }
        const data = await api('documents', { dbid })
        setDocs(data.documents ?? [])
      }, [])

      const loadFill = useCallback(async (dbid) => {
        if (!dbid) {
          setSuggestions([])
          setGaps(null)
          return
        }
        const [d, l] = await Promise.all([api('fill.detect', { dbid }), api('fill.list', { dbid })])
        setGaps(d)
        setSuggestions(l.suggestions ?? [])
      }, [])

      const loadAudit = useCallback(async (dbid) => {
        const data = await api('audit', { limit: 120, dbid: dbid || undefined })
        setAudit(data.audit ?? [])
      }, [])

      useEffect(() => {
        refreshDbs().catch((err) => setError(String(err.message ?? err)))
      }, [refreshDbs])

      useEffect(() => {
        loadDocs(cur).catch((err) => setError(String(err.message ?? err)))
      }, [cur, loadDocs])

      useEffect(() => {
        if (tab === 'fill') loadFill(cur).catch((err) => setError(String(err.message ?? err)))
        if (tab === 'audit') loadAudit(cur).catch((err) => setError(String(err.message ?? err)))
      }, [tab, cur, loadFill, loadAudit])

      const run = async (label, fn, after) => {
        setBusy(label)
        setError('')
        setNotice('')
        try {
          const result = await fn()
          if (after) await after()
          return result
        } catch (err) {
          setError(String(err.message ?? err))
          return null
        } finally {
          setBusy('')
        }
      }

      const current = dbs.find((d) => d.id === cur) ?? null

      /* ---- 库操作 ---- */

      const createDb = () =>
        run('create', () => api('database.create', { name: newName.trim(), description: '' }), async () => {
          setNewName('')
          await refreshDbs()
          setNotice('知识库已创建，去「导入」加数据。')
        })

      const patchDb = (patch) =>
        run('patch', () => api('database.update', { id: cur, patch }), async () => {
          await refreshDbs()
          setEditing(null)
        })

      const removeDb = () => {
        if (!current) return
        const ok = window.confirm(`删除知识库「${current.name}」？其中的文档、索引、填补建议都会一起删除，操作会记入日志。`)
        if (!ok) return
        run('delete', () => api('database.delete', { id: cur }), async () => {
          setCur('')
          await refreshDbs()
          setNotice('知识库已删除。')
        })
      }

      const duplicateDb = () =>
        run('dup', () => api('database.duplicate', { id: cur }), async () => {
          await refreshDbs()
          setNotice('已复制为「… 副本」。')
        })

      const exportDb = (format) =>
        run('export', async () => {
          const data = await api('database.export', { id: cur, format })
          if (format === 'md') downloadText(data.name, data.markdown, 'text/markdown;charset=utf-8')
          else downloadText(data.name, JSON.stringify(data.payload, null, 2))
        })

      /* ---- 导入 ---- */

      const importFiles = (fileList) => {
        const files = Array.from(fileList ?? [])
        if (files.length === 0 || !cur) return
        run(
          'import',
          async () => {
            const payload = []
            for (const file of files) {
              const isText = /\.(md|markdown|txt|csv|tsv|json|jsonl|ndjson|ya?ml)$/i.test(file.name)
              const item = { name: file.name }
              if (isText) item.text = await file.text()
              else item.base64 = await readFileAsBase64(file)
              payload.push(item)
            }
            return api('import.batch', { dbid: cur, files: payload, mode: importMode })
          },
          null,
        ).then((data) => {
          if (!data) return
          setImportResults(data.results ?? [])
          setNotice(`导入完成：成功 ${data.succeeded} / ${data.total}，新增 ${data.chunks} 个片段。`)
          loadDocs(cur).catch(() => {})
          refreshDbs().catch(() => {})
        })
      }

      const importPath = () =>
        run('import.path', () => api('import', { dbid: cur, path: pathInput.trim(), mode: importMode }), async () => {
          setPathInput('')
          await loadDocs(cur)
          await refreshDbs()
        })

      /* ---- 填补 ---- */

      const proposeFill = () =>
        run('propose', () => api('fill.propose', { dbid: cur }), async () => {
          await loadFill(cur)
          setNotice('已生成填补建议（原数据未改动），逐条确认才会写回。')
        })

      const decideFill = (id, accept) =>
        run(`decide:${id}`, () => api('fill.decide', { id, accept }), async () => {
          await loadFill(cur)
          await loadDocs(cur)
        })

      const revertFill = (id) =>
        run(`revert:${id}`, () => api('fill.revert', { id }), async () => {
          await loadFill(cur)
          await loadDocs(cur)
        })

      /* ---- 渲染 ---- */

      const visibleDbs = dbs.filter((d) => filter.trim() === '' || d.name.toLowerCase().includes(filter.trim().toLowerCase()))
      const pendingCount = suggestions.filter((s) => s.status === 'pending').length

      return h(
        'div',
        { style: css.page },
        h(
          'div',
          { style: css.header },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, '知识库'),
          h('span', { style: css.muted }, '对话绑定库后，回答只能基于库内内容并给出引用'),
          h('div', { style: { flex: 1 } }),
          h(
            'input',
            {
              style: { ...css.input, flex: '0 0 200px' },
              placeholder: '按名称筛选…',
              value: filter,
              onChange: (e) => setFilter(e.target.value),
            },
          ),
        ),
        error ? h('div', { style: css.err }, error) : null,
        notice ? h('div', { style: css.ok }, notice) : null,
        h(
          'div',
          { style: css.cols },
          /* ---------- 左：库列表 ---------- */
          h(
            'div',
            { style: css.left },
            h(
              'div',
              { style: css.row },
              h('input', {
                style: css.input,
                placeholder: '新知识库名称',
                value: newName,
                onChange: (e) => setNewName(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter' && newName.trim() !== '') createDb()
                },
              }),
              h(
                'button',
                { style: css.btn, disabled: busy !== '' || newName.trim() === '', onClick: createDb },
                '新建',
              ),
            ),
            visibleDbs.length === 0
              ? h('div', { style: css.muted }, '还没有知识库。先在上面起一个名字，然后导入数据。')
              : visibleDbs.map((db) =>
                  h(
                    'div',
                    {
                      key: db.id,
                      style: { ...css.dbRow, ...(db.id === cur ? css.dbRowActive : null) },
                      onClick: () => setCur(db.id),
                    },
                    h(
                      'div',
                      { style: { minWidth: 0 } },
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                        h('span', { style: css.dot(db.color) }),
                        h('strong', { style: { fontSize: 13 } }, db.name),
                        db.enabled ? null : h('span', { style: css.badge }, '已停用'),
                      ),
                      h(
                        'div',
                        { style: css.muted },
                        `${db.doc_count ?? 0} 个文档 · ${db.chunk_count ?? 0} 个片段${db.description ? ` · ${db.description}` : ''}`,
                      ),
                    ),
                    h(
                      'div',
                      { style: { display: 'flex', gap: 4 } },
                      h(
                        'button',
                        {
                          style: css.miniBtn,
                          title: db.enabled ? '停用（不再参与检索）' : '启用',
                          onClick: (e) => {
                            e.stopPropagation()
                            setCur(db.id)
                            run('toggle', () => api('database.update', { id: db.id, patch: { enabled: !db.enabled } }), refreshDbs)
                          },
                        },
                        db.enabled ? '停用' : '启用',
                      ),
                    ),
                  ),
                ),
          ),
          /* ---------- 右：库详情 ---------- */
          h(
            'div',
            { style: css.right },
            current === null
              ? h('div', { style: css.muted }, '选择左边的一个知识库查看内容。')
              : h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { style: css.row },
                    h('strong', { style: { fontSize: 14 } }, current.name),
                    h('div', { style: { flex: 1 } }),
                    h('button', { style: css.miniBtn, onClick: () => setEditing(editing ? null : { name: current.name, description: current.description ?? '' }) }, '重命名/描述'),
                    h('button', { style: css.miniBtn, disabled: busy !== '', onClick: duplicateDb }, '复制'),
                    h('button', { style: css.miniBtn, disabled: busy !== '', onClick: () => exportDb('json') }, '导出 JSON'),
                    h('button', { style: css.miniBtn, disabled: busy !== '', onClick: () => exportDb('md') }, '导出 Markdown'),
                    h('button', { style: { ...css.miniBtn, color: 'var(--dsw-alias-danger, #e5484d)' }, disabled: busy !== '', onClick: removeDb }, '删除'),
                  ),
                  editing
                    ? h(
                        'div',
                        { style: css.card },
                        h('input', {
                          style: css.input,
                          value: editing.name,
                          placeholder: '名称',
                          onChange: (e) => setEditing({ ...editing, name: e.target.value }),
                        }),
                        h('input', {
                          style: css.input,
                          value: editing.description,
                          placeholder: '描述（会显示在列表里）',
                          onChange: (e) => setEditing({ ...editing, description: e.target.value }),
                        }),
                        h(
                          'button',
                          {
                            style: css.btn,
                            disabled: busy !== '' || editing.name.trim() === '',
                            onClick: () => patchDb({ name: editing.name.trim(), description: editing.description }),
                          },
                          '保存',
                        ),
                      )
                    : null,
                  h(
                    'div',
                    { style: css.tabs },
                    TABS.map(([key, label]) =>
                      h(
                        'button',
                        { key, style: { ...css.tab, ...(tab === key ? css.tabActive : null) }, onClick: () => setTab(key) },
                        label,
                        key === 'fill' && pendingCount > 0 ? h('span', { style: css.badge }, ` ${pendingCount} 待确认`) : null,
                      ),
                    ),
                  ),
                  /* --- 文档 --- */
                  tab === 'docs'
                    ? h(
                        'div',
                        { style: css.body },
                        docs.length === 0
                          ? h('div', { style: css.muted }, '这个库还没有文档。切到「导入」页上传 CSV / Excel / PDF / Word / Markdown…')
                          : docs.map((doc) =>
                              h(
                                'div',
                                { key: doc.id, style: css.docRow },
                                h(
                                  'div',
                                  { style: { minWidth: 0 } },
                                  h('strong', { style: { fontSize: 13 } }, doc.name),
                                  h(
                                    'div',
                                    { style: css.muted },
                                    `${doc.format} · ${doc.chunkCount ?? 0} 片段${doc.recordCount ? ` · ${doc.recordCount} 行` : ''}${doc.fields?.length ? ` · 字段：${doc.fields.join(' / ')}` : ''}`,
                                  ),
                                ),
                                h(
                                  'button',
                                  {
                                    style: css.miniBtn,
                                    onClick: () => {
                                      const ok = window.confirm(`删除文档「${doc.name}」及它的索引？`)
                                      if (!ok) return
                                      run('del-doc', () => api('documents.delete', { dbid: cur, docid: doc.id }), async () => {
                                        await loadDocs(cur)
                                        await refreshDbs()
                                      })
                                    },
                                  },
                                  '删除',
                                ),
                              ),
                            ),
                      )
                    : null,
                  /* --- 导入 --- */
                  tab === 'import'
                    ? h(
                        'div',
                        { style: css.body },
                        h(
                          'div',
                          {
                            style: { ...css.drop, ...(dragging ? css.dropActive : null) },
                            onDragOver: (e) => {
                              e.preventDefault()
                              setDragging(true)
                            },
                            onDragLeave: () => setDragging(false),
                            onDrop: (e) => {
                              e.preventDefault()
                              setDragging(false)
                              importFiles(e.dataTransfer?.files)
                            },
                          },
                          h('div', { style: { fontWeight: 600, fontSize: 13 } }, '把文件拖到这里，或'),
                          h(
                            'div',
                            { style: css.row },
                            h(
                              'label',
                              { style: { ...css.btn, cursor: 'pointer' } },
                              '选择文件（可多选）',
                              h('input', {
                                type: 'file',
                                multiple: true,
                                style: { display: 'none' },
                                onChange: (e) => {
                                  importFiles(e.target.files)
                                  e.target.value = ''
                                },
                              }),
                            ),
                            h(
                              'label',
                              { style: { ...css.btn, cursor: 'pointer' } },
                              '选择整个文件夹',
                              h('input', {
                                type: 'file',
                                multiple: true,
                                webkitdirectory: 'true',
                                style: { display: 'none' },
                                onChange: (e) => {
                                  importFiles(e.target.files)
                                  e.target.value = ''
                                },
                              }),
                            ),
                          ),
                          h(
                            'div',
                            { style: css.muted },
                            '支持 CSV / TSV / Excel(xlsx) / JSON / JSONL / YAML / Markdown / TXT / PDF / Word(docx)。扫描件 PDF 需先 OCR。',
                          ),
                        ),
                        h(
                          'div',
                          { style: css.row },
                          h(
                            'select',
                            { style: css.input, value: importMode, onChange: (e) => setImportMode(e.target.value) },
                            h('option', { value: 'overwrite' }, '覆盖同名文档'),
                            h('option', { value: 'append' }, '追加同名文档'),
                            h('option', { value: 'skip' }, '同名跳过'),
                          ),
                          h('input', {
                            style: css.input,
                            placeholder: '或填本机绝对路径（如 C:\\资料\\政策.pdf）',
                            value: pathInput,
                            onChange: (e) => setPathInput(e.target.value),
                          }),
                          h(
                            'button',
                            { style: css.btn, disabled: busy !== '' || pathInput.trim() === '', onClick: importPath },
                            '按路径导入',
                          ),
                        ),
                        busy === 'import' ? h('div', { style: css.muted }, '正在解析并建索引…') : null,
                        importResults.length === 0
                          ? null
                          : h(
                              'div',
                              { style: css.card },
                              h(
                                'div',
                                { style: css.row },
                                h('strong', { style: { fontSize: 12 } }, '导入结果'),
                                h('div', { style: { flex: 1 } }),
                                h(
                                  'button',
                                  {
                                    style: css.miniBtn,
                                    onClick: () =>
                                      downloadText(
                                        'import-report.json',
                                        JSON.stringify(importResults, null, 2),
                                      ),
                                  },
                                  '下载错误报告',
                                ),
                              ),
                              importResults.map((r, i) =>
                                h(
                                  'div',
                                  { key: i, style: r.ok ? css.muted : css.errLine },
                                  `${r.ok ? '✓' : '✗'} ${r.name} — ${
                                    r.ok
                                      ? `${r.chunks} 片段${r.records ? ` / ${r.records} 行` : ''}${r.skipped ? '（跳过）' : ''}`
                                      : r.reason
                                  }`,
                                ),
                              ),
                            ),
                      )
                    : null,
                  /* --- 填补 --- */
                  tab === 'fill'
                    ? h(
                        'div',
                        { style: css.body },
                        h(
                          'div',
                          { style: css.row },
                          h(
                            'button',
                            { style: css.btn, disabled: busy !== '', onClick: proposeFill },
                            '扫描缺口并生成建议',
                          ),
                          gaps
                            ? h(
                                'span',
                                { style: css.muted },
                                `缺口 ${gaps.total ?? 0} 个${gaps.byIssue ? `（空值 ${gaps.byIssue.empty ?? 0} / 格式 ${gaps.byIssue.format ?? 0}）` : ''}`,
                              )
                            : null,
                          h('div', { style: { flex: 1 } }),
                          h('span', { style: css.muted }, '建议一律先预览，确认后才写回；无可靠依据的会标明。'),
                        ),
                        suggestions.length === 0
                          ? h('div', { style: css.muted }, '还没有填补建议。')
                          : suggestions.map((s) =>
                              h(
                                'div',
                                { key: s.id, style: css.card },
                                h(
                                  'div',
                                  { style: css.row },
                                  h('strong', { style: { fontSize: 12 } }, `${s.docName ?? ''} 第 ${s.rowNo} 行 · ${s.field}`),
                                  h('span', { style: css.badge }, s.status === 'pending' ? `待确认 · ${s.method}` : s.status),
                                  s.method === 'none' ? h('span', { style: { ...css.badge, color: 'var(--dsw-alias-danger, #e5484d)' } }, '无可靠依据') : null,
                                ),
                                h('div', { style: { fontSize: 12, marginTop: 4 } }, `原值：${s.oldValue === '' ? '（空）' : s.oldValue}　→　建议：${s.newValue === '' ? '（不填）' : s.newValue}`),
                                h('div', { style: css.muted }, `依据：${s.basis}`),
                                s.status === 'pending'
                                  ? h(
                                      'div',
                                      { style: { ...css.row, marginTop: 6 } },
                                      h(
                                        'button',
                                        {
                                          style: css.miniBtn,
                                          disabled: busy !== '' || s.method === 'none',
                                          title: s.method === 'none' ? '无可靠依据，需人工补录' : '',
                                          onClick: () => decideFill(s.id, true),
                                        },
                                        '采纳',
                                      ),
                                      h('button', { style: css.miniBtn, disabled: busy !== '', onClick: () => decideFill(s.id, false) }, '拒绝'),
                                    )
                                  : s.status === 'accepted'
                                    ? h(
                                        'div',
                                        { style: { ...css.row, marginTop: 6 } },
                                        h('button', { style: css.miniBtn, disabled: busy !== '', onClick: () => revertFill(s.id) }, '撤销采纳'),
                                      )
                                    : null,
                              ),
                            ),
                      )
                    : null,
                  /* --- 审计 --- */
                  tab === 'audit'
                    ? h(
                        'div',
                        { style: css.body },
                        audit.length === 0
                          ? h('div', { style: css.muted }, '没有操作记录。')
                          : audit.map((row) =>
                              h(
                                'div',
                                { key: row.id, style: { fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.14))' } },
                                h('span', { style: css.muted }, `${row.ts}　`),
                                h('strong', null, row.action),
                                h('span', { style: css.muted }, row.detail ? `　${row.detail}` : ''),
                              ),
                            ),
                      )
                    : null,
                ),
          ),
        ),
      )
    }

    const KbPanelSafe = () => h(Boundary, null, h(KbPanel))
    const KbIconSafe = (props) => h(Boundary, null, h(KbIcon, props))

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            { name: 'conversation.input.dock', id: 'kb-notebook-scope', order: 40 },
            ScopeBar,
          ),
        )
        // 侧边栏入口 + 主面板：点侧边栏图标切到知识库管理页
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'kb-notebook', order: 60, label: () => '知识库' },
            KbIconSafe,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'kb-notebook' }, KbPanelSafe),
        )
      },
    }
  },
})
