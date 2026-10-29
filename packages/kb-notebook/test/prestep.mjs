/**
 * pre-step 注入链路验证。
 *
 * 不用真开对话：把 apply() 挂到 mock ctx 上，取出注册进 'agent/pre-step' 的
 * 监听器，喂一条假的用户消息，看返回的 messages 里有没有证据块。
 * 这是「回答前必须先检索」这条硬要求的最小可执行证明。
 */
import { existsSync } from 'node:fs'

const HOST_HOME = process.env.DSH_HOME || 'C:/Users/ASUS/.dsh'
process.env.DSH_HOME = HOST_HOME

const { dbPath } = await import('../lib/store.mjs')
console.log('数据文件:', dbPath(), existsSync(dbPath()) ? '(存在)' : '(不存在)')
if (!existsSync(dbPath())) {
  console.log('宿主数据文件还没建出来，先跳过')
  process.exit(0)
}

const handlers = {}
const mockCtx = {
  webServer: { register: () => () => {} },
  on: (name, fn) => {
    handlers[name] = fn
    return () => {}
  },
  systemPrompt: { section: () => () => {} },
  effect: (fn) => fn(),
  logger: { warn: (...a) => console.log('  [warn]', ...a) },
}

const mod = await import('../index.mjs')
mod.apply(mockCtx)

console.log('注册到的监听器:', Object.keys(handlers).join(', '))

const preStep = handlers['agent/pre-step']
if (!preStep) {
  console.log('FAIL: 没有注册 agent/pre-step')
  process.exit(1)
}

const userMsg = { id: 'm1', role: 'user', content: [{ type: 'text', text: '退货要多久' }] }
const base = { kind: 'enter', messages: [userMsg] }
const payload = { agent: { id: 'sess_probe' }, turn: 1, step: 1, messages: [userMsg], signal: new AbortController().signal }
const next = async () => base

const out = await preStep(payload, next)
const blocks = out.messages?.[0]?.content ?? []
const text = blocks.map((b) => b.text ?? '').join('')

console.log('\n--- 注入后的 user 消息 content 块数:', blocks.length, '---')
const hasEvidence = text.includes('<kb-evidence>')
const hasK1 = /\[K1\]/.test(text)
const hasRule = text.includes('<kb-rule>')
const hasOrigin = text.includes('退货')

console.log('含 <kb-evidence>：', hasEvidence)
console.log('含 [K1] 编号：', hasK1)
console.log('含 <kb-rule> 严格规则：', hasRule)
console.log('含原文片段：', hasOrigin)

// 同一 turn 的第二步不应重复注入（成本控制）
const second = await preStep({ ...payload, step: 2 }, next)
const secondText = (second.messages?.[0]?.content ?? []).map((b) => b.text ?? '').join('')
const deduped = !secondText.includes('<kb-evidence>')
console.log('同一 turn 第二步不重复检索：', deduped)

// 未绑定的会话不应注入
const stranger = await preStep({ agent: { id: 'sess_nobody' }, turn: 1, step: 1, messages: [userMsg], signal: payload.signal }, next)
const strangerText = (stranger.messages?.[0]?.content ?? []).map((b) => b.text ?? '').join('')
console.log('未绑定会话不注入：', !strangerText.includes('<kb-evidence>'))

console.log('\n--- 前 14 行注入内容 ---')
console.log(
  text
    .split('\n')
    .slice(0, 14)
    .map((l) => '  ' + l)
    .join('\n'),
)

const pass = hasEvidence && hasK1 && hasRule && hasOrigin && deduped
console.log('\n' + (pass ? 'ALL PASS' : 'HAS FAILURES'))
process.exit(pass ? 0 : 1)
