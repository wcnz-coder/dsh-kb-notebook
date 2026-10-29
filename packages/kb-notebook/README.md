# 知识库笔记本 · dsh-kb-notebook

给 DeepSeek Harness 用的「可导入知识库 + 严格引用」插件。定位接近 Google NotebookLM：
**你先导入自己的资料，再让 AI 只在选定资料的范围内问答和创作，每句话都能点回原文。**

和市面上那些"RAG 插件"的差别在于——它们大多只做"检索到就给模型"，这里多做了三件它们没做全的事：

| | 常见做法 | 这个插件 |
| --- | --- | --- |
| 库的绑定 | 全局开一个库，所有对话共享 | 每个对话独立绑定，可多选；未绑定时检索**不被调用** |
| 依据强度 | 相关度低也照样塞进去 | 阈值 + 覆盖度双闸，不够就直接告诉模型"没找到依据" |
| 数据补全 | 直接改库 | 只出建议，采纳与否由人决定，全程留痕可撤销 |

---

## 一、安装

插件是一个普通 bundle 包，不依赖任何第三方运行时，也不需要联网装包。

```bash
# 在插件目录里（这个包里已经有 package.json 与 cordis.patch.yml）
# 用宿主提供的安装器安装，不要手写 profile 里的依赖
```

安装走宿主自带的插件管理：

```
plugin_manager  action: install_bundle
                target: <绝对路径>/kb-notebook/packages/kb-notebook
```

装完在 **侧边栏** 会多出一个「知识库」图标，点开就是管理页；输入框上方会多出一条**知识库绑定条**。

安装时若提示 `build-blocked` / `ERR_PNPM_IGNORED_BUILDS`，说明 profile 里有别的包声明了未被批准的构建脚本
（跟本插件无关）。按提示把 `pendingBuilds` 里那串**完整 spec** 原样传进 `approvedBuilds` 即可。

改完宿主代码后重新加载（不必重启 DSH）：

```
plugin_manager  action: set_plugin  target: "include:kb-notebook"  enabled: false
plugin_manager  action: set_plugin  target: "include:kb-notebook"  enabled: true
```

---

## 二、五分钟上手

### 1. 建库并导入

侧边栏「知识库」→ 左栏「新建」→ 起个名字 → 右栏切到「导入」标签：

- 拖文件进虚线框，或点「选择文件（可多选）」，或点「选择整个文件夹」
- 也可以直接填**本机绝对路径**导入（浏览器拿不到绝对路径时用这个）
- 同名文档选「覆盖 / 追加 / 跳过」
- 导入结果逐条列在下面，失败的写明原因，点「下载错误报告」导出 JSON

### 2. 绑定到对话

在输入框上方的知识库条点「管理 / 切换」，勾选要用的库（可多选）。
条上会列出当前绑定的库名，切换后立刻提示「**知识库范围已变化，后续回答将基于新的范围重新检索**」。

没绑定时，条上直接写「未绑定（本轮不会调用任何知识库）」——这时候问"根据我的资料回答"，
插件会让模型先请你选库，而不是硬编一个答案。

### 3. 提问

直接在对话里问。模型收到的是**证据块**而不是整库：

```
<kb-evidence>
[K1] 知识库「售后知识库」/ 文档「售后政策.md」/ 第 9-12 行 / 小节「退款」
## 退款

退货验收通过后 3 个工作日内发起退款，原路退回至付款账户。……
</kb-evidence>
<kb-rule>
本轮处于严格模式：
1. 只能依据上面 <kb-evidence> 中的内容作答，不得使用你自己的常识……
2. 每一个结论句后面必须带引用编号，格式如 [K1]……
3. 证据不足以回答的部分，明确写出「当前所选数据库中未找到足够依据」……
4. 禁止把未出现在证据里的内容写成事实，也不要编造文档名、行号或库名。
</kb-rule>
```

点开知识库条里的「最近一次检索」，能看到本轮**到底检索了什么、命中几条、为什么没命中**。

### 4. 数据填补

管理页「数据填补」标签：

1. 点「体检」——只报告缺口，不动数据
2. 点「生成建议」——每条建议都写清依据（哪个参考行、什么规则）
3. 逐条「采纳」或「拒绝」；标红「无可靠依据」的那条采纳按钮是禁用的
4. 采纳后可「撤销」

### 5. 存笔记 / 导出

- 知识库条上「保存为笔记」把最近一条回答连同来源引用一起存下来
- 管理页右上「导出 JSON / 导出 Markdown」整库导出

---

## 三、三个可跑的演示

不需要开 GUI，也不碰宿主数据库（各用独立 `DSH_HOME`，跑完即弃）：

```bash
cd packages/kb-notebook

node demo/scenario-1-qa.mjs       # 知识问答：有依据就给引用，没依据就明说
node demo/scenario-2-create.mjs   # 基于库的创作：改写/提纲，顺带存笔记、整库导出
node demo/scenario-3-fill.mjs     # 缺失数据填补：预览→采纳→撤销，全程留痕
```

