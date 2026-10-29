/**
 * 演示脚本的共用脚手架。
 *
 * 三个演示场景都要「像真实对话那样」跑一遍，但又不想真去点 GUI，
 * 所以这里把插件的宿主半边挂到 mock ctx 上，直接调用它注册出来的
 * HTTP 路由与 pre-step 监听器——走的是和线上完全相同的代码路径，
 * 只是少了网络与浏览器这两层。
 *
 * 每个场景用独立的 DSH_HOME，跑完即弃，互不污染，随时可以重跑。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 演示数据落盘位置（在 demo/.home/<场景名> 下，每次重跑先清空）。 */
export function freshHome(name) {
  const home = join(HERE, '.home', name)
  if (existsSync(home)) rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  return home
}

/** 演示用样本目录（仓库根的 samples/）。 */
export const SAMPLES = resolve(HERE, '..', '..', '..', 'samples')

export function sample(name) {
  return readFileSync(join(SAMPLES, name), 'utf8')
}

/* ------------------------------------------------------------------ mock */

function fakeReq({ body, url = '/__kb/x', method = 'POST' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    url,
    method,
    headers: { host: '127.0.0.1:56905', 'content-type': 'application/json' },
    on(event, cb) {
      if (event === 'data') {
        for (const c of chunks) cb(c)
      } else if (event === 'end') {
        queueMicrotask(() => cb())
      } else if (event === 'error') {
        /* 不触发 */
      }
      return req
    },
    destroy() {},
  }
  return req
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers ?? {})
      return this
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(payload) {
      this.body = payload === undefined ? '' : String(payload)
      return this
    },
  }
  return res
}

/**
 * 挂载插件，返回直接调用它的接口。
 * `routes` 的 key 是去掉 `/__kb/` 前缀后的路由名，例如 `database.create`。
 */
export async function boot() {
  const handlers = {}
  const routes = new Map()
  const sections = []

  const ctx = {
    webServer: {
      register({ path, handler }) {
        routes.set(path.replace(/^\/__kb\//, ''), handler)
        return () => {}
      },
    },
    on(name, fn) {
      handlers[name] = fn
      return () => {}
    },
    systemPrompt: {
      section(spec) {
        sections.push(spec)
        return () => {}
      },
    },
    effect(fn) {
      const dispose = fn()
      return () => dispose?.()
    },
    logger: { warn: (...args) => console.warn('  [host warn]', ...args) },
  }

  const { apply } = await import('../index.mjs')
  apply(ctx)

  /** 直接调一条 HTTP 路由；返回解析后的 JSON。 */
  const call = async (name, body, opts = {}) => {
    const handler = routes.get(name)
    if (!handler) throw new Error(`没有这条路由：${name}`)
    const req = fakeReq({ body, url: opts.url ?? `/__kb/${name}`, method: opts.method ?? 'POST' })
    const res = fakeRes()
    await handler(req, res)
    let json = null
    try {
      json = JSON.parse(res.body)
    } catch {
      json = { raw: res.body }
    }
    if (res.statusCode >= 400 || json?.ok === false) {
      throw new Error(`${name} → ${res.statusCode} ${json?.error ?? res.body}`)
    }
    return json
  }

  /** 模拟一次用户提问：跑 pre-step，拿到真正会进模型的 messages。 */
  const ask = async (sessionId, text, { turn = 1 } = {}) => {
    const userMessage = { id: `m_${turn}`, role: 'user', content: [{ type: 'text', text }] }
    const base = { kind: 'enter', messages: [userMessage] }
    const out = await handlers['agent/pre-step'](
      { agent: { id: sessionId }, turn, step: 1, messages: [userMessage], signal: new AbortController().signal },
      async () => base,
    )
    // 证据永远追加在最后一条 user 消息的 content 末尾
    const blocks = out.messages[out.messages.length - 1].content
    const injected = blocks.length > 1 ? blocks.slice(1).map((b) => b.text).join('\n') : ''
    return { messages: out.messages, injected }
  }

  /** 模拟一次模型调用前的配置（严格模式会压温度）。 */
  const requestConfig = async (sessionId, config = { provider: 'p', model: 'm', temperature: 0.9 }) => {
    const listener = handlers['agent/request']
    if (!listener) return config
    return listener({ agent: { id: sessionId } }, async () => config)
  }

  return { ctx, handlers, routes, sections, call, ask, requestConfig }
}

/* --------------------------------------------------------------- 输出美化 */

export const line = (label, value = '') => console.log(`  ${label}${value === '' ? '' : '  ' + value}`)
export const head = (title) => console.log(`\n${'─'.repeat(64)}\n${title}\n${'─'.repeat(64)}`)
export const step = (n, title) => console.log(`\n[${n}] ${title}`)
export const indent = (text, pad = '      ') =>
  String(text ?? '')
    .split('\n')
    .map((l) => pad + l)
    .join('\n')
