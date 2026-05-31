# 物理教材 RAG 知识库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Deepseek 数字人加教材知识库——检索 4 本物理教材的相关片段注入系统提示词，让回答"教材优先、可补充"。

**Architecture:** 两阶段。①离线 `build-kb` 脚本把 `knowledge/textbooks/*.md` 切块→Silicon Flow embedding→写本地 `knowledge/index.json`。②运行时 `DeepseekAIProvider.chat` 内把最新问题 embedding→对 index 做余弦相似 top-k→拼成「教材参考资料」段注入系统提示词。失败一律静默降级（不阻断回答），build-kb 失败则报错 exit(1)。

**Tech Stack:** Electron 主进程 + TypeScript + Vitest（node env, pool=forks）。新增：Silicon Flow `/v1/embeddings`（`BAAI/bge-m3`，复用 `SILICONFLOW_API_KEY`）。无向量库、无分词库、无 UI 改动。

**Spec:** `docs/superpowers/specs/2026-05-31-physics-kb-rag-design.md`

---

## Prerequisites（Task 1 之前）

- **P-1** `SILICONFLOW_API_KEY` 已在根 `.env`（本会话已为语音加过，embedding 复用同一把）。
- **P-2** worktree：由 `superpowers:using-git-worktrees` 从 `main` 创建 `feature/physics-kb-rag`，置于 `.worktrees/feature-physics-kb-rag/`。第一件事：拷根 `.env` 过去。
- **P-3** 教材 markdown 由用户提供，放 `knowledge/textbooks/*.md`。**写代码与单测不依赖教材**（用假数据测）；仅 Task 8 的手动建库需要真教材。

---

## File Structure

### 新增
| 文件 | 职责 |
|---|---|
| `electron/services/knowledge/types.ts` | `Chunk`/`KnowledgeIndexFile` + 常量（`INDEX_VERSION`/`EMBEDDING_MODEL`/`EMBEDDING_DIM`/`KB_DEFAULTS`） |
| `electron/services/knowledge/vector.ts` | `cosineSimilarity` 纯函数 |
| `electron/services/knowledge/chunker.ts` | `chunkMarkdown` |
| `electron/services/knowledge/embeddingClient.ts` | `EmbeddingClient`（Silicon Flow embeddings，注入 fetch） |
| `electron/services/knowledge/knowledgeIndex.ts` | `parseAndValidateIndex`/`loadKnowledgeIndex`/`search` |
| `electron/services/knowledge/buildKbContext.ts` | `buildKbContext`（命中→提示词段） |
| `electron/services/knowledge/retriever.ts` | `KbRetriever` 接口 + `createKbRetriever`（embed+search+降级） |
| `scripts/build-kb.ts` | 离线建索引脚本 |
| `knowledge/README.md` | 放教材 + 跑 build-kb 的说明（入仓） |
| `tests/knowledge/*.test.ts` | 各纯函数/客户端单测（node env） |

### 修改
| 文件 | 改动 |
|---|---|
| `electron/services/DeepseekAIProvider.ts` | 构造器注入 `retriever?`/`fetchImpl?`；chat 内检索+注入；`buildSystemPrompt(catalog, kbContext)` |
| `electron/main.ts` | 启动 `loadKnowledgeIndex`，构造 `EmbeddingClient`+`createKbRetriever`，注入 provider（含 set-api-key 重建路径） |
| `.gitignore` | 加 `knowledge/textbooks/`、`knowledge/index.json` |
| `electron-builder.json` | `files` 增加 `knowledge/index.json` |
| `package.json` | 加 `"build-kb": "tsx scripts/build-kb.ts"` + `tsx` devDep |
| `.env.example` | 给 `SILICONFLOW_API_KEY` 补注释：也用于教材 embedding |

### 不改
回答 UI、Deepseek 返回结构（仍 `{reply, resourceIds}`）、ASR/语音、魔珐相关一律不动。

---

## Task 1：knowledge 类型与常量

**Files:** Create `electron/services/knowledge/types.ts`

- [ ] **Step 1：创建 `electron/services/knowledge/types.ts`**

```ts
export interface Chunk {
  id: string          // `${textbookSlug}#${序号}`
  text: string        // chunk 正文
  textbook: string    // 如「人教版 八年级下」
  heading: string     // 章节路径，如「第八章 运动和力 / 8.3 摩擦力」
  vector?: number[]   // 仅 index.json 内含；search 结果省略
}

export interface KnowledgeIndexFile {
  version: number
  embeddingModel: string
  embeddingDim: number
  chunkSize: number
  chunkOverlap: number
  builtAt: string
  chunks: Chunk[]
}

export const INDEX_VERSION = 1
export const EMBEDDING_MODEL = 'BAAI/bge-m3'
export const EMBEDDING_DIM = 1024

export const KB_DEFAULTS = {
  chunkSize: 800,
  chunkOverlap: 120,
  topK: 5,
  similarityThreshold: 0.45,
  maxContextChars: 3500,
} as const
```

- [ ] **Step 2：`npx tsc --noEmit`** → 无输出（exit 0）。

- [ ] **Step 3：commit**

```bash
git add electron/services/knowledge/types.ts
git commit -m "feat(kb): add knowledge types + defaults (model/dim/index version/params)"
```

---

## Task 2：cosineSimilarity（纯函数）

**Files:** Create `electron/services/knowledge/vector.ts`, `tests/knowledge/vector.test.ts`

- [ ] **Step 1：写失败测试** —— 创建 `tests/knowledge/vector.test.ts`：

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { cosineSimilarity } from '../../electron/services/knowledge/vector'

describe('cosineSimilarity', () => {
  it('returns 1 for identical direction', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1)
  })
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })
  it('returns 0 on length mismatch or empty', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
  })
  it('returns 0 when a vector is all zeros', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/knowledge/vector.test.ts`