它们调用的是**和线上完全相同的路由与 pre-step 监听器**，只是绕过了网络和浏览器，
所以输出里那一段段 `<kb-evidence>` 就是模型真正看到的东西。

---

## 四、严格模式到底做了什么

不是一句提示词，是四条硬机制：

| | 机制 | 实现位置 | 效果 |
| --- | --- | --- | --- |
| M1 | 回答前强制检索 | `agent/pre-step` 监听器 | 未绑定时**不注入**证据；绑定时把证据追加进本轮 user 消息 |
| M2 | 相关度 + 覆盖度双闸 | `lib/search.mjs` | `relevance ≥ 0.42` 且 `coverage ≥ 0.34`，任一不过就判"无足够依据" |
| M3 | 低温采样 | `agent/request` 监听器 | 绑定了库的严格模式会把 `temperature` 压到 `≤ 0.2` |
| M4 | 常驻规则段 | `systemPrompt.section` | 无论有没有证据，规则都在系统提示里 |

宽松模式（每条绑定单独设置）放宽的是 M2 与 M3：阈值降到 0，温度不动。
M1 和 M4 不变——**宽松不等于可以不看证据**。

---

## 五、检索是怎么做的

没有向量库（宿主不提供 embedding 服务，也不愿意为此拉一个本地模型），
所以用的是**中文友好的 bigram 倒排 + BM25**：

- 分词：全角转半角 → 小写；中文按 2 字滑窗切 bigram，同时补单个汉字；英文按 `[a-z0-9]+` 取词
- 打分：BM25（k1=1.4, b=0.72），命中词覆盖度额外加成 `score × (1 + 0.35 × (hits-1)/terms)`
- 两道闸：归一化相关度 `≥ 0.42`，且覆盖度 `≥ 0.34`
- 每个库一份独立索引，检索只在绑定的库之间跑，跨库不串

一个踩过的坑值得写下来：`"退货要多久"` 会被切成 `退货 / 货要 / 要多 / 多久` 四个 bigram，
而库里根本没有"货要""要多""多久"——如果要求"至少命中 N 个词"，这类自然问句会**永远零召回**。
所以召回阶段一律 OR（`minMatched: 1`），把判断质量的工作交给上面两道闸；
覆盖度的分母也只算"库里真实存在的词"，不让查询侧的跨词伪 bigram 拉低分数。

SQLite 的 FTS5 也试过：`tokenize='trigram'` 对中文两字词（"退货""退款"）零命中，只有 ≥3 字才有效，所以没用它。

---

## 六、支持的格式

| 格式 | 解析方式 | 结构化 | 行号定位 |
| --- | --- | --- | --- |
| `.md` `.markdown` | 直接读文本，按标题切块 | — | ✅ 原始行号 |
| `.txt` | 同上 | — | ✅ |
| `.csv` `.tsv` | RFC4180 引号处理 + 分隔符猜测 | ✅ 字段/类型推断 | ✅ `[行 N]` |
| `.json` | 对象数组转记录 | ✅ | ✅ |
| `.jsonl` `.ndjson` | 逐行对象 | ✅ | ✅ |
| `.yml` `.yaml` | 文本切块 | — | ✅ |
| `.xlsx` `.xlsm` | 自写 zip 解包 + `sharedStrings.xml` + `sheet*.xml` | ✅ 多 sheet | ✅ `[行 N]` |
| `.docx` | 自写 zip 解包 + `word/document.xml`（`w:p`/`w:t`/`w:br`/`w:tc`） | — | ✅ 段落行号 |
| `.pdf` | 自写 stream 解压 + `Tj`/`TJ` 操作符 + `ToUnicode` CMap | — | ✅ 抽取行号 |

**零外部依赖**：xlsx/docx/pdf 全部用 `node:zlib` 手写解析，不装 pandas、不装 pdfjs、不调 Python。
代价是覆盖范围有限，见「已知限制」。

上传时扩展名丢了也不要紧——会按魔数（zip 中央目录里的 `word/document.xml` / `xl/workbook.xml`，或 `%PDF-`）猜回来。

---

## 七、数据放在哪

单文件 SQLite：`$DSH_HOME/kb-notebook/kb.sqlite`（默认 `~/.dsh/kb-notebook/kb.sqlite`），WAL 模式。

| 表 | 装什么 |
| --- | --- |
| `databases` | 库元信息：名称、描述、颜色、启用态、创建时间 |
| `documents` | 文档：名字、格式、字节数、sha256、`meta.fields` |
| `chunks` | 检索单元：`ord`、正文、起止行、所属小节 |
| `records` | 结构化行：`row_no` + `cells` JSON |
| `bindings` | 会话 ↔ 库 ↔ 模式（strict/loose） |
| `suggestions` | 填补建议：`old_value`、`new_value`、`method`、`basis`、`status` |
| `notes` | 笔记：正文 + `citations` JSON |
| `audit` | 操作日志：`ts`、`action`、`dbid`、`docid`、`detail` |

