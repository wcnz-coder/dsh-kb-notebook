# kb-notebook —— DeepSeek Harness「可导入知识库」插件设计方案 v0.1

> 目标产品形态：NotebookLM 式「资料库 → 绑定对话 → 严格引用作答」。
> 本文只是方案，**未写任何代码、未安装插件**。确认后再进入编码。

平台事实均已在当前安装上用 `cordis_inspect_query` 核实，标注在每节「依据」处。

---

## 1. 需求理解与边界

### 1.1 一句话定义

给 DSH 增加一层「受控事实来源」：用户把 CSV/Excel/JSON/Markdown/TXT/PDF/Word 导入若干互相隔离的**知识库**，在会话里绑定其中 1~N 个；此后模型每一步都在**先检索、后作答**的约束下工作，答案带可展开的引用，检索不到依据时必须明说「当前所选数据库中未找到足够依据」。

### 1.2 六块能力 → 落到哪个系统层

| 需求块 | 承载层 | 说明 |
|---|---|---|
| 多数据库管理 | Host storage domain + Client 知识库页面 | 库是持久实体，全生命周期可审计 |
| 新建对话选库 | Client composer dock / hero options + Host 绑定表 | 绑定关系 per-session 持久化 |
| 导入数据 | Host 解析管线 + Client 导入向导 | 上传→解析→预览→映射→去重→错误报告→确认 |
| 数据填补 | Host 建议引擎 + Client 审阅面板 | 一律「建议态」，人工采纳才落库 |
| 严格依据作答 | Host `agent/pre-step` + `agent/request` + `systemPrompt` | 本插件的技术核心 |
| 对话与创作体验 | Client slots | 左侧库/文档、右侧对话与引用 |

### 1.3 明确边界（不做 / 做不到，必须提前对齐）

1. **不做向量数据库**。当前 Harness 没有内置 embedding 服务（`Service` 目录无 embeddings 类服务，只有 chat 型 `llm`）。本方案用「自建 BM25 倒排 + 可选 LLM/外部 embedding 语义重排」实现混合检索，默认零外部依赖。见 §4.2。
2. **不做扫描件 OCR**。PDF 只抽取文本层；纯图片 PDF 会明确报「无文本层，需先 OCR」，不假装解析成功。
3. **不做跨库自动融合推理**。多库绑定时各库独立检索、结果分区呈现，引用必须标明来自哪个库，禁止把两库内容拼成一条无来源结论。
4. **不做「自动改数据」**。填补建议永不自动写入；导入覆盖必须显式确认并保留可回滚快照。
5. **不做多用户 ACL**。DSH 是单机单用户模型，权限落地为：会话级绑定隔离 + 写操作审计 + 危险操作二次确认 + 软删除，不伪造一套假的角色体系。
6. **不改 Harness 的会话事件格式**。不 append 自定义 `type` 的 session event（会导致会话无法重开），插件自有数据一律走 storage domain。依据：`practices.md:21`。
7. **不引 iframe、不引 Harness Client 包**。页面是 React 组件挂在 slot 上，样式只用 `--dsw-alias-*` token。依据：`practices.md:33,35`。

### 1.4 「严格模式」的可验证定义

不是提示词里写「请严格」，而是四条硬机制：

- **M1 强制检索**：`agent/pre-step` 里对本步进入的用户消息做检索，证据以结构化块注入，未绑定库时注入「不得引用知识库」的约束块。
- **M2 低温度**：`agent/request` 把该会话的 `LlmCallConfig.temperature` 钳到配置值（默认 0.1）。
- **M3 引用强制**：系统提示段规定输出末尾必须给 `引用:` 列表；证据块里每个片段有稳定 id，模型只能引用这些 id。
- **M4 无依据话术**：证据集为空或全部低于阈值时，注入「必须原样回复缺失句式并反问」的指令；UI 同时把本轮标记为 `no-evidence`，答完后可一键进入「补数据」流程。

宽松模式 = 关闭 M2、把阈值降到 0、允许模型常识但每条常识断言必须前缀 `[非资料]`。

---

## 2. 插件架构与页面流程

### 2.1 交付形态

