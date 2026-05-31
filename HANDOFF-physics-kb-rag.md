# 交接文档：物理教材 RAG 知识库（feature/physics-kb-rag）

> 给接手的 AI/开发者（如 Codex）。目标：把 Deepseek 数字人接上教材知识库，回答"教材优先、可补充"。基础层（T1–T6）已完成，**请从 Task 7 继续**。

## 0. 一句话现状

- **分支** `feature/physics-kb-rag`，**worktree** 在 `/Users/baofeng/Desktop/shu-zi-ren/.worktrees/feature-physics-kb-rag/`（从 `main` 起）。
- **已完成 T1–T6**（6 个 commit，全 TDD、每任务一 commit）。**待做 T7–T11**。
- 全量测试当前 **163 passing**、`tsc --noEmit` 干净。
- 最新 commit：`6f41ef16 feat(kb): add buildKbContext ...`。

## 1. 权威文档（务必先读）

- **Spec（设计）**：`docs/superpowers/specs/2026-05-31-physics-kb-rag-design.md`
- **Plan（逐任务实现，含每步完整代码）**：`docs/superpowers/plans/2026-05-31-physics-kb-rag.md` ← **T7–T11 的代码和命令都在这里，照着做**。
- 本交接文档只补充"现状 + 坑 + 约定"，**代码以 Plan 为准**。
  - ⚠️ Plan 里 Task 3 的 chunker 测试断言在 worktree 这份可能还是旧的 `['空节','实节']`；**正确值是 `['实节']`（丢空节）**，实际测试文件已修好。Codex 从 T7 起，不受影响。

## 2. 环境与怎么跑

```bash
cd /Users/baofeng/Desktop/shu-zi-ren/.worktrees/feature-physics-kb-rag
# 依赖已 npm install 过（如缺再 npm install）
npx vitest run                         # 全量测试
npx vitest run tests/knowledge/xxx.test.ts   # 单文件
npx tsc --noEmit                       # 类型检查
```

- **`.env` 已就位且完整**（含 `DEEPSEEK_API_KEY`、`SILICONFLOW_API_KEY`、`XINGYUN_*`、`DID_API_KEY`）。`.env` 已 gitignore，**勿提交**。embedding 与语音转写**共用** `SILICONFLOW_API_KEY`。
- Node 内置 `fetch`/`AbortSignal.timeout` 可用（Node 18+）。测试用 `// @vitest-environment node`（knowledge 模块跑在 Node 侧，用到 fs/fetch）。

## 3. 已完成（T1–T6）——别重做

| Task | 文件 | 说明 |
|---|---|---|
| T1 | `electron/services/knowledge/types.ts` | `Chunk`/`KnowledgeIndexFile` + `INDEX_VERSION=1`/`EMBEDDING_MODEL='BAAI/bge-m3'`/`EMBEDDING_DIM=1024`/`KB_DEFAULTS{chunkSize:800,chunkOverlap:120,topK:5,similarityThreshold:0.45,maxContextChars:3500}` |
| T2 | `electron/services/knowledge/vector.ts` | `cosineSimilarity(a,b)` |
| T3 | `electron/services/knowledge/chunker.ts` | `chunkMarkdown(md, textbook, {chunkSize,chunkOverlap})`：标题切分+字数兜底+overlap+丢空节 |
| T4 | `electron/services/knowledge/embeddingClient.ts` | `class EmbeddingClient(apiKey, fetchImpl=fetch)`，`embed(texts[])→number[][]`，POST `https://api.siliconflow.cn/v1/embeddings` |
| T5 | `electron/services/knowledge/knowledgeIndex.ts` | `parseAndValidateIndex(raw)`（version/model/dim 不符→null 降级）、`loadKnowledgeIndex(filePath)`、`search(chunks, queryVec, opts)`（余弦+阈值+topK+字数预算，结果剥掉 vector） |
| T6 | `electron/services/knowledge/buildKbContext.ts` | `buildKbContext(chunks)→string`：空→`''`；命中→「教材参考资料」段 + 4 条作答规则（教材优先/可补充/不过度超纲/不暴露检索） |

对应测试都在 `tests/knowledge/*.test.ts`。

## 4. 待做（T7–T11）——照 Plan 逐任务 TDD

