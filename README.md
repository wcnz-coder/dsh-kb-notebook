# dsh-kb-notebook

一个给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的**可导入知识库 + 严格引用**插件。定位接近 Google NotebookLM：

> 先导入你自己的资料，再让 AI 只在选定资料的范围内问答和创作，每句话都能点回原文。

## 它和一般 RAG 插件差在哪

| | 常见做法 | 这里 |
| --- | --- | --- |
| 库的绑定 | 全局一个库，所有对话共享 | **每个对话独立绑定**，可多选；未绑定时检索根本不被调用 |
| 依据强度 | 相关度低也照样塞给模型 | **阈值 + 覆盖度双闸**，不够就直接告诉模型"没找到依据"，而不是硬编 |
| 数据补全 | 直接改库 | **只出建议**，采纳与否由人定，留痕、可撤销、无依据不造值 |

## 能力

- **多库**：建/改/停用/复制/删除/导出（JSON 或 Markdown），库间硬隔离
- **导入**：CSV / TSV / Excel / JSON / JSONL / YAML / Markdown / TXT / Word / PDF，拖拽、批量、整文件夹；导入前预览，失败逐条给原因并可下载报告
- **检索**：中文 bigram 倒排 + BM25，无外部依赖、无需联网、无需 Python
- **严格模式**：回答前强制检索，证据以 `<kb-evidence>` 注入，回答带 `[K1]` 形式引用（库名 / 文档名 / 行号 / 小节），点开看原文
- **数据填补**：三档推断（同键参考 / 相似行 / 格式化）出建议，标 `pending`，采纳才写回，可撤销
- **笔记**：把回答存为笔记，来源引用一并保留

## 目录

```
DESIGN.md                  方案与设计文档（需求边界 / 架构 / 数据模型 / 严格模式方案）
packages/kb-notebook/      插件本体
  README.md                完整文档：安装、上手、原理、API、已知限制
  index.mjs                Host 半部：路由 + agent/pre-step + agent/request
  client.js                Client 半部：管理页 + 输入框绑定条
  lib/                     解析、切分、索引、检索、填补、存储
  test/                    8 个离线测试
  demo/                    3 个可运行演示（走的和线上是同一条代码路径）
samples/                   示例数据
```

## 安装

```bash
plugin_manager  action: install_bundle
                target: <绝对路径>/dsh-kb-notebook/packages/kb-notebook
```

装完侧边栏会出现「知识库」图标，输入框上方出现绑定条。详细步骤、更新方式、排错见 [packages/kb-notebook/README.md](packages/kb-notebook/README.md)。

## 快速验证

```bash
cd packages/kb-notebook
node test/smoke.mjs        # 建库 → 导入 → 检索 → 隔离 → 证据
node demo/scenario-1-qa.mjs
```

三个演示分别覆盖：知识问答、基于库的创作、缺失数据填补。演示输出的不是截图式说明，而是**真正被塞进模型上下文的内容**。

## 已验证的限制

- 无语义检索：同义改写（"退货" ↔ "退钱"）召回不了，只有字面与子串重叠能命中
- PDF 只抽文本层：扫描件会明确报"需先 OCR"，不会假装读到了内容
- xlsx 不读公式、不读样式；不支持的压缩格式（ZIP64 / bzip2 / lzma）会明确报错
- 填补不做模糊匹配，找不到依据就标「无可靠依据」，不给假值

## 许可

MIT