一个 bundle 包（USB 式自包含目录，装到 profile 后再由 Loader 挂载）：

```
kb-notebook/
  package.json          # dsh.bundle.patch + dsh.client + exports("./locale/*.json","./icon")
  cordis.patch.yml      # 插入一行 host 插件
  index.mjs             # Host 入口：export const inject = [...] / export function apply(ctx, config)
  client.js             # Client 入口：懒工厂，注册 slots
  locale/en.json zh.json
  icon.svg
  lib/
    store/              # domain spec、迁移、审计
    ingest/             # 解析器（text/zip-xlsx/zip-docx/pdf）、分段、去重
    index/              # 分词、倒排、BM25、重排
    retrieve/           # 检索编排、证据包编解码
    fill/               # 填补建议引擎
    host/               # routes、tools、commands、prompt 段、pre-step 钩子
    ui/                 # 知识库页面、选择器、导入向导、引用面板、填补审阅
  docs/README.md 使用说明.md  demo/*.csv demo/*.md demo/*.jsonl
```

### 2.2 Host 侧注册清单

| 机制 | 用途 |
|---|---|
| `ctx.storageDomain.open(spec)` | 全部持久化（库、文档、分段、行、倒排、绑定、建议、审计、笔记） |
| `ctx.webServer.register({kind:'prefix', path:'/__kb'})` | Client↔Host 唯一通道（JSON over fetch） |
| `ctx.on('agent/pre-step', …)` | 强制检索 + 证据注入（waterfall） |
| `ctx.on('agent/request', …)` | 严格模式温度钳制（waterfall） |
| `ctx.systemPrompt.section({name:'tool:kb-notebook', order})` | 知识库工作规则段 |
| `ctx.systemPrompt.context(...)` | 当前会话绑定范围的动态提示（可选） |
| `ctx.tools.register(...)` | `kb_search` / `kb_chunk` / `kb_bindings` / `kb_fill_suggest` |
| `ctx.commands.register(...)` | `/kb`（绑定/解绑/状态）、`/kb-strict`、`/kb-import` |
| `ctx.attachments` | 上传文件落地（`saveFileStream` / `readFileStream`） |
| `ctx.spillStore.saveText` | 大错误报告、导出文件落盘 |

依据：`Service` 目录含 `storageDomain`、`webServer`、`systemPrompt`、`tools`、`commands`、`attachments`、`spillStore`；`Event` 目录含 `agent/pre-step`（waterfall，可返回 `{kind:'enter', messages}`）、`agent/request`（waterfall，返回 `LlmCallConfig`）。已用 `beauticode-dsh` 的 `index.mjs:233` 与 `agent.mjs:551,690,707` 验证同样写法在纯 JS bundle 中可直接运行。

### 2.3 Client 侧挂载点

| Slot | 内容 |
|---|---|
| `sidebar.panellist` | 「知识库」图标入口 → `ctx.layout.selectPanel('kb-notebook')` |
| `main` (keyed, `'kb-notebook'`) | 知识库工作台（左：库/文档树；右：详情、导入、填补、审计） |
| `conversation.input.dock` | 绑定条：`已绑定 2 个库：制度库 ▸ 产品库 ✎`，点击开选择器 |
| `conversation.hero.options` | 空白会话里的「选择知识库」快捷入口（对应「新建对话即弹选择器」） |
| `shell.overlay` | 库选择器弹层、导入向导、引用详情抽屉 |
| `conversation.chat.assistant-actions` | 每条回答加「引用 (n)」按钮 → 展开片段原文 |
| `conversation.chat.turnTail` | 本轮检索摘要行（`命中 6 段 / 最高分 0.72 / 严格模式`） |
| `settings.section` | 「知识库」设置页（默认严格模式、阈值、topK、温度、重排开关） |

依据：`Slots.listSubTree` 中 `sidebar.panellist`、`main`（`keyDomain: open`）、`conversation.input.dock`、`conversation.hero.options`、`shell.overlay`、`conversation.chat.assistant-actions`、`conversation.chat.turnTail`、`settings.section` 均存在且为可加注册的 list/keyed 座位；`Client Service` 目录含 `layout.selectPanel(panelId)`、`locale`、`slots`、`theme`。

