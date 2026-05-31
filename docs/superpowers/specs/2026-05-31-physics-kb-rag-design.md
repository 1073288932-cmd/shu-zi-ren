# 物理教材 RAG 知识库 设计文档

> 让 Deepseek 数字人回答"更贴近教材"：检索 4 本物理教材的相关片段，注入系统提示词，模型**优先依据教材**作答。

## 目标

- 把用户提供的 4 本物理教材（markdown）做成可检索知识库。
- 每次提问时检索最相关的教材片段，注入 `DeepseekAIProvider` 的系统提示词，指示模型优先用教材内容与术语作答。
- 检索用**云端 embedding 语义检索**（Silicon Flow BGE），本地 JSON 存向量 + 余弦相似，无需向量数据库、无需中文分词库。

## 非目标（YAGNI）

- 不显示引用/出处，不改回答 UI，不改 Deepseek 返回结构（仍 `{reply, resourceIds}`）。
- 不做严格"只用教材"模式（教材未覆盖时允许通识补充）。
- 不做 BM25/混合检索、不做重排、不做多轮 query 改写（仅用最新一句问题检索）。
- 不做知识库管理 UI（建/删/查通过离线脚本）。

## 整体策略：建索引（离线一次）+ 查询（每次提问）

```
[建索引] knowledge/textbooks/*.md
   → chunker 切块（标题优先 + 字数兜底 + overlap，带 教材名/章节 元数据）
   → embeddingClient.embed(每块)  ── Silicon Flow /v1/embeddings (BAAI/bge-m3)
   → 写 knowledge/index.json  { model, dim, builtAt, chunks:[{id,text,textbook,heading,vector}] }

[查询] DeepseekAIProvider.chat(messages)
   → 取最新一条 user 消息文本
   → embeddingClient.embed(query) 得到 queryVec
   → knowledgeIndex.search(queryVec): 余弦相似 → 阈值过滤 → top-k → 字数预算累计
   → 命中? 把命中片段拼成「教材参考资料」段注入 system prompt（教材优先指令）
   → 未命中 / 无索引 / embedding 失败 → 静默跳过，按现状回答
```

## Section 1：组件与接口（小而清晰、可独立测试）

| 单元 | 进程 | 职责 | 依赖 |
|---|---|---|---|
| `chunker`（纯函数） | 构建期 | `chunkMarkdown(md, meta) → Chunk[]`：优先按 markdown 标题切，单块超长再按段落/字数切并加 overlap；每块带 `textbook` + `heading`（章节路径） | 无 |
| `embeddingClient` | 主进程 + 脚本 | `embed(texts: string[]) → Promise<number[][]>`：POST Silicon Flow `/v1/embeddings`，`Bearer` 鉴权，分批 + 超时；构造器注入 `fetch` 便于测试 | 已有 fetch + `SILICONFLOW_API_KEY` |
| `knowledgeIndex` | 主进程 | 启动时（或首次 chat 懒加载）读 `index.json`；`search(queryVec, opts) → Chunk[]`：余弦相似 + 阈值 + top-k + 字数预算，纯计算 | 无 |
| `cosineSimilarity`（纯函数） | 主进程 | `cosine(a, b) → number`；向量已在建索引时归一化则退化为点积 | 无 |
| `build-kb` 脚本 | 离线 | 读 `knowledge/textbooks/*.md` → `chunker` → `embeddingClient` → 写 `index.json`；含进度与限速 | 上面三个 + dotenv |
| `buildKbContext`（纯函数） | 主进程 | `Chunk[] → string`：把命中片段拼成「教材参考资料」提示词段（带 教材名/章节 标签，供模型参考） | 无 |
| `DeepseekAIProvider` 改造 | 主进程 | chat 内：embed 问题 → `knowledgeIndex.search` → `buildKbContext` 注入 system prompt；失败降级 | embeddingClient + knowledgeIndex |

### 数据结构