Expected: FAIL `Cannot find module ...vector`。

- [ ] **Step 3：实现 `electron/services/knowledge/vector.ts`**

```ts
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
```

- [ ] **Step 4：跑测试确认通过** → 全 PASS。

- [ ] **Step 5：commit**

```bash
git add electron/services/knowledge/vector.ts tests/knowledge/vector.test.ts
git commit -m "feat(kb): add cosineSimilarity"
```

---

## Task 3：chunker（markdown 切块，纯函数）

**Files:** Create `electron/services/knowledge/chunker.ts`, `tests/knowledge/chunker.test.ts`

- [ ] **Step 1：写失败测试** —— 创建 `tests/knowledge/chunker.test.ts`：

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { chunkMarkdown } from '../../electron/services/knowledge/chunker'

const TB = '人教版 八年级下'

describe('chunkMarkdown', () => {
  it('splits by headings and records heading path + textbook', () => {
    const md = `# 第八章 运动和力
## 8.3 摩擦力
摩擦力是阻碍相对运动的力。
## 8.1 牛顿第一定律
一切物体保持匀速直线运动或静止。`
    const chunks = chunkMarkdown(md, TB, { chunkSize: 800, chunkOverlap: 120 })
    expect(chunks.length).toBe(2)
    expect(chunks[0].textbook).toBe(TB)
    expect(chunks[0].heading).toBe('第八章 运动和力 / 8.3 摩擦力')
    expect(chunks[0].text).toContain('摩擦力是阻碍')
    expect(chunks[1].heading).toBe('第八章 运动和力 / 8.1 牛顿第一定律')
    expect(chunks[0].id).not.toBe(chunks[1].id)
  })

  it('splits an oversized section into overlapping pieces', () => {
    const body = 'A'.repeat(2000)
    const md = `## 长节\n${body}`
    const chunks = chunkMarkdown(md, TB, { chunkSize: 800, chunkOverlap: 120 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(c => c.text.length <= 800)).toBe(true)
    // 相邻块有 overlap：第 2 块开头应与第 1 块结尾重叠
    const tail = chunks[0].text.slice(-120)
    expect(chunks[1].text.startsWith(tail)).toBe(true)
  })

  it('falls back to textbook name as heading when no headings present', () => {
    const chunks = chunkMarkdown('没有任何标题的一段正文。', TB, { chunkSize: 800, chunkOverlap: 120 })
    expect(chunks.length).toBe(1)
    expect(chunks[0].heading).toBe(TB)
  })

  it('drops empty/whitespace-only sections', () => {
    const chunks = chunkMarkdown('## 空节\n\n   \n## 实节\n有内容', TB, { chunkSize: 800, chunkOverlap: 120 })
    expect(chunks.map(c => c.heading)).toEqual(['空节', '实节'])
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/knowledge/chunker.test.ts`
Expected: FAIL `Cannot find module ...chunker`。

- [ ] **Step 3：实现 `electron/services/knowledge/chunker.ts`**

```ts
import type { Chunk } from './types'

interface ChunkOptions { chunkSize: number; chunkOverlap: number }
interface Section { heading: string; body: string }

function slugify(s: string): string {
  return s.replace(/\s+/g, '-').replace(/[^\w一-龥-]/g, '').slice(0, 40)
}

// 按 markdown 标题分节，heading 为从顶层到当前层的路径（' / ' 连接）。
function splitByHeadings(markdown: string, fallbackHeading: string): Section[] {
  const lines = markdown.split(/\r?\n/)
  const stack: string[] = []         // stack[level-1] = 该层标题
  const sections: Section[] = []
  let buf: string[] = []

  const flush = () => {
    const body = buf.join('\n')
    if (body.trim()) {
      const path = stack.filter(Boolean)
      sections.push({ heading: path.length ? path.join(' / ') : fallbackHeading, body })
    }
    buf = []
  }

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) {
      flush()
      const level = m[1].length
      stack[level - 1] = m[2].trim()
      stack.length = level          // 截断更深层
    } else {
      buf.push(line)
    }
  }
  flush()
  return sections
}

// 单节正文按字数切，相邻块 overlap 字符。
function splitBySize(body: string, size: number, overlap: number): string[] {
  const text = body.trim()
  if (text.length <= size) return text ? [text] : []
  const step = Math.max(1, size - overlap)
  const pieces: string[] = []
  for (let start = 0; start < text.length; start += step) {
    pieces.push(text.slice(start, start + size))
    if (start + size >= text.length) break
  }
  return pieces
}

export function chunkMarkdown(markdown: string, textbook: string, opts: ChunkOptions): Chunk[] {
  const slug = slugify(textbook)
  const chunks: Chunk[] = []
  let seq = 0
  for (const section of splitByHeadings(markdown, textbook)) {
    for (const piece of splitBySize(section.body, opts.chunkSize, opts.chunkOverlap)) {
      const text = piece.trim()
      if (!text) continue
      chunks.push({ id: `${slug}#${seq++}`, text, textbook, heading: section.heading })
    }
  }
  return chunks
}
```

- [ ] **Step 4：跑测试确认通过** → 全 PASS。

> 注：overlap 断言里 `chunks[1].text.startsWith(tail)` 成立的前提是 `splitBySize` 用 raw `text`（未 trim 每片）。本实现 `pieces.push(text.slice(...))` 未对单片 trim，仅在 `chunkMarkdown` 里对整片 `trim()`；纯 'A' 正文无空白，断言成立。若实际教材首尾有空白导致该断言偶发失败，改为断言"相邻块存在公共子串"。

- [ ] **Step 5：commit**

```bash
git add electron/services/knowledge/chunker.ts tests/knowledge/chunker.test.ts
git commit -m "feat(kb): add chunkMarkdown (heading split + size cap + overlap)"
```

---

## Task 4：EmbeddingClient（Silicon Flow embeddings）

**Files:** Create `electron/services/knowledge/embeddingClient.ts`, `tests/knowledge/embeddingClient.test.ts`

- [ ] **Step 1：写失败测试** —— 创建 `tests/knowledge/embeddingClient.test.ts`：

```ts
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { EmbeddingClient } from '../../electron/services/knowledge/embeddingClient'

function okFetch(vectors: number[][]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: vectors.map(v => ({ embedding: v })) }),
  } as unknown as Response)
}