### 2.4 页面流程

**A. 建库导入**
```
侧栏「知识库」→ 工作台 → 新建库（名称/描述/图标/颜色）
  → 拖拽/选择文件/选文件夹 → 逐个文件解析（进度条 + 单文件状态）
  → 预览：文本首 200 段 / 表格前 50 行
  → 字段映射（列名→字段名、类型、主键/唯一键、必填）
  → 去重检测（sha256 整文件 + 分段内文哈希）
  → 错误报告（失败行号 + 原因，可下载 .csv）
  → 确认入库（追加 / 覆盖，覆盖前自动快照）
  → 完成页：入库条数、索引耗时、跳转「去提问」
```

**B. 绑定与提问**
```
新会话 → hero「选择知识库」（多选 + 搜索 + 最近使用）
  → composer dock 常驻显示绑定范围
  → 发送问题 → 后端检索 → 证据注入 → 模型作答（带 引用: 列表）
  → 回答下方「引用 (4)」→ 抽屉：库名/文档名/页码或行号 → 原文高亮
  → 追加或切换库 → 顶部提示「知识库范围已变化，已重新检索」+ 旧引用标灰
```

**C. 数据填补**
```
库详情 → 数据质量（缺失字段统计 / 格式不一致清单）
  → 选目标字段「生成建议」→ 建议列表（原值/建议值/依据来源/置信度）
  → 逐条或批量「采纳 / 拒绝 / 编辑后采纳」
  → 采纳即写入 + 审计行（谁、何时、依据哪几段/哪几行）
  → 无依据行显式标「无可靠依据」，不可一键采纳
```

**D. 创作与笔记**
```
选中库 → 模板（问答/摘要/改写/扩写/提纲/报告）
  → 生成结果同样带引用
  → 「存为笔记」→ 笔记正文 + 引用快照（库/文档/片段 id）
  → 笔记在知识库工作台「笔记」页可查看/导出 Markdown
```

### 2.5 关键数据流（一次提问）

```
Client 发送用户消息（DSH 原生链路，不拦截）
  └─ Host: agent/pre-step
       1. 读 bindings[sessionId] → 无绑定？注入「禁引用」块，放行
       2. 取本步最后一条 user 文本 → 查询改写（关键词抽取，纯本地）
       3. 每库 BM25 topK → 合并 → 阈值过滤 → 可选语义重排
       4. 拼 <kb-evidence db="…" chunk="…" loc="…">…</kb-evidence>
       5. 返回 {...decision, kind:'enter', messages:[证据块, ...原 messages]}
       6. 快照写入 evidence[sessionId][step]（供 UI 与审计）
  └─ Host: agent/request → temperature=0.1（严格模式）
  └─ 模型作答 → assistant 消息（正文 + 引用 id 列表）
  └─ Client: assistant-actions「引用 (n)」→ GET /__kb/evidence?session&step
```

**为什么用 `agent/pre-step` 而不是 `systemPrompt.context`**：`systemPrompt.context` 的 provider 只拿到 `AssembleContext{scope,signal}`，读不到本轮用户原话，无法「先检索后作答」。`agent/pre-step` 的 payload 带 `messages: UserMessage[]`，且 waterfall 允许替换进入本步的消息。依据：`Event` 目录 `agent/pre-step` 签名与 `PreStepDecision` 类型（`{kind:'enter'; messages; startsRequestSeries?}`）。

**必须遵守**：改写 messages 时 spread 原 decision，保住 `startsRequestSeries`；用 `{...decision, kind:'enter', messages}`。依据：`practices.md:16`。

---

## 3. 数据模型设计

单一 storage domain（`name: 'kb-notebook'`, `version: 1`），6 张表 + global。全部 value 为纯 JSON，zod 校验（profile 内 `zod@3.25.76` 可用）。

### 3.1 表

**`databases`** — 库
```ts
{ id, name, description, icon, color, enabled, createdAt, updatedAt,
  stats: { docs, chunks, records, bytes }, deletedAt?: number }
```