```ts
interface Chunk {
  id: string            // `${textbookSlug}#${序号}`
  text: string          // chunk 正文
  textbook: string      // 如「人教版 八年级下」
  heading: string       // 章节路径，如「第八章 运动和力 / 8.3 摩擦力」
  vector?: number[]     // 仅 index.json 内含；search 结果可省略
}

interface KnowledgeIndexFile {
  model: string         // 'BAAI/bge-m3'
  dim: number           // 1024
  builtAt: string       // ISO
  chunks: Chunk[]       // 含 vector
}
```

## Section 2：检索参数与降级（默认值，首日可调）

- **embedding 模型**：`BAAI/bge-m3`（Silicon Flow，1024 维，中文/长文强）。备选 `BAAI/bge-large-zh-v1.5`。建索引与查询**必须同模型**（index.json 记 `model`，加载时校验，不一致则报错/降级）。
- **chunk**：~400 字/块，overlap ~80 字；标题优先切分。
- **检索**：`topK=5`；相似度阈值 `minScore`（默认 ~0.40，首日按真实命中分布调）；命中按相似度降序，累计到字数预算 `maxContextChars ~3500` 为止。
- **query**：最新一条 `role==='user'` 消息的文本（不做多轮拼接）。
- **降级（关键，绝不阻断回答）**：
  - `index.json` 不存在 / 解析失败 / `chunks` 为空 → 不注入，按现状回答。
  - `embed(query)` 抛错 / 超时 → catch，不注入，照常回答。
  - 检索结果全部低于阈值 → 不注入。
  - 模型维度与 index 不符 → 不注入并 `console.warn`。
- **性能**：index.json 启动加载一次（几 MB、几千块可接受）；余弦对全量线性扫描（几千块 < 10ms）。每次提问多一个 embedding 调用，~100–300ms。

## Section 3：提示词注入（教材优先、可补充）

在现有 `buildSystemPrompt` 基础上，命中时**插入**一段（未命中则不插）：

```
以下是与当前问题相关的教材参考资料（按相关度排序）：
【人教版 八年级下 · 8.3 摩擦力】<片段正文>
【…】<片段正文>