describe('EmbeddingClient', () => {
  it('posts model + input and returns embeddings in order', async () => {
    const fetchImpl = okFetch([[0.1, 0.2], [0.3, 0.4]])
    const client = new EmbeddingClient('sk-test', fetchImpl as unknown as typeof fetch)
    const out = await client.embed(['a', 'b'])
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]])
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toContain('/v1/embeddings')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe('BAAI/bge-m3')
    expect(body.input).toEqual(['a', 'b'])
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-test' })
  })

  it('returns [] for empty input without calling fetch', async () => {
    const fetchImpl = okFetch([])
    const client = new EmbeddingClient('sk-test', fetchImpl as unknown as typeof fetch)
    expect(await client.embed([])).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws on non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response)
    const client = new EmbeddingClient('sk-test', fetchImpl as unknown as typeof fetch)
    await expect(client.embed(['a'])).rejects.toThrow(/401/)
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/knowledge/embeddingClient.test.ts`
Expected: FAIL `Cannot find module ...embeddingClient`。

- [ ] **Step 3：实现 `electron/services/knowledge/embeddingClient.ts`**

```ts
import { EMBEDDING_MODEL } from './types'

const EMBEDDINGS_URL = 'https://api.siliconflow.cn/v1/embeddings'

export class EmbeddingClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const res = await this.fetchImpl(EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`)
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> }
    return data.data.map(d => d.embedding)
  }
}
```

- [ ] **Step 4：跑测试确认通过** → 全 PASS。

- [ ] **Step 5：commit**

```bash
git add electron/services/knowledge/embeddingClient.ts tests/knowledge/embeddingClient.test.ts
git commit -m "feat(kb): add EmbeddingClient (Silicon Flow /v1/embeddings, injectable fetch)"
```

---

## Task 5：knowledgeIndex（解析校验 + 检索）

**Files:** Create `electron/services/knowledge/knowledgeIndex.ts`, `tests/knowledge/knowledgeIndex.test.ts`

- [ ] **Step 1：写失败测试** —— 创建 `tests/knowledge/knowledgeIndex.test.ts`：

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parseAndValidateIndex, search } from '../../electron/services/knowledge/knowledgeIndex'
import type { Chunk, KnowledgeIndexFile } from '../../electron/services/knowledge/types'

function validIndex(): KnowledgeIndexFile {
  return {
    version: 1,
    embeddingModel: 'BAAI/bge-m3',
    embeddingDim: 1024,
    chunkSize: 800,
    chunkOverlap: 120,
    builtAt: '2026-05-31T00:00:00.000Z',
    chunks: [{ id: 'a#0', text: 'x', textbook: 'tb', heading: 'h', vector: [1, 0] }],
  }
}

describe('parseAndValidateIndex', () => {
  it('parses a valid index', () => {
    expect(parseAndValidateIndex(JSON.stringify(validIndex()))?.chunks.length).toBe(1)
  })
  it('returns null on bad json', () => {
    expect(parseAndValidateIndex('{not json')).toBeNull()
  })
  it('returns null on version mismatch', () => {
    expect(parseAndValidateIndex(JSON.stringify({ ...validIndex(), version: 99 }))).toBeNull()
  })
  it('returns null on model mismatch', () => {
    expect(parseAndValidateIndex(JSON.stringify({ ...validIndex(), embeddingModel: 'other' }))).toBeNull()
  })
  it('returns null on dim mismatch', () => {
    expect(parseAndValidateIndex(JSON.stringify({ ...validIndex(), embeddingDim: 512 }))).toBeNull()
  })
})

describe('search', () => {
  const chunks: Chunk[] = [
    { id: 'c1', text: 'near', textbook: 'tb', heading: 'h1', vector: [1, 0] },
    { id: 'c2', text: 'mid', textbook: 'tb', heading: 'h2', vector: [0.7, 0.7] },
    { id: 'c3', text: 'far', textbook: 'tb', heading: 'h3', vector: [0, 1] },
  ]
  const opts = { topK: 5, similarityThreshold: 0.45, maxContextChars: 3500 }

  it('ranks by cosine and filters below threshold', () => {
    const r = search(chunks, [1, 0], opts)
    expect(r.map(c => c.id)).toEqual(['c1', 'c2'])   // c3 cosine 0 < 0.45 被过滤
  })
  it('caps to topK', () => {
    const r = search(chunks, [1, 0], { ...opts, topK: 1 })
    expect(r.map(c => c.id)).toEqual(['c1'])
  })
  it('respects maxContextChars budget (keeps at least one)', () => {
    const r = search(chunks, [1, 0], { ...opts, maxContextChars: 1 })
    expect(r.map(c => c.id)).toEqual(['c1'])
  })
  it('strips vectors from results', () => {
    const r = search(chunks, [1, 0], opts)
    expect(r[0].vector).toBeUndefined()
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/knowledge/knowledgeIndex.test.ts`
Expected: FAIL `Cannot find module ...knowledgeIndex`。

- [ ] **Step 3：实现 `electron/services/knowledge/knowledgeIndex.ts`**

```ts
import fs from 'fs'
import type { Chunk, KnowledgeIndexFile } from './types'
import { INDEX_VERSION, EMBEDDING_MODEL, EMBEDDING_DIM, KB_DEFAULTS } from './types'
import { cosineSimilarity } from './vector'

export function parseAndValidateIndex(raw: string): KnowledgeIndexFile | null {
  let data: unknown
  try { data = JSON.parse(raw) } catch { return null }
  if (typeof data !== 'object' || data === null) return null
  const idx = data as Partial<KnowledgeIndexFile>
  if (idx.version !== INDEX_VERSION) { console.warn('[kb] index version mismatch, degrade'); return null }
  if (idx.embeddingModel !== EMBEDDING_MODEL) { console.warn('[kb] index model mismatch, degrade'); return null }
  if (idx.embeddingDim !== EMBEDDING_DIM) { console.warn('[kb] index dim mismatch, degrade'); return null }
  if (!Array.isArray(idx.chunks)) return null
  return idx as KnowledgeIndexFile
}

export function loadKnowledgeIndex(filePath: string): KnowledgeIndexFile | null {
  let raw: string
  try { raw = fs.readFileSync(filePath, 'utf-8') } catch { return null }
  return parseAndValidateIndex(raw)
}

interface SearchOptions {
  topK: number
  similarityThreshold: number
  maxContextChars: number
}

export function search(
  chunks: Chunk[],
  queryVec: number[],
  opts: SearchOptions = KB_DEFAULTS,
): Chunk[] {
  const scored = chunks
    .map(c => ({ c, score: c.vector ? cosineSimilarity(queryVec, c.vector) : 0 }))
    .filter(s => s.score >= opts.similarityThreshold)
    .sort((a, b) => b.score - a.score)

  const out: Chunk[] = []
  let chars = 0
  for (const { c } of scored) {
    if (out.length >= opts.topK) break
    if (chars + c.text.length > opts.maxContextChars && out.length > 0) break
    out.push({ id: c.id, text: c.text, textbook: c.textbook, heading: c.heading })
    chars += c.text.length
  }
  return out
}
```

- [ ] **Step 4：跑测试确认通过** → 全 PASS。

- [ ] **Step 5：commit**

```bash
git add electron/services/knowledge/knowledgeIndex.ts tests/knowledge/knowledgeIndex.test.ts
git commit -m "feat(kb): add index parse/validate (model-aware degrade) + cosine search"
```

---

## Task 6：buildKbContext（命中→提示词段，纯函数）

**Files:** Create `electron/services/knowledge/buildKbContext.ts`, `tests/knowledge/buildKbContext.test.ts`

- [ ] **Step 1：写失败测试** —— 创建 `tests/knowledge/buildKbContext.test.ts`：

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildKbContext } from '../../electron/services/knowledge/buildKbContext'
import type { Chunk } from '../../electron/services/knowledge/types'

const chunks: Chunk[] = [
  { id: 'c1', text: '摩擦力是阻碍相对运动的力。', textbook: '人教版 八年级下', heading: '8.3 摩擦力' },
]

describe('buildKbContext', () => {
  it('returns empty string when no chunks', () => {
    expect(buildKbContext([])).toBe('')
  })
  it('includes textbook/heading label and chunk text', () => {
    const out = buildKbContext(chunks)
    expect(out).toContain('人教版 八年级下 · 8.3 摩擦力')
    expect(out).toContain('摩擦力是阻碍相对运动的力。')
  })
  it('states the four answering rules incl. no-leak', () => {
    const out = buildKbContext(chunks)
    expect(out).toContain('教材优先')
    expect(out).toContain('可补充')
    expect(out).toContain('不过度超纲')
    expect(out).toContain('不暴露检索过程')
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/knowledge/buildKbContext.test.ts`
Expected: FAIL `Cannot find module ...buildKbContext`。

- [ ] **Step 3：实现 `electron/services/knowledge/buildKbContext.ts`**

```ts
import type { Chunk } from './types'

export function buildKbContext(chunks: Chunk[]): string {
  if (chunks.length === 0) return ''
  const refs = chunks
    .map(c => `【${c.textbook} · ${c.heading}】${c.text}`)
    .join('\n')
  return `以下是与当前问题相关的教材参考资料（仅供你参考，按相关度排序）：
${refs}

作答要求：
1. 教材优先——优先依据上述教材的内容、定义、术语和讲法作答；
2. 可补充——教材未覆盖的点可用通识适度补充，但以教材为准，不编造教材中不存在的内容；
3. 不过度超纲——贴合教材所在学段的深度，不引入明显超出该学段的概念或推导；
4. 不暴露检索过程——绝不在回答里提及"教材参考资料/片段/相似度/检索/章节编号"等字样，也不要罗列出处；自然作答。`
}
```

- [ ] **Step 4：跑测试确认通过** → 全 PASS。

- [ ] **Step 5：commit**

```bash
git add electron/services/knowledge/buildKbContext.ts tests/knowledge/buildKbContext.test.ts
git commit -m "feat(kb): add buildKbContext (textbook-first prompt block, no-leak rules)"
```

---

## Task 7：retriever（embed + search + 降级）

**Files:** Create `electron/services/knowledge/retriever.ts`, `tests/knowledge/retriever.test.ts`

- [ ] **Step 1：写失败测试** —— 创建 `tests/knowledge/retriever.test.ts`：

```ts
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createKbRetriever } from '../../electron/services/knowledge/retriever'
import type { Chunk } from '../../electron/services/knowledge/types'

const chunks: Chunk[] = [
  { id: 'c1', text: 'near', textbook: 'tb', heading: 'h1', vector: [1, 0] },
  { id: 'c2', text: 'far', textbook: 'tb', heading: 'h2', vector: [0, 1] },
]

function fakeClient(embed: (texts: string[]) => Promise<number[][]>) {
  return { embed: vi.fn(embed) } as unknown as import('../../electron/services/knowledge/embeddingClient').EmbeddingClient
}

const opts = { topK: 5, similarityThreshold: 0.45, maxContextChars: 3500 }

describe('createKbRetriever', () => {
  it('embeds the query and returns matching chunks', async () => {
    const r = createKbRetriever(fakeClient(async () => [[1, 0]]), chunks, opts)
    const out = await r.retrieve('摩擦力')
    expect(out.map(c => c.id)).toEqual(['c1'])
  })
  it('returns [] for blank query without embedding', async () => {
    const client = fakeClient(async () => [[1, 0]])
    const r = createKbRetriever(client, chunks, opts)
    expect(await r.retrieve('   ')).toEqual([])
    expect(client.embed).not.toHaveBeenCalled()
  })
  it('degrades to [] when embedding throws', async () => {
    const r = createKbRetriever(fakeClient(async () => { throw new Error('network') }), chunks, opts)
    expect(await r.retrieve('摩擦力')).toEqual([])
  })
  it('returns [] when index has no chunks', async () => {
    const r = createKbRetriever(fakeClient(async () => [[1, 0]]), [], opts)
    expect(await r.retrieve('摩擦力')).toEqual([])
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/knowledge/retriever.test.ts`
Expected: FAIL `Cannot find module ...retriever`。

- [ ] **Step 3：实现 `electron/services/knowledge/retriever.ts`**

```ts
import type { Chunk } from './types'
import { KB_DEFAULTS } from './types'
import type { EmbeddingClient } from './embeddingClient'
import { search } from './knowledgeIndex'

export interface KbRetriever {
  retrieve(query: string): Promise<Chunk[]>
}

interface RetrieverOptions {
  topK: number
  similarityThreshold: number
  maxContextChars: number
}

export function createKbRetriever(
  embeddingClient: EmbeddingClient,
  chunks: Chunk[],
  opts: RetrieverOptions = KB_DEFAULTS,
): KbRetriever {
  return {
    async retrieve(query: string): Promise<Chunk[]> {
      if (!query.trim() || chunks.length === 0) return []
      try {
        const [queryVec] = await embeddingClient.embed([query])
        if (!queryVec || queryVec.length === 0) return []
        return search(chunks, queryVec, opts)
      } catch (err) {
        console.warn('[kb] retrieve failed, degrade to no-context:', err)
        return []
      }
    },
  }
}
```

- [ ] **Step 4：跑测试确认通过** → 全 PASS。

- [ ] **Step 5：commit**

```bash
git add electron/services/knowledge/retriever.ts tests/knowledge/retriever.test.ts
git commit -m "feat(kb): add createKbRetriever (embed query + search + silent degrade)"
```

---

## Task 8：build-kb 脚本 + 配置（gitignore / package.json / env.example / README）

**Files:** Create `scripts/build-kb.ts`, `knowledge/README.md`; Modify `package.json`, `.gitignore`, `.env.example`

> 无单测（逻辑已在 chunker/embeddingClient 被测）。本任务靠 tsc + 手动跑验证。

- [ ] **Step 1：装 tsx**

Run: `npm i -D tsx`
Expected: `tsx` 进 devDependencies。

- [ ] **Step 2：创建 `scripts/build-kb.ts`**

```ts
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { chunkMarkdown } from '../electron/services/knowledge/chunker'
import { EmbeddingClient } from '../electron/services/knowledge/embeddingClient'
import type { Chunk, KnowledgeIndexFile } from '../electron/services/knowledge/types'
import { INDEX_VERSION, EMBEDDING_MODEL, EMBEDDING_DIM, KB_DEFAULTS } from '../electron/services/knowledge/types'

const TEXTBOOKS_DIR = path.join(process.cwd(), 'knowledge', 'textbooks')
const OUT_PATH = path.join(process.cwd(), 'knowledge', 'index.json')
const BATCH = 32

function die(msg: string): never {
  console.error(`[build-kb] 失败：${msg}`)
  process.exit(1)
}

// 教材名：优先 front-matter `textbook:`，否则文件名（去 .md）。
function textbookName(file: string, content: string): string {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(content)
  if (fm) {
    const m = /^textbook:\s*(.+)$/m.exec(fm[1])
    if (m) return m[1].trim()
  }
  return path.basename(file, '.md')
}

async function main() {
  const apiKey = process.env.SILICONFLOW_API_KEY ?? ''
  if (!apiKey) die('缺 SILICONFLOW_API_KEY，请在 .env 配置')

  let files: string[]
  try {
    files = fs.readdirSync(TEXTBOOKS_DIR).filter(f => f.endsWith('.md'))
  } catch {
    die(`读不到教材目录 ${TEXTBOOKS_DIR}（先放入 *.md）`)
  }
  if (files.length === 0) die(`${TEXTBOOKS_DIR} 下没有 .md 教材`)

  const allChunks: Chunk[] = []
  for (const file of files) {
    const content = fs.readFileSync(path.join(TEXTBOOKS_DIR, file), 'utf-8')
    const tb = textbookName(file, content)
    const chunks = chunkMarkdown(content, tb, { chunkSize: KB_DEFAULTS.chunkSize, chunkOverlap: KB_DEFAULTS.chunkOverlap })
    console.log(`[build-kb] ${file} → ${chunks.length} chunks（${tb}）`)
    allChunks.push(...chunks)
  }
  if (allChunks.length === 0) die('切块结果为空')

  const client = new EmbeddingClient(apiKey)
  const t0 = Date.now()
  for (let i = 0; i < allChunks.length; i += BATCH) {
    const batch = allChunks.slice(i, i + BATCH)
    let vectors: number[][]
    try {
      vectors = await client.embed(batch.map(c => c.text))
    } catch (err) {
      die(`embedding 调用失败 @${i}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (vectors.length !== batch.length) die(`embedding 数量不符 @${i}`)
    batch.forEach((c, j) => { c.vector = vectors[j] })
    console.log(`[build-kb] embedded ${Math.min(i + BATCH, allChunks.length)}/${allChunks.length}`)
    await new Promise(r => setTimeout(r, 200))   // 轻限速
  }

  const index: KnowledgeIndexFile = {
    version: INDEX_VERSION,
    embeddingModel: EMBEDDING_MODEL,
    embeddingDim: EMBEDDING_DIM,
    chunkSize: KB_DEFAULTS.chunkSize,
    chunkOverlap: KB_DEFAULTS.chunkOverlap,
    builtAt: new Date().toISOString(),
    chunks: allChunks,
  }
  try {
    fs.writeFileSync(OUT_PATH, JSON.stringify(index), 'utf-8')
  } catch (err) {
    die(`写 index.json 失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  console.log(`[build-kb] 完成：${allChunks.length} chunks → ${OUT_PATH}（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
}

main()
```

- [ ] **Step 3：`package.json` 加脚本** —— 在 `scripts` 内加：

```json
    "build-kb": "tsx scripts/build-kb.ts",
```

- [ ] **Step 4：`.gitignore` 追加**

```
knowledge/textbooks/
knowledge/index.json
```

- [ ] **Step 5：创建 `knowledge/README.md`**

```markdown
# 知识库（物理教材 RAG）

- 把教材 markdown 放到 `knowledge/textbooks/*.md`（每文件一本；可在文件头加 front-matter `textbook: 人教版 八年级下` 指定教材名，否则用文件名）。
- 运行 `npm run build-kb` 生成 `knowledge/index.json`（需 `.env` 里有 `SILICONFLOW_API_KEY`）。
- `textbooks/` 与 `index.json` 已 gitignore（出版物文本 + 体积，不入仓）。
- 改 embedding 模型 / chunk 参数后需重跑 build-kb；旧 index 会被运行时自动降级（不会误用）。
- **打包前必须先跑 build-kb**，否则打出的 app 没有知识库。
```

- [ ] **Step 6：`.env.example` 给 SILICONFLOW 补注释** —— 把该行上方注释补一句：

```
# Silicon Flow API key — 语音转写（push-to-talk）与教材知识库 embedding 共用
```

- [ ] **Step 7：`npx tsc --noEmit`** → 无错（脚本与 knowledge 模块类型干净）。

- [ ] **Step 8：commit**

```bash
git add scripts/build-kb.ts knowledge/README.md package.json package-lock.json .gitignore .env.example
git commit -m "feat(kb): add build-kb script + config (gitignore textbooks/index, npm script, README)"
```

---

## Task 9：DeepseekAIProvider 接入检索

**Files:** Modify `electron/services/DeepseekAIProvider.ts`; Create `tests/DeepseekAIProvider.kb.test.ts`

> `tests/DeepseekAIProvider.test.ts` 已存在——**不要动它**。KB 测试放独立新文件。构造器新增的 `retriever?`/`fetchImpl?` 都是可选默认值，向后兼容；现有测试构造 `new DeepseekAIProvider(key)` + mock 全局 fetch 仍成立（kbContext='' 时 system prompt 与改前逐字相同）。

- [ ] **Step 1：写失败测试** —— 创建 `tests/DeepseekAIProvider.kb.test.ts`：

```ts
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { DeepseekAIProvider } from '../electron/services/DeepseekAIProvider'
import type { Chunk } from '../electron/services/knowledge/types'

const catalog = { promptSnippet: '（资源库快照）', cardMap: new Map() } as unknown as import('../electron/services/resourceCatalog').ResourceCatalogService

function captureFetch() {
  const calls: RequestInit[] = []
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(init)
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"reply":"ok","resourceIds":[]}' } }] }),
    } as unknown as Response
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

const hitChunks: Chunk[] = [
  { id: 'c1', text: '摩擦力是阻碍相对运动的力。', textbook: '人教版 八年级下', heading: '8.3 摩擦力' },
]

describe('DeepseekAIProvider with KB retriever', () => {
  it('injects 教材参考资料 into system prompt when retriever hits', async () => {
    const { fetchImpl, calls } = captureFetch()
    const retriever = { retrieve: vi.fn(async () => hitChunks) }
    const provider = new DeepseekAIProvider('sk', retriever, fetchImpl)
    await provider.chat([{ role: 'user', content: '摩擦力是什么' }], catalog)
    expect(retriever.retrieve).toHaveBeenCalledWith('摩擦力是什么')
    const body = JSON.parse(calls[0].body as string)
    expect(body.messages[0].content).toContain('教材参考资料')
    expect(body.messages[0].content).toContain('摩擦力是阻碍相对运动的力。')
  })

  it('falls back to plain prompt when retriever returns []', async () => {
    const { fetchImpl, calls } = captureFetch()
    const retriever = { retrieve: vi.fn(async () => []) }
    const provider = new DeepseekAIProvider('sk', retriever, fetchImpl)
    await provider.chat([{ role: 'user', content: '你好' }], catalog)
    const body = JSON.parse(calls[0].body as string)
    expect(body.messages[0].content).not.toContain('教材参考资料')
  })

  it('works without a retriever (unchanged behavior)', async () => {
    const { fetchImpl, calls } = captureFetch()
    const provider = new DeepseekAIProvider('sk', undefined, fetchImpl)
    const res = await provider.chat([{ role: 'user', content: '你好' }], catalog)
    expect(res.reply).toBe('ok')
    const body = JSON.parse(calls[0].body as string)
    expect(body.messages[0].content).not.toContain('教材参考资料')
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/DeepseekAIProvider.kb.test.ts`
Expected: FAIL（构造器还不接受 retriever/fetchImpl；system prompt 无注入）。

- [ ] **Step 3：改 `electron/services/DeepseekAIProvider.ts`**

import 区追加：

```ts
import type { KbRetriever } from './knowledge/retriever'
import { buildKbContext } from './knowledge/buildKbContext'
```

把 `buildSystemPrompt` 改为接受 kbContext：

```ts
function buildSystemPrompt(catalog: ResourceCatalogService, kbContext: string): string {
  const kbBlock = kbContext ? `\n\n${kbContext}` : ''
  return `你是一位物理教学助手，帮助教师备课和课堂资源调用。
根据对话上下文给出简洁专业的回复，并从以下资源库中选出最相关的资源（最多3个）。

资源库：
${catalog.promptSnippet}${kbBlock}

严格按以下 JSON 格式返回，不要包含任何其他文字：
{"reply":"你的回复","resourceIds":["id1"]}
如不需要推送资源，resourceIds 返回空数组。`
}
```

把 class 改为接受注入：

```ts
export class DeepseekAIProvider {
  constructor(
    private readonly apiKey: string,
    private readonly retriever?: KbRetriever,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async chat(messages: AgentMessage[], catalog: ResourceCatalogService): Promise<AIResponse> {
    const latestUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? ''
    const kbChunks = this.retriever ? await this.retriever.retrieve(latestUser) : []
    const kbContext = buildKbContext(kbChunks)

    const response = await this.fetchImpl(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: buildSystemPrompt(catalog, kbContext) }, ...messages],
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) {
      throw new DeepseekHTTPError(response.status)
    }

    const data = await response.json()
    const rawContent: string = (data as { choices: Array<{ message: { content: string } }> })
      .choices?.[0]?.message?.content ?? ''

    return parseAndMap(rawContent, catalog)
  }
}
```

- [ ] **Step 4：跑新测试 + 现有 provider 测试（确认不回归）+ tsc**

Run: `npx vitest run tests/DeepseekAIProvider.kb.test.ts tests/DeepseekAIProvider.test.ts && npx tsc --noEmit`
Expected: 新 KB 测试 PASS；**现有 `DeepseekAIProvider.test.ts` 仍全 PASS**；tsc 干净。

- [ ] **Step 5：commit**

```bash
git add electron/services/DeepseekAIProvider.ts tests/DeepseekAIProvider.kb.test.ts
git commit -m "feat(deepseek): inject KB context into system prompt via optional retriever"
```

---

## Task 10：main.ts 接线（加载 index + 注入 provider）

**Files:** Modify `electron/main.ts`

> 无独立单测——Task 5/7/9 已覆盖逻辑；本任务靠 tsc + 手动验收（Task 11）。

- [ ] **Step 1：import 区追加**

```ts
import { loadKnowledgeIndex } from './services/knowledge/knowledgeIndex'
import { EmbeddingClient } from './services/knowledge/embeddingClient'
import { createKbRetriever } from './services/knowledge/retriever'
import type { KbRetriever } from './services/knowledge/retriever'
```

- [ ] **Step 2：启动加载 index + 工厂函数** —— 在 `let deepseekProvider!: DeepseekAIProvider` 之后追加：

```ts
// 知识库：启动加载一次；缺失/不兼容则 retriever 为 undefined（chat 自动退化为无教材）
const kbIndex = loadKnowledgeIndex(path.join(__dirname, '../knowledge/index.json'))
if (kbIndex) {
  console.log(`[kb] index loaded: ${kbIndex.chunks.length} chunks (${kbIndex.embeddingModel})`)
} else {
  console.log('[kb] no usable index — KB disabled, answering without textbooks')
}

function makeDeepseekProvider(): DeepseekAIProvider {
  let retriever: KbRetriever | undefined
  const sfKey = process.env.SILICONFLOW_API_KEY ?? ''
  if (kbIndex && sfKey) {
    retriever = createKbRetriever(new EmbeddingClient(sfKey), kbIndex.chunks)
  }
  return new DeepseekAIProvider(apiKey, retriever)
}
```

- [ ] **Step 3：把两处 `new DeepseekAIProvider(apiKey)` 换成 `makeDeepseekProvider()`**

`app.whenReady` 内：

```ts
  reloadApiKey()
  deepseekProvider = makeDeepseekProvider()
```

`set-api-key` IPC 内：

```ts
    reloadApiKey()
    deepseekProvider = makeDeepseekProvider()
    return undefined
```

- [ ] **Step 4：`electron-builder.json` 的 `files` 加 `knowledge/index.json`** —— 在 files 数组里追加一项：

```json
  "knowledge/index.json",
```

- [ ] **Step 5：`npx tsc --noEmit && npx vitest run`** → tsc 干净；全量测试通过。

- [ ] **Step 6：commit**

```bash
git add electron/main.ts electron-builder.json
git commit -m "feat(main): load KB index at startup, wire retriever into DeepseekAIProvider; bundle index.json"
```

---

## Task 11：全量验证 + 手动验收

**Files:** 无（验证任务）

- [ ] **Step 1：自动验收**

```bash
npx tsc --noEmit
npx vitest run
```
Expected: tsc 无错；全部测试 PASS。

- [ ] **Step 2：gitignore 验收**

```bash
git check-ignore knowledge/textbooks/dummy.md knowledge/index.json .env
git status --short    # 确认上述不出现在待提交里；knowledge/README.md 可被跟踪
```
Expected: 前三者被 ignore；README 正常入仓。

- [ ] **Step 3：建库手动验收（需真教材 + key）**

```bash
# 放好 knowledge/textbooks/*.md 后：
npm run build-kb
ls -l knowledge/index.json
```
Expected: 打印各教材 chunk 数 + 进度，产出 index.json；故意删 key 跑一次应**报错 exit(1) 且不产出半成品**。

- [ ] **Step 4：运行时手动验收（`npm run dev` + Electron）**

逐条核对：
1. 问教材覆盖的问题（如"摩擦力的定义"）→ 回答贴合教材内容/术语，**且不出现"教材/片段/检索"等字样**。
2. 问教材外/闲聊 → 正常回答（降级，不阻断）。
3. 删 `knowledge/index.json` 重启 → `[kb] no usable index`，仍能正常回答。
4. DevTools/控制台无未捕获异常。

- [ ] **Step 5（按需）：首日调参** —— 据真实命中调 `similarityThreshold`/`topK`/`chunkSize`（改 chunk 需重建），改动配套更新/新增单测后重跑 `npx vitest run`，commit。

---

## Self-Review（plan vs spec）

**Spec 覆盖：**
- §1 组件（chunker/embeddingClient/knowledgeIndex/cosine/buildKbContext/build-kb/provider 改造）→ Task 2–10 ✓
- §2 鉴权/模型/首日参数/失败分阶段 → Task 1（常量）+ Task 4（model）+ Task 5（校验降级）+ Task 7（运行时降级）+ Task 8（build-kb exit1）✓
- §3 提示词 4 规则（含不暴露检索）→ Task 6 + Task 9 ✓
- §4 存储/gitignore/打包带 index.json → Task 8（gitignore）+ Task 10（electron-builder）✓
- §5 build-kb 脚本（front-matter 教材名 / 批量 / exit1）→ Task 8 ✓
- §6 错误处理（脚本报错 vs 运行时降级 / index 缺失损坏 / 维度不符）→ Task 5/7/8 ✓
- §7 测试策略 → 各 Task 的 test 步骤 ✓
- §8 文件清单 → File Structure ✓
- §9 首日可调 → Task 11 Step 5 ✓
- §10 分支与验收（gitignore 验收 / 不暴露 / 降级 / build-kb exit1）→ Task 11 ✓

**占位符扫描：** 无 TODO/TBD；参数为带注释常量；唯一"待真实数据"项是 Task 11 首日调参（有明确步骤）。

**类型一致：** `Chunk`/`KnowledgeIndexFile`/`KB_DEFAULTS`/`EMBEDDING_MODEL`/`EMBEDDING_DIM`/`INDEX_VERSION`（Task1）贯穿 2–10；`EmbeddingClient.embed`、`search(chunks,vec,opts)`、`parseAndValidateIndex`、`buildKbContext(chunks)`、`createKbRetriever(client,chunks,opts)`/`KbRetriever.retrieve`、`DeepseekAIProvider(apiKey, retriever?, fetchImpl?)` 在各 Task 签名一致。

---

## Execution Handoff

Plan complete。建议：先由 `superpowers:using-git-worktrees` 从 `main` 建 `feature/physics-kb-rag` worktree（拷 `.env`），再逐 Task 执行；每 Task 跑测试；完成后 code review → 手动验收。