**`documents`** — 文件/文档
```ts
{ id, dbId, name, sourceKind: 'csv'|'xlsx'|'json'|'jsonl'|'md'|'txt'|'pdf'|'docx'|'html'|'paste',
  bytes, sha256, importedAt, parser: {engine, version, warnings: string[]},
  split: {mode:'chunk'|'rows', chunks?: number, rows?: number},
  fields?: FieldSpec[], primaryKey?: string, uniqueKeys?: string[] }
FieldSpec = { name, key, type:'string'|'number'|'date'|'bool', required, sourceColumn }
```

**`chunks`** — 检索最小单元（非结构化文档 / 表格行）
```ts
{ id, dbId, docId, ord, text, summary?, keywords: string[],
  locator: {page?, lineFrom?, lineTo?, rowFrom?, rowTo?, sheet?, cell?},
  hash, createdAt }
```

**`records`** — 结构化行（表格类，供字段级引用与填补）
```ts
{ id, dbId, docId, rowNo, values: Record<string,string|number|null>,
  missing: string[], issues: {field,kind,detail}[] }
```

**`terms`** — 倒排索引（BM25 用）
```ts
key = `${dbId}\u0000${term}` → { term, df, postings: [[chunkId, tf], …] }
```
> 分片写：单表条目数可能上万，按 term 前缀散列到 `terms` 单表即可（KV `put` 逐条写，避免整表重写）。

**`bindings`** — 会话 ↔ 库（per session）
```ts
key = sessionId → { sessionId, dbIds: string[], scopeRev: number,
  mode: 'strict'|'loose', updatedAt, changedAt, changedTimes: number }
```

**`evidence`** — 每次检索快照（引用回溯的唯一依据）
```ts
key = `${sessionId}\u0000${turn}\u0000${step}` →
{ sessionId, turn, step, createdAt, mode, query, perDb: {dbId, hits, topScore, filtered}[],
  items: [{ chunkId, dbId, docId, docName, locator, score, rank, snippet }] }
```
> 只保留最近 N 轮（默认 200），更老的按 session 淘汰。

**`suggestions`** — 填补建议
```ts
{ id, dbId, docId?, recordId?, chunkId?, field, original, proposed,
  basis: {kind:'rule'|'sibling'|'llm'|'none', refs: EvidenceRef[], note},
  status: 'pending'|'accepted'|'rejected', actor, createdAt, decidedAt? }
```

**`audit`** — 操作日志（只追加）
```ts
{ id, at, actor, action, target: {dbId?, docId?, recordId?, sessionId?},
  detail: object, reversible: boolean, undoRef? }
```

**`notes`** — 笔记
```ts
{ id, title, body, createdAt, citations: EvidenceRef[], dbIds: string[] }
```

**`global`** — 设置
```ts
{ strictDefault: true, threshold: 0.35, topK: 8, perDbTopK: 4,
  temperature: 0.1, rerank: 'off'|'llm'|'remote', chunkSize: 900, chunkOverlap: 120,
  lastUsedDbIds: string[] }
```

`EvidenceRef = { dbId, docId, chunkId?, locator, quote }`

### 3.2 隔离与一致性

- **库间隔离**：所有读写函数强制带 `dbId` 且校验 `doc.dbId === dbId`；倒排 term key 前缀含 `dbId`，跨库永不串。检索入口按 `bindings.dbIds` 白名单过滤，白名单外直接丢弃。
- **可撤销**：`documents`/`records` 软删除（`deletedAt`）；覆盖式导入先把受影响文档整体快照到 `snapshots` 表（`key=docId\u0000rev`），撤销即回写。
- **审计**：所有写路径经过 `mutate(action, fn)` 包装，成功后追加 `audit`；失败也记一条 `action+'.failed'`。

---

## 4. 检索与「严格依据数据库」的实现

### 4.1 检索单元与定位

| 源类型 | chunk 切法 | locator |
|---|---|---|
| Markdown/TXT/HTML | 按标题层级优先，再按 `\n\n`，超长按句切（重叠 120 字符） | `lineFrom/lineTo` |
| PDF | 按页抽文本 → 页内按段落切 | `page` + 页内序号 |
| Word | 按段落/标题切 | 段落号 |
| CSV/Excel/JSON | 一行一条 `chunk`（文本化为 `字段: 值` 拼接） | `rowFrom/rowTo`、`sheet` |
| 粘贴文本 | 同 Markdown | `lineFrom/lineTo` |