删库会连带清 chunks/records/documents/suggestions/bindings（一个事务里做完）；
笔记与审计保留，因为它们是"发生过什么"的记录。

---

## 八、HTTP 接口

全部挂在 `/__kb/` 前缀下，`POST` + JSON body（`state`、`audit` 也支持 GET query）。

| 路由 | 作用 |
| --- | --- |
| `state?session=` | 库列表 + 当前绑定 + 最近一次检索 + 最近回答摘要 |
| `database.create` / `update` / `delete` / `duplicate` / `export` | 库维护；`export` 带 `format:'md'` 出 Markdown |
| `bind` | `{session, dbids, mode}`，返回 `{changed, notice}` |
| `documents` / `documents.delete` | 文档清单（带块数/记录数/字段）/ 删文档 |
| `import` | `{dbid, name, text \| base64 \| path, mode}` |
| `import.batch` | `{dbid, files:[...], mode}`，逐条成功/失败，不中断 |
| `search` | `{dbids, query, limit, mode}`，返回 hits + `insufficient` + 各道闸的丢弃统计 |
| `chunk` | `{chunkId}`，取回原文与行号小节 |
| `records` | 结构化记录预览 |
| `fill.detect` / `propose` / `list` / `decide` / `revert` | 数据填补全流程 |
| `notes.save` / `list` / `delete` | 笔记；`save` 不传 `body` 时取该会话最近一条回答 |
| `audit` | 操作日志 |

### 权限与安全

宿主自身的 web 服务有 token 鉴权（直接 `GET /` 会 401），但 `/__kb/*` 不在它的保护范围内，
所以插件自己带两道闸（`index.mjs` 的 `guard()`）：

1. `Host` 去端口后必须是 `127.0.0.1` / `localhost` / `[::1]` / `::1` —— 挡 DNS rebinding
2. 带 `Origin` 时必须与 `Host` 同源 —— 挡跨站请求

再往外就是本机同用户权限。**所有写操作都进 `audit` 表**，导入、采纳、撤销、删库都能事后追。

---

## 九、已知限制

- **没有语义检索**。同义改写（"退货" vs "退钱"）召不回来，这是 bigram 的固有代价。真要上向量，得先有本地 embedding 来源。
- **PDF 只取文本层**。扫描件会明确报"没有文本层，需要先 OCR"，不会假装读到了。
- **PDF 复杂排版**（多栏、表格、竖排）会串行，抽取顺序按内容流，不重排。
- **xlsx 只读值**，不读公式、样式、批注；`xls`（旧二进制格式）不支持。
- **ZIP64 / bzip2 / lzma 压缩的 Office 文件**不支持（正常 Office 生成的不会用这些）。
- 填补的相似记录判定靠"其余字段完全一致"或"部分字段相同"，不做模糊匹配。

---

## 十、开发

```
packages/kb-notebook/
├── package.json            # bundle 声明：dsh.bundle.patch + dsh.client
├── cordis.patch.yml        # 往宿主里插一个 entry
├── index.mjs               # 宿主半边：路由 + pre-step/request 监听 + 系统提示段
├── client.js               # 浏览器半边：管理页 + 输入框绑定条 + 侧边栏图标
├── locale/{zh,en}.json     # 可见文案
├── icon.svg                # 侧边栏图标
├── lib/
│   ├── store.mjs           # SQLite schema 与全部读写
│   ├── text.mjs            # 分词 / 切块 / BM25 倒排
│   ├── search.mjs          # 检索服务 + 证据渲染 + 引用体检
│   ├── parsers.mjs         # 文本类格式解析与格式路由
│   ├── office.mjs          # xlsx / docx 解析
│   ├── pdf.mjs             # PDF 文本层抽取
│   ├── zip.mjs             # 最小 zip 读取
│   └── fill.mjs            # 缺口检测 / 建议生成 / 采纳撤销
├── test/                   # 离线回归（不碰宿主数据）
└── demo/                   # 三个演示场景
```

回归：

```bash
node test/smoke.mjs       # 建库→导入→检索→隔离→引用体检
node test/queries.mjs     # 11 个真实问句形态的召回质量
node test/fill.mjs        # 填补全流程（含"不自动覆盖"的断言）
node test/parse-all.mjs   # 各格式解析 + 错误路径
node test/pdf.mjs         # PDF（含中文 Identity-H）
node test/office.mjs      # xlsx / docx 原始解析
node test/notes.mjs       # 笔记与整库导出
node test/prestep.mjs     # pre-step 注入链路（对着 mock ctx）
```

注意：测中文不要用 Git Bash 里的 `curl -d "中文"`（Windows 下走 GBK，发出去的字节不是 UTF-8，
入库会变乱码且检索静默失败）。用 node 脚本 + `fetch`。