回答时优先依据上述教材的内容、定义与术语；教材未覆盖的点可用通识补充，但以教材为准；不要编造教材中不存在的内容。
```

- 返回格式仍是 `{"reply":..., "resourceIds":[...]}`，**不新增字段、不改 parser、不改 UI**。
- 教材名/章节标签只给模型看，不在 reply 里强制展示（静默贴近）。

## Section 4：存储、git 与打包

- **原始教材 + 索引都是本地产物，gitignore**：`knowledge/textbooks/`、`knowledge/index.json` 加入 `.gitignore`（避免出版物文本入仓 + 仓体积）。
- 提交进仓的只有**代码 + 脚本 + `knowledge/README.md`**（说明放教材、跑 build-kb）。
- **打包必带 index.json**：electron-builder `files` 增加 `knowledge/index.json`（或 `knowledge/**`），否则打包后知识库失效（同 `resources/catalog.json` 旧坑）。
- 因 index.json 被 gitignore，**打包前必须先跑 `build-kb`**；spec/plan 与 README 显式提醒。
- 主进程读取路径：dev `path.join(__dirname, '../knowledge/index.json')`，prod 走 asar 内 `knowledge/index.json`（与 catalog 一致）。

## Section 5：build-kb 脚本

- TS 脚本，经 `tsx`（或 `vite-node`）运行；新增 `npm run build-kb`。
- 复用 `chunker` + `embeddingClient`（同一份 TS，被脚本与 app 共享）。
- 流程：读 `.env`（`SILICONFLOW_API_KEY`）→ 遍历 `knowledge/textbooks/*.md`（教材名取自文件名或 front-matter）→ chunker → 分批 embed（限速避免触发频控）→ 写 `index.json` + 打印块数/耗时。
- 教材变更时重跑即可（幂等覆盖）。

## Section 6：错误处理细则

| 场景 | 行为 |
|---|---|
| 缺 `SILICONFLOW_API_KEY`（脚本） | 脚本明确报错退出，提示去 `.env` 配 key |
| 缺 key（运行时 chat） | 不注入教材，照常回答（不报错给用户） |
| Silicon Flow embeddings 4xx/5xx/超时 | 脚本：失败重试/报错；运行时：catch 降级 |
| index.json 缺失/损坏 | 运行时降级 + `console.warn`；不崩 |
| 教材 markdown 为空/无标题 | chunker 仍按字数切，heading 用文件名兜底 |

## Section 7：测试策略

- `chunker`：标题切分、超长二次切分 + overlap、元数据（textbook/heading）、无标题兜底 —— 纯函数直接测。
- `cosineSimilarity` + `knowledgeIndex.search`：排序正确、阈值过滤、topK、字数预算 —— 纯函数注入假向量测。
- `embeddingClient`：注入假 `fetch`，验证请求体（model/input）、解析 `data[].embedding`、错误/超时分支。
- `buildKbContext`：命中拼接格式、标签正确、空命中返回空。
- `DeepseekAIProvider` 改造：注入假 retriever —— 有命中→system prompt 含「教材参考资料」段；无命中/retriever 抛错→退化为原 prompt 且仍正常返回；响应解析不变。
- 不为 build-kb 脚本本身写单测（其逻辑都在被测的 chunker/embeddingClient 里）。

## Section 8：文件清单

### 新增
| 文件 | 职责 |
|---|---|
| `electron/services/knowledge/chunker.ts` | `chunkMarkdown` |
| `electron/services/knowledge/embeddingClient.ts` | Silicon Flow embeddings 封装 |
| `electron/services/knowledge/knowledgeIndex.ts` | 加载 index.json + `search`（含 cosine） |
| `electron/services/knowledge/buildKbContext.ts` | 命中片段 → 提示词段 |
| `electron/services/knowledge/types.ts` | `Chunk` / `KnowledgeIndexFile` 等 |
| `scripts/build-kb.ts` | 离线建索引脚本 |
| `knowledge/README.md` | 放教材 + 跑 build-kb 的说明（入仓） |
| `tests/chunker.test.ts` / `tests/knowledgeIndex.test.ts` / `tests/embeddingClient.test.ts` / `tests/buildKbContext.test.ts` | 单测 |

### 修改
| 文件 | 改动 |
|---|---|
| `electron/services/DeepseekAIProvider.ts` | chat 内接入检索 + 提示词注入 + 降级；构造器注入 retriever 便于测试 |
| `electron/main.ts` | 启动加载 knowledgeIndex，注入 DeepseekAIProvider |
| `.gitignore` | 加 `knowledge/textbooks/`、`knowledge/index.json` |
| `electron-builder.json` | `files` 增加 `knowledge/index.json` |
| `package.json` | 加 `build-kb` 脚本（+ 必要时 `tsx` devDep） |
| `.env.example` | 注明 `SILICONFLOW_API_KEY` 也用于 embedding（已存在该行，补注释） |

### 不改
回答 UI、Deepseek 返回结构、ASR/语音、魔珐相关一律不动。

## Section 9：首日可调项（实现后按真实数据调）

- `minScore` 阈值：先按几条真实提问看命中分布再定（太高漏召、太低塞噪音）。
- chunk 大小 / topK / maxContextChars：按教材结构与回答质量微调。
- 模型：若 `bge-m3` 中文表现不如 `bge-large-zh-v1.5`，切换并重建索引。

## Section 10：分支与验收

- 从 `main` 起 worktree `feature/physics-kb-rag`（独立于 `feature/xingyun-streaming`，二者改动不重叠）。
- 验收：`tsc` 干净 + 全量单测过 + `build-kb` 能对样例教材产出 index.json + 手动问几条教材相关问题，回答明显引用教材内容/术语；问教材外问题仍正常（降级）。