### 4.2 混合检索（无向量库的落地方式）

**层 1 关键词（必开，纯本地）**
- 中文：bigram + 词典最大匹配（内置 ~300 词业务停用/同义词表）；英文：小写 + 简单词形还原（去 s/ed/ing）。
- 打分 BM25（k1=1.2, b=0.75），字段加权：`text` 1.0、`summary` 0.6、`keywords` 0.8、文档名 1.2。
- 空结果时降级为「子串扫 + 编辑距离 1 容错」，命中仍给低分，标记 `fuzzy`。

**层 2 语义（可选，三档）**
- `off`（默认）：纯 BM25。
- `llm`：对 BM25 top-30 候选，让**当前会话模型**做一次「相关度 0~1 打分 + 是否足以回答」的批处理判定，重新排序并回传 `sufficient: boolean`。复用已有 `llm` 通道，不引新依赖。
- `remote`：配置一个 OpenAI 兼容 embedding 端点（`ctx.web.fetch` + 用户填 key），写入时算向量、查询时算向量做余弦。**这是唯一需要外网/密钥的档位，默认关**。

> 平台限制说明（对齐用户「如平台有限制请说明替代方案」）：Harness 当前不提供 embedding 服务，也不提供内置向量索引。因此默认方案是「BM25 + LLM 重排」，语义召回靠「同义词表 + 关键词扩展 + LLM 判定」补偿；`remote` 档留给愿意配端点的用户。取舍：零依赖可离线跑，代价是纯语义改写（换词但不同词面）的召回弱于真向量库。

### 4.3 证据注入协议（模型看到什么）

在用户消息**之前**插入一条独立 user 消息，格式固定、机器可解析：

```
<kb-evidence scope="db:a1,db:b2" mode="strict" generated="turn3-step2">
<kb-hit id="a1:d7:c12" db="制度库" doc="员工手册.md" loc="line 88-96" score="0.82">
……片段原文（≤700 字符）……
</kb-hit>
<kb-hit id="a1:d7:c19" db="制度库" doc="报销制度.pdf" loc="page 4" score="0.61">…</kb-hit>
</kb-evidence>
<kb-rule mode="strict">
1) 只能依据上面 kb-hit 中的内容陈述事实；每条事实后标 [id]。
2) 回答末尾必须输出「引用：」列表，逐条给 库名 / 文档名 / 位置。
3) 若 kb-hit 为空或不足以回答，必须原样回复：
   「当前所选数据库中未找到足够依据。」并列出缺少什么数据、建议补充哪类文件。
4) 不得用模型自身知识补全缺失事实；确需通用知识时必须显式标注 [非资料]。
</kb-rule>
```

`<kb-evidence>` 里的 `id` 就是引用锚点，UI 用它反查 `evidence` 表拿原文与 locator。

### 4.4 引用回溯链路

模型输出 `... [a1:d7:c12]` → 前端解析出 id 列表 → `GET /__kb/evidence?sessionId&turn&step` → 拿到 `items` → 渲染「库名 / 文档 / 位置 / 原文」。同时 Host 在 `assistant` 消息落定后（`session/event` 监听 `assistant/message`）做一次**引用体检**：

- 严格模式 + 正文有事实句但引用为 0 → 本轮标记 `citation-missing`，turnTail 显示黄标「本轮未给引用」。
- 引用了 `evidence` 里不存在的 id → 标 `citation-invalid`（幻觉 id），UI 红标。
- 体检结果进 `evidence` 表对应行，供审计与设置页统计。

### 4.5 「无依据」的可执行判定

```
hits = retrieve(query, dbIds, topK)
strong = hits.filter(h => h.score >= threshold)
sufficient = strong.length >= 1 && (rerank === 'off' ? true : rerankVerdict.sufficient)
```
- `sufficient=false` → 注入 `<kb-rule mode="insufficient">`：模型必须回缺失句式，且 Host 在 turnTail 里给出「去补充数据」按钮（跳到该库导入向导）。
- 未绑定任何库 + 用户消息命中「根据知识库/资料/文档/引用」意图词 → 不检索，注入 `<kb-rule mode="unbound">`：先提示「请先在下方选择知识库」，不猜答案。