**纪律（沿用前 6 个任务）**：每个 Task：①先写失败测试 → ②跑确认 RED → ③最小实现 → ④跑确认 GREEN → ⑤`git commit`（一任务一 commit，message 见 Plan，结尾带 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` 或你自己的署名）。

- **T7 `retriever.ts`**：`createKbRetriever(embeddingClient, chunks, opts=KB_DEFAULTS)` → `{ retrieve(query) }`。空 query/空 chunks→`[]`（不 embed）；embed 抛错→catch 降级 `[]`；否则 `embed([query])`→`search`。`KbRetriever` 接口也在这。**TDD**，Plan 有完整测试+实现。
- **T8 `scripts/build-kb.ts` + 配置**：离线建库脚本（读 `knowledge/textbooks/*.md`→chunker→分批 embed→写 `knowledge/index.json`，**任一步失败 `process.exit(1)`，不写半成品**）。配套：`npm i -D tsx`；package.json 加 `"build-kb":"tsx scripts/build-kb.ts"`；`.gitignore` 加 `knowledge/textbooks/` 和 `knowledge/index.json`；建 `knowledge/README.md`（入仓）；`.env.example` 给 SILICONFLOW 行补注释。无单测，靠 tsc + 手动跑。
- **T9 `DeepseekAIProvider.ts` 接入（最关键）**：构造器改 `(apiKey, retriever?: KbRetriever, fetchImpl: typeof fetch = fetch)`；`buildSystemPrompt(catalog, kbContext)`；chat 内取**最新一条 user 消息**→`retriever?.retrieve()`→`buildKbContext`→注入 system prompt；用 `this.fetchImpl`。
  - ⚠️ **`tests/DeepseekAIProvider.test.ts` 已存在，不要覆盖它**。KB 测试放**新文件** `tests/DeepseekAIProvider.kb.test.ts`。构造器新增参数都是可选默认值，向后兼容；kbContext='' 时 system prompt 与改前**逐字相同**（现有测试不回归）。Step 4 要同时跑新旧两个 provider 测试确认不回归。
- **T10 `main.ts` 接线**：启动 `loadKnowledgeIndex(path.join(__dirname,'../knowledge/index.json'))`；写 `makeDeepseekProvider()`：有 index 且有 SILICONFLOW key 才建 `createKbRetriever(new EmbeddingClient(sfKey), kbIndex.chunks)`，否则 `retriever=undefined`；把 `app.whenReady` 和 `set-api-key` 两处 `new DeepseekAIProvider(apiKey)` 换成 `makeDeepseekProvider()`。`electron-builder.json` 的 `files` 数组加 `"knowledge/index.json"`（否则打包后知识库失效）。tsc + 全量。
- **T11 验收**（需用户教材 + key）：`tsc`+全量；gitignore 验收（`git check-ignore knowledge/textbooks/x.md knowledge/index.json .env` 都被忽略，README 可入仓）；放教材后 `npm run build-kb` 产出 index.json（删 key 跑应 exit(1) 不产半成品）；`npm run dev` 手动问教材内/外问题，确认贴合教材**且不暴露"教材/检索/片段"等字样**、教材外问题正常降级。

## 5. 必须记住的坑

1. **失败分两阶段**：`build-kb`（离线）失败=**大声报错 exit(1)**；`chat`（运行时）失败=**静默降级、绝不阻断回答**（缺 index/缺 key/embed 失败/无命中/模型维度不符 → 不注入，照常答）。
2. **不暴露检索过程**：提示词已含规则，回答不得提"教材参考资料/片段/相似度/检索/章节编号"。
3. **现有 `DeepseekAIProvider.test.ts` 不要动**（见 T9）。
4. **教材/索引不入仓**：`knowledge/textbooks/`、`knowledge/index.json`、`.env` 都 gitignore；只 README/示例配置入仓。**打包前必须先 `npm run build-kb`**（index.json 被 ignore，靠本地构建 + electron-builder 从磁盘 bundle）。
5. **worktree `.env` 要齐全**：本会话踩过坑——之前 worktree 只拷了部分 key 导致语音/embedding 不可用。本 worktree 的 `.env` 已是完整版，别清空。
6. **教材名**：build-kb 优先读 markdown front-matter `textbook:`，缺省用文件名。
7. **embedding 模型/维度若改**，`index.json` 里记的 `embeddingModel`/`embeddingDim` 会让旧索引在运行时自动降级——改了要重跑 build-kb。

## 6. 全部完成后

1. 跑 `npx tsc --noEmit && npx vitest run`，全绿。
2. Code review（Superpowers `requesting-code-review` 或等价）。
3. 收尾用 `finishing-a-development-branch`：**用户偏保守——先 push 分支、PR 先挂着等确认，不要直接合 main**。
4. 用户还会单独提供 4 本教材 markdown；T11 手动验收依赖它们。

## 7. 给用户的话

- 代码侧 T7–T10 不依赖教材，Codex 可直接做完。
- 教材 markdown 放 `knowledge/textbooks/*.md` 后跑 `npm run build-kb` 才有知识库。
- 魔珐星云那条线（`feature/xingyun-streaming`）是另一分支、已 push、与本分支不重叠，互不影响。