### 4.6 强制检索的成本控制

每个 user turn 只检索一次（`turn` 首次 `pre-step`），同一 turn 的后续 step（tool 回环）复用同一份证据，靠 `<kb-evidence>` 已在消息里保证模型仍看得到。证据块**只在首步注入**，避免历史里堆 N 份。依据：`pre-step` payload 带 `turn`/`step`。

### 4.7 严格模式的四项机械约束

| 项 | 实现 | 默认 |
|---|---|---|
| M1 强制检索 | `agent/pre-step` waterfall | 开（不可关，只能靠「不绑库」等效关闭） |
| M2 低温 | `agent/request` 改 `config.temperature` | 0.1 |
| M3 引用强制 | 系统段 + 证据块规则 + 引用体检 | 开 |
| M4 无依据话术 | 证据不足时注入 `insufficient` 规则 | 开 |

`/kb-strict off` 或设置页切宽松 → M2 置 undefined、阈值 0、规则块改 `mode="loose"`（允许 `[非资料]` 标注后使用常识）。

---

## 5. 开发计划与验收清单

### 5.1 里程碑（每步可独立验证，不攒大爆炸）

| 阶段 | 交付 | 验证动作 |
|---|---|---|
| **M0 骨架**（1 轮） | bundle 可装；知识库页面出现；库 CRUD + 审计；`/__kb` 路由通 | `plugin_manager install_bundle` 后 `application` 生效；页面能建/改名/停用/删除库；`audit` 有行 |
| **M1 绑定**（1 轮） | 会话级绑定表 + composer dock 绑定条 + hero 选择器 + 范围变化提示 | 新建会话选 2 库 → 刷新后仍在 → 切换出现「范围已变化」 |
| **M2 导入**（2 轮） | 文本类全通（csv/json/jsonl/md/txt/paste）+ 预览 + 字段映射 + 去重 + 错误报告 | 拖 3 个文件批量导入，故意混 1 个坏 CSV → 好文件入库、坏文件给行级原因并可下载 |
| **M3 索引检索**（1 轮） | 分词 + 倒排 + BM25 + locator 定位 | `kb_search` 工具能返回带 locator 的命中，人工核对行号/页码正确 |
| **M4 严格模式**（2 轮） | pre-step 注入 + request 温度 + 系统段 + 引用面板 + 体检 | 问一个库里有的问题 → 有引用且能展开；问库里没有的 → 原样缺失句式 |
| **M5 二进制解析**（2 轮） | 纯 JS zip→xlsx/docx 抽取 + 最小 PDF 文本抽取（+ Python 增强器探测） | 导入 .xlsx/.docx/.pdf 成功且 locator 正确；扫描件 PDF 明确报「无文本层」 |
| **M6 填补**（2 轮） | 规则/同表相似/LLM 三路建议 + 审阅面板 + 采纳写回 + 审计 | 制造 10 条空值 → 建议 10 条 → 采纳 3 条 → 数据变了、审计 3 行、原值可查 |
| **M7 体验收尾**（1 轮） | 笔记、导出、设置页、README/使用说明、3 个 demo 场景 | 按文档从零走一遍三个场景 |

> 每阶段结束都做一次「装—用—卸」回归：`set_bundle false` 卸载后不得残留坏行或破坏会话。

### 5.2 验收清单（逐条对应用户要求）

| # | 要求 | 判定方式 | 阶段 |
|---|---|---|---|
| 1 | 多个自定义库、独立管理 | 建 3 库，各自导入不同文件，检索结果不串库 | M0 |
| 2 | 重命名/描述/启用停用/复制/删除/导出 | 每个动作执行后刷新仍生效 | M0 |
| 3 | 拖拽批量导入 CSV/Excel/JSON/MD/TXT/PDF + 预览确认 | 一次拖 6 种格式，6 个预览都可见，确认后入库 | M2/M5 |
| 4 | 新对话多选库 + 显示绑定范围 | hero 多选；composer 常驻显示；header/详情可查 | M1 |
| 5 | 切换/追加库 → 重新检索 + 「范围已变化」提示 | 切库后再问，证据块 scope 变了且 UI 有提示 | M1 |
| 6 | 未选库时不得引用库内容 | 未绑定时问「按资料回答」→ 提示先选库 | M4 |
| 7 | 严格引用 + 无依据明说 | 两问对比：命中给 [id] 引用；未命中给固定缺失句式 | M4 |
| 8 | 每条关键结论可展开引用来源 | 点「引用 (n)」看到 库名/文档/位置/原文 | M4 |
| 9 | 填补预览/确认/拒绝/追溯，不自动覆盖 | 采纳前后数据对比 + 审计三态齐全 | M6 |
| 10 | 导入失败给原因 + 可下载报告 | 坏 CSV → 行号 + 原因 + 下载 | M2 |
| 11 | 增量导入与追加/覆盖策略 | 同文件二次导入：追加不重、覆盖有快照可回滚 | M2 |
| 12 | 结构化字段名/类型/主键/必填配置 | 映射页可配，违反必填在预览即报错 | M2 |
| 13 | 非结构化自动切分/摘要/关键词 | chunk 列表可见 summary 与 keywords | M3 |
| 14 | 严格/宽松开关，默认严格 | 设置页默认 strict；切换后温度与规则块同步变化 | M4 |
| 15 | 可查看每次回答的检索片段 | turnTail + 引用抽屉 + `/__kb/evidence` 一致 | M4 |
| 16 | 操作有权限校验与日志 | 所有写操作落 `audit`；跨库越权被拒 | M0 |
| 17 | 导入/填补可撤销或可追溯 | 覆盖导入可回滚；填补留痕不可篡改 | M2/M6 |
| 18 | 模块化 + 注释 + README + 示例数据 | `docs/` + `demo/` 齐备，按文档可从零复现 | M7 |
| 19 | 3 个演示场景 | 知识问答 / 基于库创作 / 缺失数据填补，各自跑通 | M7 |

### 5.3 已核实的技术前提（避免开工才发现走不通）

| 前提 | 状态 | 依据 |
|---|---|---|
| 纯 JS bundle 能注册 tools/commands/systemPrompt/路由 | ✅ 已验证 | `beauticode-dsh` 的 `index.mjs:233`、`agent.mjs:551,690,707` |
| `agent/pre-step` 可替换进入本步的消息 | ✅ | `Event` 目录 + `PreStepDecision` |
| `agent/request` 可改 temperature | ✅ | `Event` 目录 + `LlmCallConfig{temperature}` |
| 持久化 domain 可用且带 zod 校验 | ✅ | `storageDomain.DomainSpec/KvTable`；`zod@3.25.76` 在 profile |
| Client↔Host 走自建 HTTP 路由可行 | ✅ | `webServer.register(WebRoute)` + 现有插件同款做法 |
| 页面能挂在 `main` keyed slot 并由侧栏打开 | ✅ | `Slots.listSubTree` + `layout.selectPanel` |
| 现在有向量检索服务 | ❌ 无 | 决策：BM25 + LLM 重排 + 可选 remote embedding |
| 本机有 PDF 解析库 | ❌ 无（无 pypdf/pdfminer/pandoc/soffice） | 决策：纯 JS 最小 PDF 文本抽取；Python 有 openpyxl/python-docx 时作增强 |
| 可 append 自定义 session event 类型 | ❌ 禁止 | `practices.md:21`：会导致会话无法重开 |

### 5.4 需要你确认的三件事

1. **检索档位**：默认 `off`（纯 BM25 + 可选 LLM 重排），还是要我一并实现 `remote` embedding 档（需你提供端点与 key）？
2. **二进制解析**：走纯 JS 自写（零依赖、我全程可控，PDF 只支持文本层），还是优先调 Python 子进程（本机有 openpyxl/python-docx，xlsx/docx 更稳，PDF 仍需 JS）？我倾向「纯 JS 为主 + Python 作可选增强」。
3. **交付节奏**：按 M0→M7 逐阶段给你可用的东西（每阶段都能装进 DSH 试），还是先把 M0~M4（能问答出引用）一次做完再交付？

确认后我按 M0 开始写代码。
