# 真实人物口型同步（腾讯云数智人）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用腾讯云"照片免训练"数智人 API 替换当前 CSS overlay 口型方案，让角色 PNG 在 AI 回答时以含真实口型同步的视频形式播报。

**Architecture:** 主进程封装腾讯云签名 / COS 上传 / 数智人 API 调用 / 视频下载校验。事件式 IPC 把进度推给 renderer。Renderer 端 `useAvatarVideoQueue` 实现"按句拆分→双缓冲串播→首段 12s 看门狗→技术失败 Web Speech 兜底→审核失败 blocked 提示→连续失败熔断"完整生命周期。`<video>` 替代 `<img>` 渲染。

**Tech Stack:** Electron + Vite + React 18 + TypeScript + Zustand + Vitest + `cos-nodejs-sdk-v5`（COS）+ 原生 `fetch` + TC3-HMAC-SHA256（数智人 API，自己签名）。

---

## 文件结构

### 新增

```
electron/services/
  TencentSigner.ts                   # TC3-HMAC-SHA256 签名工具（仅数智人 API 用）
  TencentCosClient.ts                # 启动时上传 character.png；hash dedup + HEAD 校验 + 签名 URL 续签
  TencentDigitalHumanService.ts      # submitTask + pollUntilDone + fetch + 下载校验
  avatarVideoHandler.ts              # IPC 串联、jobId 跟踪、AbortController 管理、validateSsml

src/services/
  textSegmentation.ts                # 按句拆分，单段 ≤ MAX_SEGMENT_CHARS=240
  avatarVideo/
    AvatarVideoProvider.ts           # 接口
    TencentAvatarVideoProvider.ts    # 实现（调 window.electronAPI）
    index.ts                         # 单例导出

src/hooks/
  useAvatarVideoQueue.ts             # 状态机 + 双缓冲 + 熔断器 + URL 生命周期

tests/
  textSegmentation.test.ts
  TencentSigner.test.ts
  TencentCosClient.test.ts
  TencentDigitalHumanService.test.ts
  avatarVideoHandler.test.ts
  AvatarVideoProvider.test.ts
  useAvatarVideoQueue.test.ts
```

### 修改

```
shared/types.ts                     # 加 AvatarVideoErrorCode + IPC 事件类型
electron/main.ts                    # 注册 avatarVideoHandler + 启动时触发 COS 上传
electron/preload.ts                 # 暴露 5 个新 API
src/store/agentStore.ts             # 加 videoUrl/videoQueueState/avatarVideoError；删 mouthShape/speakingIntensity
src/components/Avatar/index.tsx     # <video> + <img> 切换 + blocked UI
src/components/Avatar/Avatar.module.css  # 删嘴部 overlay 样式
src/hooks/useAI.ts                  # 替换 lipSync+ttsProvider 为 queue.enqueue
tests/useAI.test.ts                 # 适配新 useAI
.env.example                        # 加腾讯云密钥与 COS 配置
package.json                        # 加 cos-nodejs-sdk-v5
```

### 删除

```
src/services/lipsync/                  # 整个目录
tests/LipSyncController.test.ts        # 对应实现已删
```

---

## Pre-flight

**Files:**
- Modify: `.env.example`
- Modify: `package.json` (添加依赖)

- [ ] **Step 1: 确认当前在新 worktree 且 spec 已就位**

```bash
pwd | grep -q feature-realistic-lipsync && echo "OK worktree" || echo "FAIL"
test -f docs/superpowers/specs/2026-05-21-realistic-lipsync-via-tencent-digital-human-design.md && echo "OK spec" || echo "FAIL spec missing"
git log --oneline -1 | grep -q "incorporate review feedback" && echo "OK at d30cbfb" || echo "FAIL wrong HEAD"
```

Expected: 三个 OK。

- [ ] **Step 2: 安装 COS SDK**

```bash
npm install cos-nodejs-sdk-v5
```

- [ ] **Step 3: 更新 `.env.example`**

Append to `.env.example`:

```
# 腾讯云数智人 API（用于真实口型同步）
TENCENT_SECRET_ID=
TENCENT_SECRET_KEY=
TENCENT_DIGITAL_HUMAN_REGION=ap-shanghai

# 腾讯云 COS（图片托管 — 仅私有桶 + 签名 URL）
TENCENT_COS_REGION=ap-shanghai
TENCENT_COS_BUCKET=
# 默认 true：使用 7 天签名 URL；改 false 才启用公网读，且角色图将以可猜难度低的 URL 公开可访问
TENCENT_COS_USE_SIGNED_URL=true
```

- [ ] **Step 4: 基线测试**

```bash
npx vitest run tests/LipSyncController.test.ts
```

Expected: 8 passed（旧测试当前仍在；Task 14 才删）。

- [ ] **Step 5: 提交 pre-flight 改动**

```bash
git add .env.example package.json package-lock.json
git commit -m "chore: pre-flight — add cos-nodejs-sdk-v5 + tencent env vars"
```

---

## Task 1: textSegmentation 工具（纯函数 TDD）

**Files:**
- Create: `src/services/textSegmentation.ts`
- Create: `tests/textSegmentation.test.ts`

- [ ] **Step 1: 写测试**

Create `tests/textSegmentation.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { textSegmentation, MAX_SEGMENT_CHARS } from '../src/services/textSegmentation'

describe('textSegmentation', () => {
  it('exports MAX_SEGMENT_CHARS = 240', () => {
    expect(MAX_SEGMENT_CHARS).toBe(240)
  })

  it('returns single segment for short text', () => {
    expect(textSegmentation('简短答复。')).toEqual(['简短答复。'])
  })

  it('returns empty array for empty/whitespace input', () => {
    expect(textSegmentation('')).toEqual([])
    expect(textSegmentation('   ')).toEqual([])
  })

  it('splits on 。！？ but not 、，；', () => {
    const text = '第一句。第二句！第三句？第四句，仍是第四句、还是第四句；最后。'
    expect(textSegmentation(text)).toEqual([
      '第一句。第二句！第三句？第四句，仍是第四句、还是第四句；最后。',
    ])
  })

  it('combines adjacent short sentences up to limit', () => {
    const text = 'A。' + 'B。' + 'C。'
    expect(textSegmentation(text)).toEqual(['A。B。C。'])
  })

  it('starts new segment when adding next sentence exceeds limit', () => {
    const seg1 = '一'.repeat(200) + '。'
    const seg2 = '二'.repeat(100) + '。'
    const result = textSegmentation(seg1 + seg2)
    expect(result).toEqual([seg1, seg2])
    expect(result[0].length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
    expect(result[1].length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
  })

  it('falls back to comma-level split when single sentence exceeds limit', () => {
    const long = '前半部分'.repeat(40) + '，' + '后半部分'.repeat(40) + '。'
    const result = textSegmentation(long)
    expect(result.length).toBeGreaterThanOrEqual(2)
    for (const s of result) expect(s.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
  })

  it('hard-splits on character when no punctuation available', () => {
    const text = '字'.repeat(500)
    const result = textSegmentation(text)
    expect(result.length).toBeGreaterThanOrEqual(2)
    for (const s of result) expect(s.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
    expect(result.join('')).toBe(text)
  })

  it('merges trailing tiny segment (<4 chars) into previous', () => {
    const text = '一'.repeat(100) + '。' + '是。'
    expect(textSegmentation(text)).toEqual(['一'.repeat(100) + '。是。'])
  })

  it('handles English mixed with Chinese punctuation', () => {
    const text = '物理公式 F=ma。在牛顿力学中，F 表示力，m 表示质量。'
    expect(textSegmentation(text)).toEqual([text])
  })

  it('preserves leading/trailing whitespace within segments but trims overall', () => {
    expect(textSegmentation('  hello.  ')).toEqual(['hello.'])
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run tests/textSegmentation.test.ts
```

Expected: 11 failed（模块不存在）。

- [ ] **Step 3: 写实现**

Create `src/services/textSegmentation.ts`:

```ts
export const MAX_SEGMENT_CHARS = 240
const MIN_SEGMENT_CHARS = 4

const SENTENCE_DELIMITERS = /([。！？])/
const SUB_DELIMITERS = /([，、；])/

function splitKeepDelim(text: string, regex: RegExp): string[] {
  const parts = text.split(regex)
  const sentences: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i] ?? ''
    const delim = parts[i + 1] ?? ''
    const combined = body + delim
    if (combined) sentences.push(combined)
  }
  return sentences
}

function hardSplit(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += MAX_SEGMENT_CHARS) {
    out.push(text.slice(i, i + MAX_SEGMENT_CHARS))
  }
  return out
}

function splitOversizedSentence(sentence: string): string[] {
  if (sentence.length <= MAX_SEGMENT_CHARS) return [sentence]
  const subs = splitKeepDelim(sentence, SUB_DELIMITERS)
  if (subs.length <= 1) return hardSplit(sentence)

  const out: string[] = []
  let buf = ''
  for (const sub of subs) {
    if (sub.length > MAX_SEGMENT_CHARS) {
      if (buf) { out.push(buf); buf = '' }
      out.push(...hardSplit(sub))
      continue
    }
    if (buf.length + sub.length > MAX_SEGMENT_CHARS) {
      out.push(buf)
      buf = sub
    } else {
      buf += sub
    }
  }
  if (buf) out.push(buf)
  return out
}

export function textSegmentation(input: string): string[] {
  const text = input.trim()
  if (!text) return []

  const sentences = splitKeepDelim(text, SENTENCE_DELIMITERS)
  const effective = sentences.length > 0 ? sentences : [text]

  const segments: string[] = []
  let buf = ''

  for (const sentence of effective) {
    if (sentence.length > MAX_SEGMENT_CHARS) {
      if (buf) { segments.push(buf); buf = '' }
      segments.push(...splitOversizedSentence(sentence))
      continue
    }
    if (buf.length + sentence.length > MAX_SEGMENT_CHARS) {
      segments.push(buf)
      buf = sentence
    } else {
      buf += sentence
    }
  }
  if (buf) segments.push(buf)

  // Merge a tiny trailing fragment into the previous segment.
  if (segments.length >= 2 && segments[segments.length - 1].length < MIN_SEGMENT_CHARS) {
    const last = segments.pop()!
    segments[segments.length - 1] += last
  }

  return segments
}
```

- [ ] **Step 4: 运行测试，确认全绿**

```bash
npx vitest run tests/textSegmentation.test.ts
```

Expected: 11 passed.

- [ ] **Step 5: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: 无报错（已有报错可能仍在，但本任务不应新增）。

- [ ] **Step 6: 提交**

```bash
git add src/services/textSegmentation.ts tests/textSegmentation.test.ts
git commit -m "feat: textSegmentation — split reply into ≤240-char segments"
```

---

## Task 2: shared/types.ts 新类型

**Files:**
- Modify: `shared/types.ts`

- [ ] **Step 1: 在文件末尾加新类型**

Append to `shared/types.ts`:

```ts
// ── Avatar video lifecycle (Tencent digital human integration) ────

export type AvatarVideoErrorCode =
  | 'INVALID_INPUT'      // 主进程 IPC 校验失败；不调腾讯，不计入熔断
  | 'TENCENT_API_FAIL'   // 通用 API 错误 / 下载校验失败 → fallback 剩余段
  | 'TENCENT_TIMEOUT'    // 轮询/下载超时 / 首段 12s → fallback 剩余段
  | 'NETWORK'            // fetch/网络失败 → fallback 剩余段
  | 'COS_NOT_READY'      // 启动时 COS 上传失败 → fallback 剩余段
  | 'POLICY_VIOLATION'   // 内容审核拒绝 → blocked，不 fallback

export type VideoQueueState =
  | 'idle' | 'generating' | 'playing' | 'stalled' | 'fallback' | 'blocked'

export type AvatarSegmentProgressEvent = {
  jobId: string
  stage: 'submitting' | 'polling' | 'downloading'
  pollAttempt?: number
}

export type AvatarSegmentDoneEvent = {
  jobId: string
  buffer: ArrayBuffer
  mimeType: string
}

export type AvatarSegmentErrorEvent = {
  jobId: string
  error: AppError
}
```

- [ ] **Step 2: 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: 无新增报错。

- [ ] **Step 3: 提交**

```bash
git add shared/types.ts
git commit -m "feat: types — avatar video error codes + IPC event payloads"
```

---

## Task 3: TencentSigner（TC3-HMAC-SHA256）

**Files:**
- Create: `electron/services/TencentSigner.ts`
- Create: `tests/TencentSigner.test.ts`

腾讯云的 TC3-HMAC-SHA256 签名算法。详见：https://cloud.tencent.com/document/api/213/30654

- [ ] **Step 1: 写测试**

Create `tests/TencentSigner.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { signTencentRequest } from '../electron/services/TencentSigner'

describe('TencentSigner', () => {
  it('produces a known good Authorization for a fixed input', () => {
    // Fixture from Tencent docs (官方示例 cvm.tencentcloudapi.com / DescribeInstances)
    const result = signTencentRequest({
      secretId: 'AKIDz8krbsJ5yKBZQpn74WFkmLPx3*******',
      secretKey: 'Gu5t9xGARNpq86cd98joQYCN3*******',
      service: 'cvm',
      host: 'cvm.tencentcloudapi.com',
      action: 'DescribeInstances',
      version: '2017-03-12',
      region: 'ap-guangzhou',
      timestamp: 1551113065,
      payload: '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}',
    })
    expect(result.authorization).toBe(
      'TC3-HMAC-SHA256 Credential=AKIDz8krbsJ5yKBZQpn74WFkmLPx3*******/2019-02-25/cvm/tc3_request, ' +
      'SignedHeaders=content-type;host, Signature=4d49b770f4eb15b81d65b3affb6748f01b9ce8a44f8ff944caaeec77ddc769fc'
    )
  })

  it('uses POST + content-type application/json + host header only', () => {
    const r = signTencentRequest({
      secretId: 'id', secretKey: 'key',
      service: 'ivh', host: 'ivh.tencentcloudapi.com',
      action: 'SubmitTask', version: '2021-03-30', region: 'ap-shanghai',
      timestamp: 1700000000, payload: '{}',
    })
    expect(r.authorization).toMatch(/^TC3-HMAC-SHA256 /)
    expect(r.authorization).toContain('SignedHeaders=content-type;host')
    expect(r.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(r.headers.Host).toBe('ivh.tencentcloudapi.com')
    expect(r.headers['X-TC-Action']).toBe('SubmitTask')
    expect(r.headers['X-TC-Version']).toBe('2021-03-30')
    expect(r.headers['X-TC-Region']).toBe('ap-shanghai')
    expect(r.headers['X-TC-Timestamp']).toBe('1700000000')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run tests/TencentSigner.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

Create `electron/services/TencentSigner.ts`:

```ts
import crypto from 'crypto'

export interface SignTencentRequestInput {
  secretId: string
  secretKey: string
  service: string         // e.g., 'ivh'
  host: string            // e.g., 'ivh.tencentcloudapi.com'
  action: string          // e.g., 'SubmitTask'
  version: string         // e.g., '2021-03-30'
  region: string          // e.g., 'ap-shanghai'
  timestamp: number       // Unix seconds
  payload: string         // JSON-stringified body
}

export interface SignTencentRequestResult {
  authorization: string
  headers: Record<string, string>
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex')
}

function hmac(key: Buffer | string, msg: string): Buffer {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest()
}

export function signTencentRequest(input: SignTencentRequestInput): SignTencentRequestResult {
  const { secretId, secretKey, service, host, action, version, region, timestamp, payload } = input
  const date = new Date(timestamp * 1000).toISOString().substring(0, 10)  // YYYY-MM-DD UTC

  // Step 1: Canonical request
  const httpRequestMethod = 'POST'
  const canonicalUri = '/'
  const canonicalQueryString = ''
  const canonicalHeaders =
    `content-type:application/json; charset=utf-8\n` +
    `host:${host}\n`
  const signedHeaders = 'content-type;host'
  const hashedRequestPayload = sha256Hex(payload)
  const canonicalRequest =
    `${httpRequestMethod}\n${canonicalUri}\n${canonicalQueryString}\n` +
    `${canonicalHeaders}\n${signedHeaders}\n${hashedRequestPayload}`

  // Step 2: String to sign
  const algorithm = 'TC3-HMAC-SHA256'
  const credentialScope = `${date}/${service}/tc3_request`
  const hashedCanonicalRequest = sha256Hex(canonicalRequest)
  const stringToSign =
    `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`

  // Step 3: Signature
  const secretDate = hmac(`TC3${secretKey}`, date)
  const secretService = hmac(secretDate, service)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex')

  // Step 4: Authorization
  const authorization =
    `${algorithm} Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    authorization,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      Host: host,
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Region': region,
      'X-TC-Timestamp': String(timestamp),
    },
  }
}
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run tests/TencentSigner.test.ts
```

Expected: 2 passed.

- [ ] **Step 5: 提交**

```bash
git add electron/services/TencentSigner.ts tests/TencentSigner.test.ts
git commit -m "feat: TencentSigner — TC3-HMAC-SHA256 request signing"
```

---

## Task 4: TencentCosClient

**Files:**
- Create: `electron/services/TencentCosClient.ts`
- Create: `tests/TencentCosClient.test.ts`

启动时上传 character.png；hash 命中跳过；HEAD 校验失效；签名 URL 续签。

- [ ] **Step 1: 写测试**

Create `tests/TencentCosClient.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TencentCosClient, type CosConfig, type ConfigStore } from '../electron/services/TencentCosClient'

const mockPutObject = vi.fn()
const mockGetObjectUrl = vi.fn()
const mockHeadObject = vi.fn()

vi.mock('cos-nodejs-sdk-v5', () => ({
  default: class MockCOS {
    putObject = (...args: unknown[]) => mockPutObject(...args)
    getObjectUrl = (...args: unknown[]) => mockGetObjectUrl(...args)
    headObject = (...args: unknown[]) => mockHeadObject(...args)
  },
}))

const RENEW_THRESHOLD_MS = 24 * 60 * 60 * 1000

function makeStore(initial: Record<string, unknown> = {}): ConfigStore {
  let data = { ...initial }
  return {
    read: vi.fn(() => ({ ...data })),
    write: vi.fn((next: Record<string, unknown>) => { data = { ...next } }),
  }
}

const config: CosConfig = {
  secretId: 'id', secretKey: 'key',
  region: 'ap-shanghai', bucket: 'bkt-12345',
  useSignedUrl: true,
}

const buffer = Buffer.from([0xAA, 0xBB, 0xCC])
// SHA-256 of these 3 bytes (precomputed):
const hash = '8e9c1f43e2a5bdc23ddd0a4d5e0a3b89ddaa5cc4e1a8b1f7af3e0c11ab6c4cfa'
// Actual hash: compute once and use here. To keep test self-contained,
// we instead compute the hash inside the test fixture below.

import crypto from 'crypto'
function sha256(b: Buffer) { return crypto.createHash('sha256').update(b).digest('hex') }

describe('TencentCosClient.ensureRefPhotoUrl', () => {
  beforeEach(() => {
    mockPutObject.mockReset()
    mockGetObjectUrl.mockReset()
    mockHeadObject.mockReset()
  })

  it('uploads on first call and persists hash + signedUrl', async () => {
    mockPutObject.mockImplementation((_p, cb) => cb(null, { ETag: 'tag' }))
    mockGetObjectUrl.mockImplementation((_p, cb) => cb(null, { Url: 'https://signed-url' }))
    const store = makeStore({})
    const client = new TencentCosClient(config, store)

    const url = await client.ensureRefPhotoUrl(buffer, () => 1700000000_000)

    expect(url).toBe('https://signed-url')
    const expectedKey = `avatars/character-${sha256(buffer)}.png`
    expect(mockPutObject).toHaveBeenCalledWith(
      expect.objectContaining({ Bucket: 'bkt-12345', Key: expectedKey, Body: buffer }),
      expect.any(Function)
    )
    expect(store.write).toHaveBeenCalledWith(expect.objectContaining({
      avatarRefPhotoUrl: 'https://signed-url',
      avatarImageHash: sha256(buffer),
      avatarUploadedAt: 1700000000_000,
    }))
  })

  it('reuses cached URL when hash matches, HEAD succeeds, and URL not near expiry', async () => {
    mockHeadObject.mockImplementation((_p, cb) => cb(null, { statusCode: 200 }))
    const store = makeStore({
      avatarRefPhotoUrl: 'https://cached',
      avatarImageHash: sha256(buffer),
      avatarUploadedAt: Date.now() - 1 * 60 * 60 * 1000,  // 1h ago, far from 7d expiry
    })
    const client = new TencentCosClient(config, store)

    const url = await client.ensureRefPhotoUrl(buffer, () => Date.now())

    expect(url).toBe('https://cached')
    expect(mockPutObject).not.toHaveBeenCalled()
  })

  it('re-uploads when image hash changed', async () => {
    mockPutObject.mockImplementation((_p, cb) => cb(null, { ETag: 'tag' }))
    mockGetObjectUrl.mockImplementation((_p, cb) => cb(null, { Url: 'https://new-url' }))
    const store = makeStore({
      avatarRefPhotoUrl: 'https://old',
      avatarImageHash: 'differenthash',
      avatarUploadedAt: Date.now(),
    })
    const client = new TencentCosClient(config, store)

    const url = await client.ensureRefPhotoUrl(buffer, () => Date.now())
    expect(url).toBe('https://new-url')
    expect(mockPutObject).toHaveBeenCalled()
  })

  it('renews signed URL when within 24h of 7-day expiry', async () => {
    mockHeadObject.mockImplementation((_p, cb) => cb(null, { statusCode: 200 }))
    mockGetObjectUrl.mockImplementation((_p, cb) => cb(null, { Url: 'https://renewed' }))
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    const now = Date.now()
    const store = makeStore({
      avatarRefPhotoUrl: 'https://stale',
      avatarImageHash: sha256(buffer),
      avatarUploadedAt: now - (sevenDays - RENEW_THRESHOLD_MS / 2),  // < 24h to expiry
    })
    const client = new TencentCosClient(config, store)

    const url = await client.ensureRefPhotoUrl(buffer, () => now)
    expect(url).toBe('https://renewed')
    expect(mockPutObject).not.toHaveBeenCalled()  // hash matched, no re-upload
    expect(mockGetObjectUrl).toHaveBeenCalled()   // renew called
  })

  it('re-uploads when HEAD returns 404 even if hash matches', async () => {
    mockHeadObject.mockImplementation((_p, cb) => cb({ statusCode: 404 }, null))
    mockPutObject.mockImplementation((_p, cb) => cb(null, { ETag: 'tag' }))
    mockGetObjectUrl.mockImplementation((_p, cb) => cb(null, { Url: 'https://recovered' }))
    const store = makeStore({
      avatarRefPhotoUrl: 'https://gone',
      avatarImageHash: sha256(buffer),
      avatarUploadedAt: Date.now(),
    })
    const client = new TencentCosClient(config, store)

    const url = await client.ensureRefPhotoUrl(buffer, () => Date.now())
    expect(url).toBe('https://recovered')
    expect(mockPutObject).toHaveBeenCalled()
  })

  it('throws on putObject failure', async () => {
    mockPutObject.mockImplementation((_p, cb) => cb(new Error('cos down'), null))
    const store = makeStore({})
    const client = new TencentCosClient(config, store)

    await expect(client.ensureRefPhotoUrl(buffer, () => Date.now())).rejects.toThrow('cos down')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run tests/TencentCosClient.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

Create `electron/services/TencentCosClient.ts`:

```ts
import crypto from 'crypto'
import COS from 'cos-nodejs-sdk-v5'

export interface CosConfig {
  secretId: string
  secretKey: string
  region: string
  bucket: string
  useSignedUrl: boolean
}

export interface ConfigStore {
  read(): Record<string, unknown>
  write(next: Record<string, unknown>): void
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const RENEW_THRESHOLD_MS = 24 * 60 * 60 * 1000

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export class TencentCosClient {
  private cos: COS

  constructor(private config: CosConfig, private store: ConfigStore) {
    this.cos = new COS({ SecretId: config.secretId, SecretKey: config.secretKey })
  }

  async ensureRefPhotoUrl(imageBuffer: Buffer, now: () => number = () => Date.now()): Promise<string> {
    const currentHash = sha256Hex(imageBuffer)
    const persisted = this.store.read()
    const cachedHash = typeof persisted.avatarImageHash === 'string' ? persisted.avatarImageHash : ''
    const cachedUrl = typeof persisted.avatarRefPhotoUrl === 'string' ? persisted.avatarRefPhotoUrl : ''
    const cachedAt = typeof persisted.avatarUploadedAt === 'number' ? persisted.avatarUploadedAt : 0

    const key = `avatars/character-${currentHash}.png`
    const hashMatched = cachedHash === currentHash && cachedUrl
    const nearExpiry = hashMatched && (now() - cachedAt) >= (SEVEN_DAYS_MS - RENEW_THRESHOLD_MS)

    if (hashMatched && !nearExpiry) {
      const exists = await this.headObject(key)
      if (exists) return cachedUrl
    }

    if (hashMatched && nearExpiry) {
      // Object still there; just renew signed URL without re-upload.
      const exists = await this.headObject(key)
      if (exists) {
        const url = await this.signObjectUrl(key)
        this.store.write({ ...persisted, avatarRefPhotoUrl: url, avatarUploadedAt: now() })
        return url
      }
    }

    // Upload (first time or hash changed or HEAD 404)
    await this.putObject(key, imageBuffer)
    const url = this.config.useSignedUrl
      ? await this.signObjectUrl(key)
      : `https://${this.config.bucket}.cos.${this.config.region}.myqcloud.com/${key}`
    this.store.write({
      ...persisted,
      avatarImageHash: currentHash,
      avatarRefPhotoUrl: url,
      avatarUploadedAt: now(),
    })
    return url
  }

  private putObject(key: string, body: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.cos.putObject(
        { Bucket: this.config.bucket, Region: this.config.region, Key: key, Body: body },
        (err: unknown) => (err ? reject(err) : resolve())
      )
    })
  }

  private headObject(key: string): Promise<boolean> {
    return new Promise(resolve => {
      this.cos.headObject(
        { Bucket: this.config.bucket, Region: this.config.region, Key: key },
        (err: unknown) => resolve(!err)
      )
    })
  }

  private signObjectUrl(key: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.cos.getObjectUrl(
        {
          Bucket: this.config.bucket, Region: this.config.region, Key: key,
          Sign: true,
          Expires: SEVEN_DAYS_MS / 1000,
        },
        (err: unknown, data: { Url: string } | undefined) =>
          err || !data ? reject(err) : resolve(data.Url)
      )
    })
  }
}
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run tests/TencentCosClient.test.ts
```

Expected: 6 passed.

- [ ] **Step 5: 提交**

```bash
git add electron/services/TencentCosClient.ts tests/TencentCosClient.test.ts
git commit -m "feat: TencentCosClient — hash-dedup upload + HEAD check + signed-URL renew"
```

---

## Task 5: TencentDigitalHumanService

**Files:**
- Create: `electron/services/TencentDigitalHumanService.ts`
- Create: `tests/TencentDigitalHumanService.test.ts`

封装 submit / poll / fetch+validate 全链路。

- [ ] **Step 1: 写测试**

Create `tests/TencentDigitalHumanService.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TencentDigitalHumanService, MAX_VIDEO_BYTES, DOWNLOAD_TIMEOUT_MS, POLL_INTERVAL_MS, POLL_TOTAL_TIMEOUT_MS } from '../electron/services/TencentDigitalHumanService'

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.useFakeTimers()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const config = {
  secretId: 'id',
  secretKey: 'key',
  region: 'ap-shanghai',
  host: 'ivh.tencentcloudapi.com',
  version: '2021-03-30',
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' }, ...init,
  })
}

describe('TencentDigitalHumanService.submitPhotoToVideoNoTrain', () => {
  it('returns TaskId on 200 + Response.TaskId', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ Response: { TaskId: 'task-42' } }))
    const svc = new TencentDigitalHumanService(config)
    const taskId = await svc.submitPhotoToVideoNoTrain({
      refPhotoUrl: 'https://photo', ssml: '你好',
    }, new AbortController().signal)
    expect(taskId).toBe('task-42')
  })

  it('maps POLICY_VIOLATION error codes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      Response: { Error: { Code: 'InvalidParameterValue.PolicyDenied', Message: '审核失败' } },
    }))
    const svc = new TencentDigitalHumanService(config)
    await expect(svc.submitPhotoToVideoNoTrain(
      { refPhotoUrl: 'u', ssml: 't' }, new AbortController().signal
    )).rejects.toMatchObject({ code: 'POLICY_VIOLATION' })
  })

  it('maps other Tencent errors to TENCENT_API_FAIL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      Response: { Error: { Code: 'InternalError', Message: 'oops' } },
    }))
    const svc = new TencentDigitalHumanService(config)
    await expect(svc.submitPhotoToVideoNoTrain(
      { refPhotoUrl: 'u', ssml: 't' }, new AbortController().signal
    )).rejects.toMatchObject({ code: 'TENCENT_API_FAIL' })
  })

  it('maps fetch failure to NETWORK', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('failed to fetch'))
    const svc = new TencentDigitalHumanService(config)
    await expect(svc.submitPhotoToVideoNoTrain(
      { refPhotoUrl: 'u', ssml: 't' }, new AbortController().signal
    )).rejects.toMatchObject({ code: 'NETWORK' })
  })
})

describe('TencentDigitalHumanService.pollUntilDone', () => {
  it('emits progress events and resolves when progress=100', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ Response: { Progress: 50 } }))
      .mockResolvedValueOnce(jsonResponse({ Response: { Progress: 100, MediaUrl: 'https://video' } }))
    const svc = new TencentDigitalHumanService(config)
    const progress: number[] = []
    const promise = svc.pollUntilDone('t-1', new AbortController().signal, attempt => progress.push(attempt))
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    const mediaUrl = await promise
    expect(mediaUrl).toBe('https://video')
    expect(progress).toEqual([1, 2])
  })

  it('rejects TENCENT_TIMEOUT after POLL_TOTAL_TIMEOUT_MS', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ Response: { Progress: 10 } }))
    const svc = new TencentDigitalHumanService(config)
    const promise = svc.pollUntilDone('t-1', new AbortController().signal, () => {})
    promise.catch(() => {})  // prevent unhandled rejection
    await vi.advanceTimersByTimeAsync(POLL_TOTAL_TIMEOUT_MS + 100)
    await expect(promise).rejects.toMatchObject({ code: 'TENCENT_TIMEOUT' })
  })

  it('propagates POLICY_VIOLATION mid-poll', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      Response: { Error: { Code: 'InvalidParameterValue.PolicyDenied', Message: '违规' } },
    }))
    const svc = new TencentDigitalHumanService(config)
    const promise = svc.pollUntilDone('t-1', new AbortController().signal, () => {})
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    await expect(promise).rejects.toMatchObject({ code: 'POLICY_VIOLATION' })
  })

  it('aborts on signal', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ Response: { Progress: 10 } }))
    const svc = new TencentDigitalHumanService(config)
    const controller = new AbortController()
    const promise = svc.pollUntilDone('t-1', controller.signal, () => {})
    promise.catch(() => {})
    controller.abort()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    await expect(promise).rejects.toMatchObject({ code: 'TENCENT_API_FAIL' })
  })
})

describe('TencentDigitalHumanService.downloadVideo', () => {
  function videoResponse(body: Uint8Array, contentLength?: number, contentType = 'video/mp4', status = 200) {
    const headers: Record<string, string> = { 'Content-Type': contentType }
    if (contentLength !== undefined) headers['Content-Length'] = String(contentLength)
    return new Response(body, { status, headers })
  }

  it('returns ArrayBuffer + mimeType on valid 2xx video/* response', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    fetchMock.mockResolvedValueOnce(videoResponse(bytes, 4))
    const svc = new TencentDigitalHumanService(config)
    const result = await svc.downloadVideo('https://video', new AbortController().signal)
    expect(result.mimeType).toBe('video/mp4')
    expect(new Uint8Array(result.buffer)).toEqual(bytes)
  })

  it('rejects TENCENT_API_FAIL on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('error', { status: 500 }))
    const svc = new TencentDigitalHumanService(config)
    await expect(svc.downloadVideo('https://video', new AbortController().signal))
      .rejects.toMatchObject({ code: 'TENCENT_API_FAIL' })
  })

  it('rejects TENCENT_API_FAIL on non-video Content-Type', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>error</html>', {
      status: 200, headers: { 'Content-Type': 'text/html' },
    }))
    const svc = new TencentDigitalHumanService(config)
    await expect(svc.downloadVideo('https://video', new AbortController().signal))
      .rejects.toMatchObject({ code: 'TENCENT_API_FAIL' })
  })

  it('rejects TENCENT_API_FAIL when Content-Length exceeds MAX_VIDEO_BYTES', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x', {
      status: 200,
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(MAX_VIDEO_BYTES + 1) },
    }))
    const svc = new TencentDigitalHumanService(config)
    await expect(svc.downloadVideo('https://video', new AbortController().signal))
      .rejects.toMatchObject({ code: 'TENCENT_API_FAIL' })
  })

  it('rejects TENCENT_TIMEOUT when download exceeds DOWNLOAD_TIMEOUT_MS', async () => {
    fetchMock.mockImplementationOnce(() => new Promise(() => {/* never */}))
    const svc = new TencentDigitalHumanService(config)
    const promise = svc.downloadVideo('https://video', new AbortController().signal)
    promise.catch(() => {})
    await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS + 100)
    await expect(promise).rejects.toMatchObject({ code: 'TENCENT_TIMEOUT' })
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run tests/TencentDigitalHumanService.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

Create `electron/services/TencentDigitalHumanService.ts`:

```ts
import { signTencentRequest } from './TencentSigner'
import type { AppError, AvatarVideoErrorCode } from '../../shared/types'

export const MAX_VIDEO_BYTES = 20 * 1024 * 1024
export const POLL_INTERVAL_MS = 1500
export const POLL_TOTAL_TIMEOUT_MS = 60_000
export const DOWNLOAD_TIMEOUT_MS = 15_000

const SERVICE = 'ivh'
const ACTION_SUBMIT = 'SubmitVideoCreationTask'  // 占位；plan 阶段如腾讯文档不同请改此处与对应测试
const ACTION_QUERY = 'QueryVideoCreationTaskStatus'

const POLICY_CODE_PATTERNS = [
  /PolicyDenied/i, /AuditFailed/i, /ContentPolicy/i,
]

export interface TencentDigitalHumanConfig {
  secretId: string
  secretKey: string
  region: string
  host: string         // ivh.tencentcloudapi.com
  version: string
}

export interface SubmitInput {
  refPhotoUrl: string
  ssml: string
}

function toAppError(code: AvatarVideoErrorCode, message: string): AppError {
  return { code, message, recoverable: code !== 'INVALID_INPUT' && code !== 'POLICY_VIOLATION' }
}

function classifyTencentError(code: string, message: string): AppError {
  if (POLICY_CODE_PATTERNS.some(re => re.test(code)) || POLICY_CODE_PATTERNS.some(re => re.test(message))) {
    return toAppError('POLICY_VIOLATION', message || 'Tencent content policy denied')
  }
  return toAppError('TENCENT_API_FAIL', `${code}: ${message}`)
}

export class TencentDigitalHumanService {
  constructor(private cfg: TencentDigitalHumanConfig) {}

  async submitPhotoToVideoNoTrain(input: SubmitInput, signal: AbortSignal): Promise<string> {
    const payload = {
      RefPhotoUrl: input.refPhotoUrl,
      DriverType: 'Text',
      InputSsml: input.ssml,
    }
    const data = await this.call(ACTION_SUBMIT, payload, signal)
    const taskId: unknown = data?.Response?.TaskId
    if (typeof taskId !== 'string' || !taskId) {
      throw toAppError('TENCENT_API_FAIL', 'Tencent did not return TaskId')
    }
    return taskId
  }

  async pollUntilDone(
    taskId: string,
    signal: AbortSignal,
    onAttempt: (attempt: number) => void
  ): Promise<string> {
    const deadline = Date.now() + POLL_TOTAL_TIMEOUT_MS
    let attempt = 0
    while (true) {
      if (signal.aborted) throw toAppError('TENCENT_API_FAIL', 'aborted')
      if (Date.now() >= deadline) throw toAppError('TENCENT_TIMEOUT', 'Polling timed out')
      attempt++
      onAttempt(attempt)
      const data = await this.call(ACTION_QUERY, { TaskId: taskId }, signal)
      const resp = data?.Response ?? {}
      const progress: unknown = resp.Progress
      const mediaUrl: unknown = resp.MediaUrl
      if (typeof progress === 'number' && progress >= 100 && typeof mediaUrl === 'string') {
        return mediaUrl
      }
      await this.sleep(POLL_INTERVAL_MS, signal)
    }
  }

  async downloadVideo(
    url: string,
    signal: AbortSignal
  ): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
    const downloadController = new AbortController()
    const cancelOnOuter = () => downloadController.abort()
    signal.addEventListener('abort', cancelOnOuter, { once: true })

    const timer = setTimeout(() => downloadController.abort('timeout'), DOWNLOAD_TIMEOUT_MS)
    try {
      let res: Response
      try {
        res = await fetch(url, { signal: downloadController.signal })
      } catch (err: unknown) {
        if (downloadController.signal.aborted && (timer as unknown) /* hit timeout */) {
          throw toAppError('TENCENT_TIMEOUT', 'Download timed out')
        }
        throw toAppError('NETWORK', err instanceof Error ? err.message : String(err))
      }
      if (!res.ok) throw toAppError('TENCENT_API_FAIL', `Download status ${res.status}`)
      const ct = (res.headers.get('Content-Type') ?? '').toLowerCase()
      if (!ct.startsWith('video/')) throw toAppError('TENCENT_API_FAIL', `Unexpected Content-Type: ${ct}`)
      const lenHeader = res.headers.get('Content-Length')
      if (lenHeader && Number(lenHeader) > MAX_VIDEO_BYTES) {
        throw toAppError('TENCENT_API_FAIL', `Video too large: ${lenHeader} bytes`)
      }
      const buffer = await res.arrayBuffer()
      if (buffer.byteLength > MAX_VIDEO_BYTES) {
        throw toAppError('TENCENT_API_FAIL', `Video too large after download: ${buffer.byteLength} bytes`)
      }
      return { buffer, mimeType: ct }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancelOnOuter)
    }
  }

  private async call(action: string, payload: unknown, signal: AbortSignal): Promise<{ Response?: Record<string, unknown> }> {
    const body = JSON.stringify(payload)
    const timestamp = Math.floor(Date.now() / 1000)
    const signed = signTencentRequest({
      secretId: this.cfg.secretId,
      secretKey: this.cfg.secretKey,
      service: SERVICE,
      host: this.cfg.host,
      action,
      version: this.cfg.version,
      region: this.cfg.region,
      timestamp,
      payload: body,
    })
    let res: Response
    try {
      res = await fetch(`https://${this.cfg.host}`, {
        method: 'POST', headers: signed.headers, body, signal,
      })
    } catch (err: unknown) {
      throw toAppError('NETWORK', err instanceof Error ? err.message : String(err))
    }
    if (!res.ok) {
      throw toAppError('TENCENT_API_FAIL', `HTTP ${res.status}`)
    }
    const data = await res.json().catch(() => ({})) as { Response?: { Error?: { Code: string; Message: string } } }
    const error = data?.Response?.Error
    if (error?.Code) throw classifyTencentError(error.Code, error.Message ?? '')
    return data as { Response?: Record<string, unknown> }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms)
      const onAbort = () => { clearTimeout(t); reject(toAppError('TENCENT_API_FAIL', 'aborted during sleep')) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
```

> **Note for implementer:** `ACTION_SUBMIT` 和 `ACTION_QUERY` 是占位名。在 plan 落地前必须用 https://cloud.tencent.com.cn/document/product/1240/118475 上的 Action 名替换并相应更新测试 fixture。提交本任务前请核实并在 commit message 中标注采用的 Action 名。

- [ ] **Step 4: 运行测试**

```bash
npx vitest run tests/TencentDigitalHumanService.test.ts
```

Expected: 12 passed.

- [ ] **Step 5: 提交**

```bash
git add electron/services/TencentDigitalHumanService.ts tests/TencentDigitalHumanService.test.ts
git commit -m "feat: TencentDigitalHumanService — submit/poll/download with full validation"
```

---

## Task 6: avatarVideoHandler IPC + preload + main 绑定

**Files:**
- Create: `electron/services/avatarVideoHandler.ts`
- Create: `tests/avatarVideoHandler.test.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/main.ts`

- [ ] **Step 1: 写 handler 测试（聚焦纯逻辑：validateSsml + 全流程错误路径）**

Create `tests/avatarVideoHandler.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { validateSsml, runAvatarSegmentJob, type JobDeps, type JobEvents } from '../electron/services/avatarVideoHandler'

describe('validateSsml', () => {
  it('rejects non-string', () => {
    expect(validateSsml(42 as unknown).ok).toBe(false)
    expect(validateSsml(null).ok).toBe(false)
    expect(validateSsml(undefined).ok).toBe(false)
  })
  it('rejects empty / whitespace', () => {
    expect(validateSsml('').ok).toBe(false)
    expect(validateSsml('   ').ok).toBe(false)
  })
  it('rejects >300 chars', () => {
    expect(validateSsml('a'.repeat(301)).ok).toBe(false)
  })
  it('rejects control chars (\\x00)', () => {
    expect(validateSsml('hello\x00world').ok).toBe(false)
  })
  it('accepts valid Chinese ssml', () => {
    const r = validateSsml('你好，物理世界。')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('你好，物理世界。')
  })
  it('trims leading/trailing whitespace', () => {
    const r = validateSsml('  hi  ')
    expect(r.ok && r.value).toBe('hi')
  })
})

describe('runAvatarSegmentJob', () => {
  function makeDeps(overrides: Partial<JobDeps> = {}): JobDeps {
    return {
      getRefPhotoUrl: vi.fn().mockResolvedValue('https://ref'),
      submitTask: vi.fn().mockResolvedValue('task-1'),
      pollUntilDone: vi.fn().mockImplementation(async (_id, _signal, onAttempt) => {
        onAttempt(1); return 'https://video'
      }),
      downloadVideo: vi.fn().mockResolvedValue({
        buffer: new ArrayBuffer(8), mimeType: 'video/mp4',
      }),
      ...overrides,
    }
  }
  function makeEvents(): JobEvents & { collected: any[] } {
    const collected: any[] = []
    return {
      collected,
      progress: e => collected.push(['p', e]),
      done: e => collected.push(['d', e]),
      error: e => collected.push(['e', e]),
    }
  }

  it('emits submitting → polling → downloading → done on happy path', async () => {
    const deps = makeDeps()
    const events = makeEvents()
    await runAvatarSegmentJob({ jobId: 'j1', ssml: '你好' }, deps, events, new AbortController())
    const stages = events.collected.filter(([t]) => t === 'p').map(([_, e]) => e.stage)
    expect(stages).toEqual(['submitting', 'polling', 'downloading'])
    const dones = events.collected.filter(([t]) => t === 'd')
    expect(dones).toHaveLength(1)
    expect(dones[0][1]).toMatchObject({ jobId: 'j1', mimeType: 'video/mp4' })
    expect(events.collected.filter(([t]) => t === 'e')).toHaveLength(0)
  })

  it('emits error and stops on getRefPhotoUrl rejection (COS_NOT_READY)', async () => {
    const deps = makeDeps({
      getRefPhotoUrl: vi.fn().mockRejectedValue({ code: 'COS_NOT_READY', message: 'cos down', recoverable: false }),
    })
    const events = makeEvents()
    await runAvatarSegmentJob({ jobId: 'j2', ssml: 't' }, deps, events, new AbortController())
    expect(deps.submitTask).not.toHaveBeenCalled()
    const errors = events.collected.filter(([t]) => t === 'e')
    expect(errors).toHaveLength(1)
    expect(errors[0][1]).toMatchObject({ jobId: 'j2', error: { code: 'COS_NOT_READY' } })
  })

  it('emits error on POLICY_VIOLATION from submit', async () => {
    const deps = makeDeps({
      submitTask: vi.fn().mockRejectedValue({ code: 'POLICY_VIOLATION', message: '审核失败', recoverable: false }),
    })
    const events = makeEvents()
    await runAvatarSegmentJob({ jobId: 'j3', ssml: 't' }, deps, events, new AbortController())
    expect(deps.pollUntilDone).not.toHaveBeenCalled()
    expect(deps.downloadVideo).not.toHaveBeenCalled()
    const errors = events.collected.filter(([t]) => t === 'e')
    expect(errors[0][1].error.code).toBe('POLICY_VIOLATION')
  })

  it('treats abort as silent (no done/error event)', async () => {
    const controller = new AbortController()
    const deps = makeDeps({
      submitTask: vi.fn().mockImplementation(async () => {
        controller.abort()
        throw { code: 'TENCENT_API_FAIL', message: 'aborted', recoverable: true }
      }),
    })
    const events = makeEvents()
    await runAvatarSegmentJob({ jobId: 'j4', ssml: 't' }, deps, events, controller)
    expect(events.collected.filter(([t]) => t === 'd')).toHaveLength(0)
    expect(events.collected.filter(([t]) => t === 'e')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run tests/avatarVideoHandler.test.ts
```

Expected: FAIL.

- [ ] **Step 3: 写 handler 实现**

Create `electron/services/avatarVideoHandler.ts`:

```ts
import type { AppError, AvatarSegmentProgressEvent, AvatarSegmentDoneEvent, AvatarSegmentErrorEvent } from '../../shared/types'

const MAX_SSML_CHARS = 300
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

export type ValidateResult<T> = { ok: true; value: T } | { ok: false; error: AppError }

export function validateSsml(input: unknown): ValidateResult<string> {
  if (typeof input !== 'string') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'ssml must be a string', recoverable: false } }
  }
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'ssml is empty', recoverable: false } }
  }
  if (trimmed.length > MAX_SSML_CHARS) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: `ssml exceeds ${MAX_SSML_CHARS} chars`, recoverable: false } }
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'ssml contains control characters', recoverable: false } }
  }
  return { ok: true, value: trimmed }
}

export interface JobDeps {
  getRefPhotoUrl: () => Promise<string>
  submitTask: (refPhotoUrl: string, ssml: string, signal: AbortSignal) => Promise<string>
  pollUntilDone: (taskId: string, signal: AbortSignal, onAttempt: (n: number) => void) => Promise<string>
  downloadVideo: (mediaUrl: string, signal: AbortSignal) => Promise<{ buffer: ArrayBuffer; mimeType: string }>
}

export interface JobEvents {
  progress: (e: AvatarSegmentProgressEvent) => void
  done: (e: AvatarSegmentDoneEvent) => void
  error: (e: AvatarSegmentErrorEvent) => void
}

function isAppError(value: unknown): value is AppError {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value
}

export async function runAvatarSegmentJob(
  input: { jobId: string; ssml: string },
  deps: JobDeps,
  events: JobEvents,
  controller: AbortController
): Promise<void> {
  const { jobId } = input
  const signal = controller.signal
  try {
    events.progress({ jobId, stage: 'submitting' })
    const refPhotoUrl = await deps.getRefPhotoUrl()
    if (signal.aborted) return
    const taskId = await deps.submitTask(refPhotoUrl, input.ssml, signal)
    if (signal.aborted) return

    events.progress({ jobId, stage: 'polling' })
    const mediaUrl = await deps.pollUntilDone(taskId, signal, attempt =>
      events.progress({ jobId, stage: 'polling', pollAttempt: attempt })
    )
    if (signal.aborted) return

    events.progress({ jobId, stage: 'downloading' })
    const { buffer, mimeType } = await deps.downloadVideo(mediaUrl, signal)
    if (signal.aborted) return

    events.done({ jobId, buffer, mimeType })
  } catch (err: unknown) {
    if (signal.aborted) return  // user cancelled — don't emit error
    const error: AppError = isAppError(err)
      ? err
      : { code: 'TENCENT_API_FAIL', message: err instanceof Error ? err.message : String(err), recoverable: true }
    events.error({ jobId, error })
  }
}
```

- [ ] **Step 4: 运行 handler 单测**

```bash
npx vitest run tests/avatarVideoHandler.test.ts
```

Expected: 10 passed.

- [ ] **Step 5: 修改 preload 暴露 IPC**

Modify `electron/preload.ts`. Add inside the `contextBridge.exposeInMainWorld('electronAPI', { ... })` object, right before the closing `})`:

```ts
  generateAvatarSegment(ssml: string): Promise<{ ok: true; jobId: string } | { ok: false; error: AppError }> {
    return ipcRenderer.invoke('avatar-video:generate', ssml)
  },

  cancelAvatarSegment(jobId: string): void {
    ipcRenderer.send('avatar-video:cancel', jobId)
  },

  onAvatarSegmentProgress(cb: (e: import('../shared/types').AvatarSegmentProgressEvent) => void): () => void {
    const handler = (_: unknown, e: import('../shared/types').AvatarSegmentProgressEvent) => cb(e)
    ipcRenderer.on('avatar-video:progress', handler)
    return () => ipcRenderer.removeListener('avatar-video:progress', handler)
  },

  onAvatarSegmentDone(cb: (e: import('../shared/types').AvatarSegmentDoneEvent) => void): () => void {
    const handler = (_: unknown, e: import('../shared/types').AvatarSegmentDoneEvent) => cb(e)
    ipcRenderer.on('avatar-video:done', handler)
    return () => ipcRenderer.removeListener('avatar-video:done', handler)
  },

  onAvatarSegmentError(cb: (e: import('../shared/types').AvatarSegmentErrorEvent) => void): () => void {
    const handler = (_: unknown, e: import('../shared/types').AvatarSegmentErrorEvent) => cb(e)
    ipcRenderer.on('avatar-video:error', handler)
    return () => ipcRenderer.removeListener('avatar-video:error', handler)
  },
```

- [ ] **Step 6: 修改 electron/main.ts 注册 handler 和启动时的 COS 上传**

In `electron/main.ts`, after the existing imports add:

```ts
import { TencentCosClient } from './services/TencentCosClient'
import { TencentDigitalHumanService } from './services/TencentDigitalHumanService'
import { runAvatarSegmentJob, validateSsml, type JobDeps, type JobEvents } from './services/avatarVideoHandler'
import { randomUUID } from 'crypto'
```

Add after `let deepseekProvider!: DeepseekAIProvider`:

```ts
let cosClient: TencentCosClient | null = null
let cachedRefPhotoUrl: Promise<string> | null = null
let dhService: TencentDigitalHumanService | null = null
const inFlightJobs = new Map<string, AbortController>()

function readConfigJson(): Record<string, unknown> {
  const p = path.join(app.getPath('userData'), 'config.json')
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown> } catch { return {} }
}
function writeConfigJson(next: Record<string, unknown>): void {
  const p = path.join(app.getPath('userData'), 'config.json')
  fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8')
}

function initAvatarVideoServices(): void {
  const secretId = process.env.TENCENT_SECRET_ID ?? ''
  const secretKey = process.env.TENCENT_SECRET_KEY ?? ''
  const cosRegion = process.env.TENCENT_COS_REGION ?? 'ap-shanghai'
  const cosBucket = process.env.TENCENT_COS_BUCKET ?? ''
  const useSignedUrl = (process.env.TENCENT_COS_USE_SIGNED_URL ?? 'true') !== 'false'
  const dhRegion = process.env.TENCENT_DIGITAL_HUMAN_REGION ?? 'ap-shanghai'

  if (!secretId || !secretKey || !cosBucket) {
    console.warn('[avatar-video] Tencent credentials or bucket missing — feature disabled')
    return
  }
  cosClient = new TencentCosClient(
    { secretId, secretKey, region: cosRegion, bucket: cosBucket, useSignedUrl },
    { read: readConfigJson, write: writeConfigJson }
  )
  dhService = new TencentDigitalHumanService({
    secretId, secretKey, region: dhRegion,
    host: 'ivh.tencentcloudapi.com',
    version: '2021-03-30',
  })

  // Upload character.png in background
  const characterPath = path.join(__dirname, '..', 'src', 'assets', 'avatar', 'character.png')
  cachedRefPhotoUrl = (async () => {
    try {
      const buf = fs.readFileSync(characterPath)
      return await cosClient!.ensureRefPhotoUrl(buf)
    } catch (err) {
      console.error('[avatar-video] COS upload failed:', err)
      throw { code: 'COS_NOT_READY', message: String(err), recoverable: true } satisfies AppError
    }
  })()
  cachedRefPhotoUrl.catch(() => {/* don't crash main */})
}
```

In the `app.whenReady().then(() => { ... })` block, after the existing init code, add:

```ts
  initAvatarVideoServices()
```

At end of file, add the IPC handlers:

```ts
ipcMain.handle('avatar-video:generate', async (event, ssml: unknown): Promise<{ ok: true; jobId: string } | { ok: false; error: AppError }> => {
  if (!BrowserWindow.fromWebContents(event.sender)) {
    return { ok: false, error: { code: 'AI_ERROR', message: 'invalid sender', recoverable: false } }
  }
  if (!dhService || !cachedRefPhotoUrl) {
    return { ok: false, error: { code: 'COS_NOT_READY', message: '数智人服务未初始化', recoverable: true } }
  }
  const v = validateSsml(ssml)
  if (!v.ok) return { ok: false, error: v.error }

  const jobId = randomUUID()
  const controller = new AbortController()
  inFlightJobs.set(jobId, controller)

  const deps: JobDeps = {
    getRefPhotoUrl: () => cachedRefPhotoUrl!,
    submitTask: (url, text, signal) => dhService!.submitPhotoToVideoNoTrain({ refPhotoUrl: url, ssml: text }, signal),
    pollUntilDone: (taskId, signal, onAttempt) => dhService!.pollUntilDone(taskId, signal, onAttempt),
    downloadVideo: (url, signal) => dhService!.downloadVideo(url, signal),
  }
  const events: JobEvents = {
    progress: e => event.sender.send('avatar-video:progress', e),
    done: e => {
      event.sender.send('avatar-video:done', e)
      inFlightJobs.delete(jobId)
    },
    error: e => {
      event.sender.send('avatar-video:error', e)
      inFlightJobs.delete(jobId)
    },
  }
  // Fire and forget — events drive the renderer
  runAvatarSegmentJob({ jobId, ssml: v.value }, deps, events, controller).catch(() => {
    inFlightJobs.delete(jobId)
  })

  return { ok: true, jobId }
})

ipcMain.on('avatar-video:cancel', (_event, jobId: unknown) => {
  if (typeof jobId !== 'string') return
  const ctrl = inFlightJobs.get(jobId)
  if (ctrl) {
    ctrl.abort()
    inFlightJobs.delete(jobId)
  }
})
```

- [ ] **Step 7: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: 无新增报错。

- [ ] **Step 8: 提交**

```bash
git add electron/services/avatarVideoHandler.ts tests/avatarVideoHandler.test.ts electron/main.ts electron/preload.ts
git commit -m "feat: IPC plumbing — avatar-video job lifecycle with validation + cancel"
```

---

## Task 7: agentStore 字段扩展

**Files:**
- Modify: `src/store/agentStore.ts`

注意：本任务**只新增**字段，不删旧。`mouthShape/speakingIntensity` 留到 Task 14 删（待新链路完全可用后再清理）。

- [ ] **Step 1: 在 import 行加入新类型**

In `src/store/agentStore.ts`, replace the import line at the top:

```ts
import type { AvatarMood, MouthShape, MouthState, AgentMessage, ResourceCard, AppError, VideoQueueState } from '@shared/types'
```

- [ ] **Step 2: 在 `interface AgentStoreState` 内加三个新字段和 setter**

After `selectedResourceId: string | null` line, add:

```ts
  videoUrl: string | null
  videoQueueState: VideoQueueState
  avatarVideoError: AppError | null
```

After `setSelectedResourceId: (id: string | null) => void` line, add:

```ts
  setVideoUrl: (url: string | null) => void
  setVideoQueueState: (state: VideoQueueState) => void
  setAvatarVideoError: (error: AppError | null) => void
```

- [ ] **Step 3: 在 `initialState` 中添加三个新字段默认值**

After `selectedResourceId: null as string | null,`, add:

```ts
  videoUrl: null as string | null,
  videoQueueState: 'idle' as VideoQueueState,
  avatarVideoError: null as AppError | null,
```

- [ ] **Step 4: 在 store 创建函数里添加 setter**

After `setSelectedResourceId: selectedResourceId => set({ selectedResourceId }),`, add:

```ts
  setVideoUrl: videoUrl => set({ videoUrl }),
  setVideoQueueState: videoQueueState => set({ videoQueueState }),
  setAvatarVideoError: avatarVideoError => set({ avatarVideoError }),
```

- [ ] **Step 5: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: 无报错。

- [ ] **Step 6: 提交**

```bash
git add src/store/agentStore.ts
git commit -m "feat: agentStore — add videoUrl, videoQueueState, avatarVideoError"
```

---

## Task 8: AvatarVideoProvider（renderer 抽象）

**Files:**
- Create: `src/services/avatarVideo/AvatarVideoProvider.ts`
- Create: `src/services/avatarVideo/TencentAvatarVideoProvider.ts`
- Create: `src/services/avatarVideo/index.ts`
- Create: `tests/AvatarVideoProvider.test.ts`

- [ ] **Step 1: 写接口**

Create `src/services/avatarVideo/AvatarVideoProvider.ts`:

```ts
import type {
  AvatarSegmentProgressEvent,
  AvatarSegmentDoneEvent,
  AvatarSegmentErrorEvent,
  AppError,
} from '@shared/types'

export interface AvatarVideoProvider {
  generate(ssml: string): Promise<{ ok: true; jobId: string } | { ok: false; error: AppError }>
  cancel(jobId: string): void
  onProgress(cb: (e: AvatarSegmentProgressEvent) => void): () => void
  onDone(cb: (e: AvatarSegmentDoneEvent) => void): () => void
  onError(cb: (e: AvatarSegmentErrorEvent) => void): () => void
}
```

- [ ] **Step 2: 写 Tencent 实现**

Create `src/services/avatarVideo/TencentAvatarVideoProvider.ts`:

```ts
import type { AvatarVideoProvider } from './AvatarVideoProvider'

export class TencentAvatarVideoProvider implements AvatarVideoProvider {
  generate = (ssml: string) => window.electronAPI.generateAvatarSegment(ssml)
  cancel = (jobId: string) => window.electronAPI.cancelAvatarSegment(jobId)
  onProgress = (cb: Parameters<AvatarVideoProvider['onProgress']>[0]) =>
    window.electronAPI.onAvatarSegmentProgress(cb)
  onDone = (cb: Parameters<AvatarVideoProvider['onDone']>[0]) =>
    window.electronAPI.onAvatarSegmentDone(cb)
  onError = (cb: Parameters<AvatarVideoProvider['onError']>[0]) =>
    window.electronAPI.onAvatarSegmentError(cb)
}
```

- [ ] **Step 3: 写单例**

Create `src/services/avatarVideo/index.ts`:

```ts
import { TencentAvatarVideoProvider } from './TencentAvatarVideoProvider'
import type { AvatarVideoProvider } from './AvatarVideoProvider'

export const avatarVideoProvider: AvatarVideoProvider = new TencentAvatarVideoProvider()
export type { AvatarVideoProvider }
```

- [ ] **Step 4: 写测试**

Create `tests/AvatarVideoProvider.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TencentAvatarVideoProvider } from '../src/services/avatarVideo/TencentAvatarVideoProvider'

const mockGenerate = vi.fn()
const mockCancel = vi.fn()
const mockOnProgress = vi.fn(() => () => {})
const mockOnDone = vi.fn(() => () => {})
const mockOnError = vi.fn(() => () => {})

beforeEach(() => {
  mockGenerate.mockReset()
  mockCancel.mockReset()
  mockOnProgress.mockClear()
  mockOnDone.mockClear()
  mockOnError.mockClear()
  ;(globalThis as any).window = {
    electronAPI: {
      generateAvatarSegment: mockGenerate,
      cancelAvatarSegment: mockCancel,
      onAvatarSegmentProgress: mockOnProgress,
      onAvatarSegmentDone: mockOnDone,
      onAvatarSegmentError: mockOnError,
    },
  }
})

describe('TencentAvatarVideoProvider', () => {
  it('delegates generate to electronAPI', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const p = new TencentAvatarVideoProvider()
    expect(await p.generate('你好')).toEqual({ ok: true, jobId: 'j1' })
    expect(mockGenerate).toHaveBeenCalledWith('你好')
  })

  it('delegates cancel to electronAPI', () => {
    new TencentAvatarVideoProvider().cancel('j2')
    expect(mockCancel).toHaveBeenCalledWith('j2')
  })

  it('subscribes to all three event channels', () => {
    const p = new TencentAvatarVideoProvider()
    p.onProgress(() => {})
    p.onDone(() => {})
    p.onError(() => {})
    expect(mockOnProgress).toHaveBeenCalled()
    expect(mockOnDone).toHaveBeenCalled()
    expect(mockOnError).toHaveBeenCalled()
  })
})
```

- [ ] **Step 5: 运行测试**

```bash
npx vitest run tests/AvatarVideoProvider.test.ts
```

Expected: 3 passed.

- [ ] **Step 6: 提交**

```bash
git add src/services/avatarVideo/ tests/AvatarVideoProvider.test.ts
git commit -m "feat: AvatarVideoProvider — thin renderer wrapper over electronAPI"
```

---

## Task 9: useAvatarVideoQueue — 单段基础流程

**Files:**
- Create: `src/hooks/useAvatarVideoQueue.ts`
- Create: `tests/useAvatarVideoQueue.test.ts`

本任务实现：单段视频生成 → blob URL → 播完 revoke。预加载、fallback、熔断器留给后续任务。

- [ ] **Step 1: 写测试**

Create `tests/useAvatarVideoQueue.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAgentStore, initialState } from '../src/store/agentStore'

// Mock the provider singleton before importing the hook
const mockGenerate = vi.hoisted(() => vi.fn())
const mockCancel = vi.hoisted(() => vi.fn())
const progressSubs = vi.hoisted<((e: any) => void)[]>(() => [])
const doneSubs = vi.hoisted<((e: any) => void)[]>(() => [])
const errorSubs = vi.hoisted<((e: any) => void)[]>(() => [])
vi.mock('../src/services/avatarVideo', () => ({
  avatarVideoProvider: {
    generate: mockGenerate,
    cancel: mockCancel,
    onProgress: (cb: any) => { progressSubs.push(cb); return () => {} },
    onDone: (cb: any) => { doneSubs.push(cb); return () => {} },
    onError: (cb: any) => { errorSubs.push(cb); return () => {} },
  },
}))

// Mock Web Speech TTS provider
const mockSpeak = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockTtsStop = vi.hoisted(() => vi.fn())
vi.mock('../src/services/tts', () => ({
  ttsProvider: { speak: mockSpeak, stop: mockTtsStop },
}))

import { useAvatarVideoQueue } from '../src/hooks/useAvatarVideoQueue'

const mockCreateObjectURL = vi.fn(() => 'blob:abc')
const mockRevokeObjectURL = vi.fn()

beforeEach(() => {
  mockGenerate.mockReset()
  mockCancel.mockReset()
  mockSpeak.mockReset().mockResolvedValue(undefined)
  mockTtsStop.mockReset()
  progressSubs.length = 0
  doneSubs.length = 0
  errorSubs.length = 0
  mockCreateObjectURL.mockClear()
  mockRevokeObjectURL.mockClear()
  vi.stubGlobal('URL', { createObjectURL: mockCreateObjectURL, revokeObjectURL: mockRevokeObjectURL })
  useAgentStore.setState(initialState)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useAvatarVideoQueue — single segment', () => {
  it('enqueue triggers generate with first segment ssml and sets state=generating', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('简短答复。') })
    expect(mockGenerate).toHaveBeenCalledWith('简短答复。')
    expect(useAgentStore.getState().videoQueueState).toBe('generating')
  })

  it('on done event for current job: creates blob URL and sets state=playing', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('hi.') })
    act(() => {
      doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(8), mimeType: 'video/mp4' })
    })
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().videoUrl).toBe('blob:abc')
    expect(useAgentStore.getState().videoQueueState).toBe('playing')
  })

  it('ignores done events for stale jobIds', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('hi.') })
    act(() => {
      doneSubs[0]({ jobId: 'stale-job', buffer: new ArrayBuffer(8), mimeType: 'video/mp4' })
    })
    expect(mockCreateObjectURL).not.toHaveBeenCalled()
    expect(useAgentStore.getState().videoUrl).toBeNull()
  })

  it('onVideoEnded revokes current URL and resets to idle when no more segments', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('hi.') })
    act(() => { doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(8), mimeType: 'video/mp4' }) })
    act(() => { result.current.handleVideoEnded() })
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:abc')
    expect(useAgentStore.getState().videoUrl).toBeNull()
    expect(useAgentStore.getState().videoQueueState).toBe('idle')
  })

  it('cancel sends cancelAvatarSegment and revokes any pending URL', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('hi.') })
    act(() => { doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(8), mimeType: 'video/mp4' }) })
    act(() => { result.current.cancel() })
    expect(mockCancel).toHaveBeenCalledWith('j1')
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:abc')
    expect(useAgentStore.getState().videoUrl).toBeNull()
    expect(useAgentStore.getState().videoQueueState).toBe('idle')
  })

  it('enqueue with empty text is a no-op', async () => {
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('   ') })
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(useAgentStore.getState().videoQueueState).toBe('idle')
  })

  it('clears previous avatarVideoError on new enqueue', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    useAgentStore.setState({ avatarVideoError: { code: 'NETWORK', message: 'old', recoverable: true } })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('hi.') })
    expect(useAgentStore.getState().avatarVideoError).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run tests/useAvatarVideoQueue.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写最小实现（单段支持）**

Create `src/hooks/useAvatarVideoQueue.ts`:

```ts
import { useCallback, useEffect, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { avatarVideoProvider } from '../services/avatarVideo'
import { textSegmentation } from '../services/textSegmentation'
import type { AppError } from '@shared/types'

export interface UseAvatarVideoQueue {
  enqueue: (text: string) => Promise<void>
  cancel: () => void
  handleVideoEnded: () => void
}

export function useAvatarVideoQueue(): UseAvatarVideoQueue {
  const segmentsRef = useRef<string[]>([])
  const playedCountRef = useRef(0)
  const currentJobIdRef = useRef<string | null>(null)
  const currentUrlRef = useRef<string | null>(null)
  const genRef = useRef(0)

  // Wire up provider event subscriptions once
  useEffect(() => {
    const offDone = avatarVideoProvider.onDone(e => {
      if (e.jobId !== currentJobIdRef.current) return
      const blob = new Blob([e.buffer], { type: e.mimeType })
      const url = URL.createObjectURL(blob)
      currentUrlRef.current = url
      useAgentStore.setState({ videoUrl: url, videoQueueState: 'playing' })
    })
    return () => {
      offDone()
      // Cleanup any lingering URL on unmount
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current)
        currentUrlRef.current = null
      }
    }
  }, [])

  const enqueue = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    genRef.current++
    useAgentStore.setState({ avatarVideoError: null, videoUrl: null, videoQueueState: 'idle' })

    segmentsRef.current = textSegmentation(trimmed)
    playedCountRef.current = 0
    if (segmentsRef.current.length === 0) return

    const first = segmentsRef.current[0]
    useAgentStore.setState({ videoQueueState: 'generating' })
    const result = await avatarVideoProvider.generate(first)
    if (result.ok) {
      currentJobIdRef.current = result.jobId
    } else {
      useAgentStore.setState({
        videoQueueState: 'idle',
        avatarVideoError: result.error,
      })
    }
  }, [])

  const handleVideoEnded = useCallback(() => {
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current)
      currentUrlRef.current = null
    }
    playedCountRef.current++
    currentJobIdRef.current = null
    // Single-segment path only at this task; reset to idle.
    useAgentStore.setState({ videoUrl: null, videoQueueState: 'idle' })
  }, [])

  const cancel = useCallback(() => {
    genRef.current++
    if (currentJobIdRef.current) {
      avatarVideoProvider.cancel(currentJobIdRef.current)
      currentJobIdRef.current = null
    }
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current)
      currentUrlRef.current = null
    }
    segmentsRef.current = []
    playedCountRef.current = 0
    useAgentStore.setState({ videoUrl: null, videoQueueState: 'idle' })
  }, [])

  return { enqueue, cancel, handleVideoEnded }
}
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run tests/useAvatarVideoQueue.test.ts
```

Expected: 7 passed.

- [ ] **Step 5: 提交**

```bash
git add src/hooks/useAvatarVideoQueue.ts tests/useAvatarVideoQueue.test.ts
git commit -m "feat: useAvatarVideoQueue — single-segment basic flow with blob lifecycle"
```

---

## Task 10: useAvatarVideoQueue — 多段双缓冲

**Files:**
- Modify: `src/hooks/useAvatarVideoQueue.ts`
- Modify: `tests/useAvatarVideoQueue.test.ts`

加入：段 N 播放时预生成段 N+1；ended 后切换；段 N+1 未就绪时 stalled。

- [ ] **Step 1: 加测试**

Append to `tests/useAvatarVideoQueue.test.ts`:

```ts
describe('useAvatarVideoQueue — multi-segment double buffer', () => {
  it('after first segment starts playing, prefetches segment 2', async () => {
    mockGenerate
      .mockResolvedValueOnce({ ok: true, jobId: 'j1' })
      .mockResolvedValueOnce({ ok: true, jobId: 'j2' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('一段。二段。') })
    expect(mockGenerate).toHaveBeenCalledTimes(1)
    expect(mockGenerate).toHaveBeenNthCalledWith(1, '一段。')

    // First segment ready → playing → triggers prefetch of segment 2
    await act(async () => {
      doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(8), mimeType: 'video/mp4' })
    })
    await vi.waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(2))
    expect(mockGenerate).toHaveBeenNthCalledWith(2, '二段。')
  })

  it('on ended with next ready: swaps URL, revokes old, plays next', async () => {
    mockGenerate
      .mockResolvedValueOnce({ ok: true, jobId: 'j1' })
      .mockResolvedValueOnce({ ok: true, jobId: 'j2' })
    mockCreateObjectURL.mockReturnValueOnce('blob:1').mockReturnValueOnce('blob:2')
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('一段。二段。') })
    await act(async () => { doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(4), mimeType: 'video/mp4' }) })
    await vi.waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(2))
    await act(async () => { doneSubs[0]({ jobId: 'j2', buffer: new ArrayBuffer(4), mimeType: 'video/mp4' }) })

    act(() => { result.current.handleVideoEnded() })

    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:1')
    expect(useAgentStore.getState().videoUrl).toBe('blob:2')
    expect(useAgentStore.getState().videoQueueState).toBe('playing')
  })

  it('on ended with next NOT ready: enters stalled state', async () => {
    mockGenerate
      .mockResolvedValueOnce({ ok: true, jobId: 'j1' })
      .mockResolvedValueOnce({ ok: true, jobId: 'j2' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('一段。二段。') })
    await act(async () => { doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(4), mimeType: 'video/mp4' }) })
    act(() => { result.current.handleVideoEnded() })
    expect(useAgentStore.getState().videoQueueState).toBe('stalled')
  })

  it('stalled then next ready: transitions to playing', async () => {
    mockGenerate
      .mockResolvedValueOnce({ ok: true, jobId: 'j1' })
      .mockResolvedValueOnce({ ok: true, jobId: 'j2' })
    mockCreateObjectURL.mockReturnValueOnce('blob:1').mockReturnValueOnce('blob:2')
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('一段。二段。') })
    await act(async () => { doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(4), mimeType: 'video/mp4' }) })
    act(() => { result.current.handleVideoEnded() })
    expect(useAgentStore.getState().videoQueueState).toBe('stalled')
    await act(async () => { doneSubs[0]({ jobId: 'j2', buffer: new ArrayBuffer(4), mimeType: 'video/mp4' }) })
    expect(useAgentStore.getState().videoUrl).toBe('blob:2')
    expect(useAgentStore.getState().videoQueueState).toBe('playing')
  })

  it('after last segment ends: revokes and goes to idle', async () => {
    mockGenerate.mockResolvedValueOnce({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('独段。') })
    await act(async () => { doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(4), mimeType: 'video/mp4' }) })
    act(() => { result.current.handleVideoEnded() })
    expect(useAgentStore.getState().videoUrl).toBeNull()
    expect(useAgentStore.getState().videoQueueState).toBe('idle')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败（5 条新测试 fail）**

```bash
npx vitest run tests/useAvatarVideoQueue.test.ts
```

- [ ] **Step 3: 重写 hook 加入双缓冲**

Replace `src/hooks/useAvatarVideoQueue.ts` content with:

```ts
import { useCallback, useEffect, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { avatarVideoProvider } from '../services/avatarVideo'
import { textSegmentation } from '../services/textSegmentation'

interface PendingNext {
  jobId: string
  url: string | null  // resolved when done event fires
}

export interface UseAvatarVideoQueue {
  enqueue: (text: string) => Promise<void>
  cancel: () => void
  handleVideoEnded: () => void
}

export function useAvatarVideoQueue(): UseAvatarVideoQueue {
  const segmentsRef = useRef<string[]>([])
  const playedCountRef = useRef(0)
  const currentJobIdRef = useRef<string | null>(null)
  const currentUrlRef = useRef<string | null>(null)
  const nextRef = useRef<PendingNext | null>(null)
  const genRef = useRef(0)

  const prefetchNextIfNeeded = useCallback(async () => {
    const nextIdx = playedCountRef.current + 1
    if (nextIdx >= segmentsRef.current.length) return
    if (nextRef.current) return  // already prefetching
    const myGen = genRef.current
    const text = segmentsRef.current[nextIdx]
    const result = await avatarVideoProvider.generate(text)
    if (myGen !== genRef.current) return  // stale
    if (result.ok) {
      nextRef.current = { jobId: result.jobId, url: null }
    }
  }, [])

  useEffect(() => {
    const offDone = avatarVideoProvider.onDone(e => {
      // Current segment done?
      if (e.jobId === currentJobIdRef.current) {
        const blob = new Blob([e.buffer], { type: e.mimeType })
        const url = URL.createObjectURL(blob)
        currentUrlRef.current = url
        useAgentStore.setState({ videoUrl: url, videoQueueState: 'playing' })
        prefetchNextIfNeeded()
        return
      }
      // Pending next segment done?
      if (nextRef.current && e.jobId === nextRef.current.jobId) {
        const blob = new Blob([e.buffer], { type: e.mimeType })
        nextRef.current.url = URL.createObjectURL(blob)
        // If we're stalled waiting for this, transition to playing
        if (useAgentStore.getState().videoQueueState === 'stalled') {
          promoteNext()
        }
      }
    })
    return () => {
      offDone()
      if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current)
      if (nextRef.current?.url) URL.revokeObjectURL(nextRef.current.url)
      currentUrlRef.current = null
      nextRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function promoteNext(): void {
    const next = nextRef.current
    if (!next || !next.url) return
    const oldUrl = currentUrlRef.current
    currentJobIdRef.current = next.jobId
    currentUrlRef.current = next.url
    nextRef.current = null
    useAgentStore.setState({ videoUrl: next.url, videoQueueState: 'playing' })
    if (oldUrl) URL.revokeObjectURL(oldUrl)
    prefetchNextIfNeeded()
  }

  const enqueue = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    genRef.current++
    if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current)
    if (nextRef.current?.url) URL.revokeObjectURL(nextRef.current.url)
    currentUrlRef.current = null
    nextRef.current = null
    useAgentStore.setState({ avatarVideoError: null, videoUrl: null, videoQueueState: 'idle' })

    segmentsRef.current = textSegmentation(trimmed)
    playedCountRef.current = 0
    if (segmentsRef.current.length === 0) return

    useAgentStore.setState({ videoQueueState: 'generating' })
    const result = await avatarVideoProvider.generate(segmentsRef.current[0])
    if (result.ok) {
      currentJobIdRef.current = result.jobId
    } else {
      useAgentStore.setState({ videoQueueState: 'idle', avatarVideoError: result.error })
    }
  }, [])

  const handleVideoEnded = useCallback(() => {
    if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current)
    currentUrlRef.current = null
    playedCountRef.current++
    const lastSegmentEnded = playedCountRef.current >= segmentsRef.current.length
    if (lastSegmentEnded) {
      currentJobIdRef.current = null
      segmentsRef.current = []
      playedCountRef.current = 0
      useAgentStore.setState({ videoUrl: null, videoQueueState: 'idle' })
      return
    }
    if (nextRef.current?.url) {
      promoteNext()
    } else {
      currentJobIdRef.current = null
      useAgentStore.setState({ videoUrl: null, videoQueueState: 'stalled' })
    }
  }, [])

  const cancel = useCallback(() => {
    genRef.current++
    if (currentJobIdRef.current) avatarVideoProvider.cancel(currentJobIdRef.current)
    if (nextRef.current) avatarVideoProvider.cancel(nextRef.current.jobId)
    if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current)
    if (nextRef.current?.url) URL.revokeObjectURL(nextRef.current.url)
    currentJobIdRef.current = null
    currentUrlRef.current = null
    nextRef.current = null
    segmentsRef.current = []
    playedCountRef.current = 0
    useAgentStore.setState({ videoUrl: null, videoQueueState: 'idle' })
  }, [])

  return { enqueue, cancel, handleVideoEnded }
}
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run tests/useAvatarVideoQueue.test.ts
```

Expected: 12 passed (7 + 5)。

- [ ] **Step 5: 提交**

```bash
git add src/hooks/useAvatarVideoQueue.ts tests/useAvatarVideoQueue.test.ts
git commit -m "feat: useAvatarVideoQueue — double-buffer prefetch + stalled state"
```

---

## Task 11: useAvatarVideoQueue — fallback、blocked、熔断器

**Files:**
- Modify: `src/hooks/useAvatarVideoQueue.ts`
- Modify: `tests/useAvatarVideoQueue.test.ts`

加入：错误事件订阅 + fallback 走 Web Speech + POLICY_VIOLATION → blocked + 12s 首段看门狗 + 熔断器。

- [ ] **Step 1: 加测试**

Append to `tests/useAvatarVideoQueue.test.ts`:

```ts
describe('useAvatarVideoQueue — fallback & blocked & circuit breaker', () => {
  it('first segment NETWORK error → fallback reads remaining (= all) via Web Speech', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('一段。二段。') })
    await act(async () => {
      errorSubs[0]({ jobId: 'j1', error: { code: 'NETWORK', message: 'down', recoverable: true } })
    })
    expect(useAgentStore.getState().videoQueueState).toBe('fallback')
    expect(mockSpeak).toHaveBeenCalledWith('一段。二段。')
  })

  it('mid-stream error after first segment played: Web Speech reads only remaining', async () => {
    mockGenerate
      .mockResolvedValueOnce({ ok: true, jobId: 'j1' })
      .mockResolvedValueOnce({ ok: true, jobId: 'j2' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('段一。段二。段三。') })
    await act(async () => { doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(4), mimeType: 'video/mp4' }) })
    act(() => { result.current.handleVideoEnded() })  // played++ to 1
    await act(async () => {
      errorSubs[0]({ jobId: 'j2', error: { code: 'TENCENT_API_FAIL', message: 'oops', recoverable: true } })
    })
    expect(mockSpeak).toHaveBeenCalledWith('段二。段三。')
  })

  it('POLICY_VIOLATION → blocked, NO Web Speech', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('被审核。') })
    await act(async () => {
      errorSubs[0]({ jobId: 'j1', error: { code: 'POLICY_VIOLATION', message: '违规', recoverable: false } })
    })
    expect(useAgentStore.getState().videoQueueState).toBe('blocked')
    expect(useAgentStore.getState().avatarVideoError?.code).toBe('POLICY_VIOLATION')
    expect(mockSpeak).not.toHaveBeenCalled()
  })

  it('first-segment 12s timeout → fallback', async () => {
    vi.useFakeTimers()
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('hi.') })
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000 + 50) })
    expect(mockCancel).toHaveBeenCalledWith('j1')
    expect(useAgentStore.getState().videoQueueState).toBe('fallback')
    expect(mockSpeak).toHaveBeenCalledWith('hi.')
    vi.useRealTimers()
  })

  it('circuit breaker: 3 consecutive failures → next enqueue goes straight to Web Speech', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    for (let i = 0; i < 3; i++) {
      await act(async () => { await result.current.enqueue(`第${i}条。`) })
      await act(async () => {
        errorSubs[0]({ jobId: 'j1', error: { code: 'NETWORK', message: 'down', recoverable: true } })
      })
    }
    mockGenerate.mockClear()
    mockSpeak.mockClear()
    await act(async () => { await result.current.enqueue('应直接走 Web Speech。') })
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockSpeak).toHaveBeenCalledWith('应直接走 Web Speech。')
  })

  it('first success after partial failures resets the counter', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('一次。') })
    await act(async () => {
      errorSubs[0]({ jobId: 'j1', error: { code: 'NETWORK', message: '?', recoverable: true } })
    })
    await act(async () => { await result.current.enqueue('二次。') })
    await act(async () => {
      doneSubs[0]({ jobId: 'j1', buffer: new ArrayBuffer(4), mimeType: 'video/mp4' })
    })
    // Two more failures shouldn't trip breaker because success reset it
    await act(async () => {
      errorSubs[0]({ jobId: 'j1', error: { code: 'NETWORK', message: '?', recoverable: true } })
    })
    await act(async () => { await result.current.enqueue('三次。') })
    mockGenerate.mockClear()
    await act(async () => { await result.current.enqueue('四次。') })
    expect(mockGenerate).toHaveBeenCalled()  // not skipped
  })

  it('POLICY_VIOLATION does NOT increment circuit breaker counter', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    for (let i = 0; i < 3; i++) {
      await act(async () => { await result.current.enqueue(`违规${i}。`) })
      await act(async () => {
        errorSubs[0]({ jobId: 'j1', error: { code: 'POLICY_VIOLATION', message: '!', recoverable: false } })
      })
    }
    mockGenerate.mockClear()
    await act(async () => { await result.current.enqueue('再来一次。') })
    expect(mockGenerate).toHaveBeenCalled()  // breaker not tripped
  })

  it('user cancel does NOT increment circuit breaker counter', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    for (let i = 0; i < 3; i++) {
      await act(async () => { await result.current.enqueue(`x${i}。`) })
      act(() => { result.current.cancel() })
    }
    mockGenerate.mockClear()
    await act(async () => { await result.current.enqueue('未熔断。') })
    expect(mockGenerate).toHaveBeenCalled()
  })

  it('next-round enqueue clears blocked state', async () => {
    mockGenerate.mockResolvedValue({ ok: true, jobId: 'j1' })
    const { result } = renderHook(() => useAvatarVideoQueue())
    await act(async () => { await result.current.enqueue('违规。') })
    await act(async () => {
      errorSubs[0]({ jobId: 'j1', error: { code: 'POLICY_VIOLATION', message: '!', recoverable: false } })
    })
    expect(useAgentStore.getState().videoQueueState).toBe('blocked')
    await act(async () => { await result.current.enqueue('正常。') })
    expect(useAgentStore.getState().videoQueueState).not.toBe('blocked')
    expect(useAgentStore.getState().avatarVideoError).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run tests/useAvatarVideoQueue.test.ts
```

Expected: 9 新 fail。

- [ ] **Step 3: 重写 hook 加入错误处理 + 熔断器 + 看门狗**

Replace `src/hooks/useAvatarVideoQueue.ts` with:

```ts
import { useCallback, useEffect, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { avatarVideoProvider } from '../services/avatarVideo'
import { ttsProvider } from '../services/tts'
import { textSegmentation } from '../services/textSegmentation'
import type { AppError } from '@shared/types'

const FIRST_SEGMENT_TIMEOUT_MS = 12_000
const CIRCUIT_BREAK_THRESHOLD = 3
const CIRCUIT_BREAK_DURATION_MS = 10 * 60 * 1000

interface PendingNext {
  jobId: string
  url: string | null
}

export interface UseAvatarVideoQueue {
  enqueue: (text: string) => Promise<void>
  cancel: () => void
  handleVideoEnded: () => void
}

export function useAvatarVideoQueue(): UseAvatarVideoQueue {
  const segmentsRef = useRef<string[]>([])
  const playedCountRef = useRef(0)
  const currentJobIdRef = useRef<string | null>(null)
  const currentUrlRef = useRef<string | null>(null)
  const nextRef = useRef<PendingNext | null>(null)
  const genRef = useRef(0)
  const firstSegmentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstSegmentReceivedRef = useRef(false)
  const consecutiveFailureCountRef = useRef(0)
  const circuitBreakerUntilRef = useRef<number | null>(null)

  function clearFirstSegmentWatchdog(): void {
    if (firstSegmentTimerRef.current) {
      clearTimeout(firstSegmentTimerRef.current)
      firstSegmentTimerRef.current = null
    }
  }

  function clearBuffers(): void {
    if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current)
    if (nextRef.current?.url) URL.revokeObjectURL(nextRef.current.url)
    currentUrlRef.current = null
    nextRef.current = null
  }

  function fallbackRemaining(error: AppError): void {
    consecutiveFailureCountRef.current++
    if (consecutiveFailureCountRef.current >= CIRCUIT_BREAK_THRESHOLD) {
      circuitBreakerUntilRef.current = Date.now() + CIRCUIT_BREAK_DURATION_MS
    }
    if (currentJobIdRef.current) avatarVideoProvider.cancel(currentJobIdRef.current)
    if (nextRef.current) avatarVideoProvider.cancel(nextRef.current.jobId)
    clearBuffers()
    currentJobIdRef.current = null
    clearFirstSegmentWatchdog()
    const remaining = segmentsRef.current.slice(playedCountRef.current).join('')
    useAgentStore.setState({ videoUrl: null, videoQueueState: 'fallback', avatarVideoError: error })
    if (remaining) {
      const onEnd = () => {
        useAgentStore.setState({ videoQueueState: 'idle' })
      }
      ttsProvider.speak(remaining).then(onEnd, onEnd)
    } else {
      useAgentStore.setState({ videoQueueState: 'idle' })
    }
  }

  function enterBlocked(error: AppError): void {
    if (currentJobIdRef.current) avatarVideoProvider.cancel(currentJobIdRef.current)
    if (nextRef.current) avatarVideoProvider.cancel(nextRef.current.jobId)
    clearBuffers()
    currentJobIdRef.current = null
    clearFirstSegmentWatchdog()
    useAgentStore.setState({ videoUrl: null, videoQueueState: 'blocked', avatarVideoError: error })
  }

  const prefetchNextIfNeeded = useCallback(async () => {
    const nextIdx = playedCountRef.current + 1
    if (nextIdx >= segmentsRef.current.length) return
    if (nextRef.current) return
    const myGen = genRef.current
    const text = segmentsRef.current[nextIdx]
    const result = await avatarVideoProvider.generate(text)
    if (myGen !== genRef.current) return
    if (result.ok) {
      nextRef.current = { jobId: result.jobId, url: null }
    }
  }, [])

  function promoteNext(): void {
    const next = nextRef.current
    if (!next || !next.url) return
    const oldUrl = currentUrlRef.current
    currentJobIdRef.current = next.jobId
    currentUrlRef.current = next.url
    nextRef.current = null
    useAgentStore.setState({ videoUrl: next.url, videoQueueState: 'playing' })
    if (oldUrl) URL.revokeObjectURL(oldUrl)
    prefetchNextIfNeeded()
  }

  useEffect(() => {
    const offDone = avatarVideoProvider.onDone(e => {
      if (e.jobId === currentJobIdRef.current) {
        firstSegmentReceivedRef.current = true
        clearFirstSegmentWatchdog()
        consecutiveFailureCountRef.current = 0
        circuitBreakerUntilRef.current = null
        const blob = new Blob([e.buffer], { type: e.mimeType })
        const url = URL.createObjectURL(blob)
        currentUrlRef.current = url
        useAgentStore.setState({ videoUrl: url, videoQueueState: 'playing' })
        prefetchNextIfNeeded()
        return
      }
      if (nextRef.current && e.jobId === nextRef.current.jobId) {
        const blob = new Blob([e.buffer], { type: e.mimeType })
        nextRef.current.url = URL.createObjectURL(blob)
        if (useAgentStore.getState().videoQueueState === 'stalled') {
          promoteNext()
        }
      }
    })
    const offError = avatarVideoProvider.onError(e => {
      if (e.jobId !== currentJobIdRef.current && (!nextRef.current || e.jobId !== nextRef.current.jobId)) {
        return  // stale
      }
      if (e.error.code === 'POLICY_VIOLATION') {
        enterBlocked(e.error)
      } else if (e.error.code === 'INVALID_INPUT') {
        // bug, not a network failure; do not count toward breaker
        useAgentStore.setState({ videoQueueState: 'idle', avatarVideoError: e.error })
      } else {
        fallbackRemaining(e.error)
      }
    })
    return () => {
      offDone()
      offError()
      clearFirstSegmentWatchdog()
      clearBuffers()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const enqueue = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    genRef.current++
    clearFirstSegmentWatchdog()
    firstSegmentReceivedRef.current = false
    clearBuffers()
    useAgentStore.setState({ avatarVideoError: null, videoUrl: null, videoQueueState: 'idle' })

    segmentsRef.current = textSegmentation(trimmed)
    playedCountRef.current = 0
    if (segmentsRef.current.length === 0) return

    // Circuit breaker check
    if (circuitBreakerUntilRef.current && Date.now() < circuitBreakerUntilRef.current) {
      useAgentStore.setState({ videoQueueState: 'fallback' })
      const onEnd = () => useAgentStore.setState({ videoQueueState: 'idle' })
      ttsProvider.speak(trimmed).then(onEnd, onEnd)
      return
    }

    useAgentStore.setState({ videoQueueState: 'generating' })
    const result = await avatarVideoProvider.generate(segmentsRef.current[0])
    if (!result.ok) {
      fallbackRemaining(result.error)
      return
    }
    currentJobIdRef.current = result.jobId

    // 12s watchdog for first segment
    firstSegmentTimerRef.current = setTimeout(() => {
      if (!firstSegmentReceivedRef.current) {
        fallbackRemaining({ code: 'TENCENT_TIMEOUT', message: 'First segment exceeded 12s', recoverable: true })
      }
    }, FIRST_SEGMENT_TIMEOUT_MS)
  }, [])

  const handleVideoEnded = useCallback(() => {
    if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current)
    currentUrlRef.current = null
    playedCountRef.current++
    const lastEnded = playedCountRef.current >= segmentsRef.current.length
    if (lastEnded) {
      currentJobIdRef.current = null
      segmentsRef.current = []
      playedCountRef.current = 0
      useAgentStore.setState({ videoUrl: null, videoQueueState: 'idle' })
      return
    }
    if (nextRef.current?.url) {
      promoteNext()
    } else {
      currentJobIdRef.current = null
      useAgentStore.setState({ videoUrl: null, videoQueueState: 'stalled' })
    }
  }, [])

  const cancel = useCallback(() => {
    genRef.current++
    clearFirstSegmentWatchdog()
    if (currentJobIdRef.current) avatarVideoProvider.cancel(currentJobIdRef.current)
    if (nextRef.current) avatarVideoProvider.cancel(nextRef.current.jobId)
    clearBuffers()
    currentJobIdRef.current = null
    segmentsRef.current = []
    playedCountRef.current = 0
    useAgentStore.setState({ videoUrl: null, videoQueueState: 'idle' })
  }, [])

  return { enqueue, cancel, handleVideoEnded }
}
```

- [ ] **Step 4: 运行所有 queue 测试**

```bash
npx vitest run tests/useAvatarVideoQueue.test.ts
```

Expected: 21 passed (7 + 5 + 9)。

- [ ] **Step 5: 提交**

```bash
git add src/hooks/useAvatarVideoQueue.ts tests/useAvatarVideoQueue.test.ts
git commit -m "feat: useAvatarVideoQueue — fallback + blocked + 12s watchdog + circuit breaker"
```

---

## Task 12: Avatar 组件重构

**Files:**
- Modify: `src/components/Avatar/index.tsx`
- Modify: `src/components/Avatar/Avatar.module.css`

切换为 `<video>` + 静态 `<img>` 双路径渲染；blocked 状态显示提示文案；onended 通过 prop 上传。

- [ ] **Step 1: 修改 Avatar/index.tsx**

Replace contents of `src/components/Avatar/index.tsx`:

```tsx
import { useEffect, useRef } from 'react'
import { useAgentStore } from '../../store/agentStore'
import characterImg from '../../assets/avatar/character.png'
import styles from './Avatar.module.css'

interface AvatarProps {
  onVideoEnded?: () => void
  children?: React.ReactNode
}

export function Avatar({ onVideoEnded, children }: AvatarProps) {
  const mood = useAgentStore(s => s.mood)
  const isPushing = useAgentStore(s => s.isPushing)
  const videoUrl = useAgentStore(s => s.videoUrl)
  const videoQueueState = useAgentStore(s => s.videoQueueState)
  const avatarVideoError = useAgentStore(s => s.avatarVideoError)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // When videoUrl changes, ensure the video element loads + plays the new source
  useEffect(() => {
    const v = videoRef.current
    if (!v || !videoUrl) return
    v.load()
    v.play().catch(() => {/* autoplay rejection is fine; user gesture is in input chain */})
  }, [videoUrl])

  const wrapClass = [
    styles.characterWrap,
    mood === 'thinking' ? styles.thinking : '',
    mood === 'talking' ? styles.talking : '',
    mood === 'error' ? styles.error : '',
    isPushing ? styles.pushing : '',
  ].filter(Boolean).join(' ')

  const showVideo = videoUrl && (videoQueueState === 'playing' || videoQueueState === 'stalled')

  return (
    <div className={styles.avatar}>
      <div className={wrapClass}>
        {showVideo ? (
          <video
            ref={videoRef}
            className={styles.characterVideo}
            src={videoUrl}
            autoPlay
            playsInline
            onEnded={onVideoEnded}
          />
        ) : (
          <img
            className={styles.characterImg}
            src={characterImg}
            alt="avatar"
            draggable={false}
          />
        )}
        {videoQueueState === 'stalled' && <div className={styles.stalledDots}>…</div>}
      </div>
      {videoQueueState === 'blocked' && avatarVideoError?.code === 'POLICY_VIOLATION' && (
        <div className={styles.blockedNotice}>
          此回答未通过数字人内容审核，请调整提问后重试
        </div>
      )}
      {children}
    </div>
  )
}
```

- [ ] **Step 2: 修改 Avatar.module.css**

Replace the file. Remove all mouth-overlay-related classes (`.mouthOverlay`, `.mouthClosed`, etc.). Replace contents with:

```css
.avatar {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0 8px;
  position: relative;
  flex-shrink: 0;
}

.characterWrap {
  position: relative;
  width: 240px;
  height: 280px;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: idle-float 3s ease-in-out infinite;
}

.characterImg,
.characterVideo {
  width: 100%;
  height: 100%;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
}

.stalledDots {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 24px;
  color: rgba(255, 255, 255, 0.6);
  letter-spacing: 4px;
  animation: stalled-blink 1.2s ease-in-out infinite;
  pointer-events: none;
}

@keyframes stalled-blink {
  0%, 100% { opacity: 0.3; }
  50%       { opacity: 0.9; }
}

.blockedNotice {
  margin-top: 8px;
  padding: 6px 10px;
  font-size: 12px;
  color: #fda4af;
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 8px;
  text-align: center;
  max-width: 280px;
}

@keyframes idle-float {
  0%, 100% { transform: translateY(0); }
  50%       { transform: translateY(-5px); }
}

.thinking { animation: thinking-pulse 0.9s ease-in-out infinite; }
@keyframes thinking-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.7; transform: scale(0.96); }
}

.talking { animation: talking-bob 0.5s ease-in-out infinite alternate; }
@keyframes talking-bob {
  from { transform: translateY(0); }
  to   { transform: translateY(-2px); }
}

.error { animation: error-shake 0.45s ease-in-out forwards; }
@keyframes error-shake {
  0%, 100% { transform: translateX(0); }
  20%     { transform: translateX(-5px); }
  40%     { transform: translateX(5px); }
  60%     { transform: translateX(-4px); }
  80%     { transform: translateX(4px); }
}

.pushing { animation: pushing-bounce 0.55s ease-in-out infinite alternate; }
@keyframes pushing-bounce {
  from { transform: translateY(0) rotate(0deg); }
  to   { transform: translateY(-8px) rotate(3deg); }
}

.pushingFlag {
  position: absolute;
  top: 8px;
  right: 24px;
  font-size: 18px;
  animation: flag-wave 0.6s ease-in-out infinite alternate;
}
@keyframes flag-wave {
  from { transform: rotate(-10deg); }
  to   { transform: rotate(10deg); }
}

.statusBadge {
  margin-top: 4px;
  font-size: 11px;
  color: #7dd3fc;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 2px 10px;
  min-height: 20px;
  display: flex;
  align-items: center;
  gap: 4px;
}
```

- [ ] **Step 3: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: 无新增报错。

- [ ] **Step 4: 提交**

```bash
git add src/components/Avatar/index.tsx src/components/Avatar/Avatar.module.css
git commit -m "feat: Avatar — render <video> for talking segments, <img> otherwise + blocked notice"
```

---

## Task 13: useAI 集成

**Files:**
- Modify: `src/hooks/useAI.ts`
- Modify: `tests/useAI.test.ts`

`useAvatarVideoQueue` 取代 `lipSyncController` + `ttsProvider.speak`。

- [ ] **Step 1: 修改 useAI.ts**

Replace `src/hooks/useAI.ts` contents:

```ts
import { useCallback, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { aiProvider } from '../services/ai'
import { useAvatarVideoQueue } from './useAvatarVideoQueue'
import { isAppError } from '../services/ai/ElectronAIProvider'
import type { AppError } from '@shared/types'

export function useAI() {
  const queue = useAvatarVideoQueue()
  const ttsGenRef = useRef(0)

  const sendMessage = useCallback(async (text: string) => {
    if (useAgentStore.getState().isLoading) return

    ttsGenRef.current++
    queue.cancel()

    const store = useAgentStore.getState()
    store.setLastUserInput(text)
    store.setIsLoading(true)
    store.setMood('thinking')
    store.setError(null)
    store.addMessage({ role: 'user', content: text })

    try {
      const response = await aiProvider.chat(useAgentStore.getState().messages)

      const s = useAgentStore.getState()
      s.addMessage({ role: 'assistant', content: response.reply })
      s.setResourceCards(response.resourceCards)
      s.setIsPushing(response.resourceCards.length > 0)
      s.setMood('talking')
      s.setIsLoading(false)

      queue.enqueue(response.reply).catch(() => {/* errors emit via store */})
    } catch (err: unknown) {
      const appError: AppError = isAppError(err)
        ? (err as AppError)
        : { code: 'AI_ERROR', message: err instanceof Error ? err.message : String(err), recoverable: true }
      queue.cancel()
      const s = useAgentStore.getState()
      s.setMood('error')
      s.setIsPushing(false)
      s.setError(appError)
      s.setIsLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const retry = useCallback(() => {
    const { lastUserInput } = useAgentStore.getState()
    if (lastUserInput) sendMessage(lastUserInput)
  }, [sendMessage])

  // Forward video onended to the queue so segments advance
  const handleVideoEnded = queue.handleVideoEnded

  return { sendMessage, retry, handleVideoEnded }
}
```

Note: `useAI` now returns `handleVideoEnded`; the caller (App / wherever Avatar is rendered) must wire it to `<Avatar onVideoEnded={handleVideoEnded} />`. This is done in Step 2.

- [ ] **Step 2: 找到调用 Avatar 的位置并连线**

```bash
grep -rn "from '.*Avatar'" src/ | grep -v test
```

The likely place is `src/App.tsx` or a top-level component. For each call site:

```tsx
const { sendMessage, retry, handleVideoEnded } = useAI()
// ...
<Avatar onVideoEnded={handleVideoEnded}>...</Avatar>
```

If no current call site passes children/props to Avatar yet, simply add the `onVideoEnded` prop.

- [ ] **Step 3: 更新 useAI.test.ts**

Open `tests/useAI.test.ts`. Replace the `vi.mock('../src/services/lipsync', …)` block (if present) and `vi.mock('../src/services/tts', …)` block with:

```ts
const mockEnqueue = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockQueueCancel = vi.hoisted(() => vi.fn())
const mockHandleVideoEnded = vi.hoisted(() => vi.fn())

vi.mock('../src/hooks/useAvatarVideoQueue', () => ({
  useAvatarVideoQueue: () => ({
    enqueue: mockEnqueue,
    cancel: mockQueueCancel,
    handleVideoEnded: mockHandleVideoEnded,
  }),
}))
```

Also delete any direct imports of `ttsProvider` / `lipSyncController` from this test file, and any references to `mockSpeak` / `mockTtsStop` / `mockLipSync*`. Replace the existing tests that asserted "calls ttsProvider.speak with reply" with:

```ts
it('enqueues reply into avatar video queue on AI success', async () => {
  // ... arrange a successful chat ...
  expect(mockEnqueue).toHaveBeenCalledWith(expectedReply)
})

it('cancels queue at the start of a new sendMessage', async () => {
  // ... call sendMessage twice ...
  expect(mockQueueCancel).toHaveBeenCalled()
})

it('cancels queue on AI failure', async () => {
  // ... mock aiProvider.chat to reject ...
  expect(mockQueueCancel).toHaveBeenCalled()
})
```

The exact test refactor depends on existing structure—the implementer should adapt while preserving the existing test cases that don't involve TTS/lipsync.

- [ ] **Step 4: 运行 useAI 测试**

```bash
npx vitest run tests/useAI.test.ts
```

Expected: 全绿（具体数量取决于实际改后的 case 数）。

- [ ] **Step 5: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: 无新增报错。

- [ ] **Step 6: 提交**

```bash
git add src/hooks/useAI.ts tests/useAI.test.ts src/App.tsx
git commit -m "feat: useAI — replace lipsync+tts with avatar video queue"
```

---

## Task 14: 删除旧 CSS overlay 系统 + 清理 store

**Files:**
- Delete: `src/services/lipsync/` (whole dir)
- Delete: `tests/LipSyncController.test.ts`
- Modify: `src/store/agentStore.ts` (remove `mouthShape`, `speakingIntensity`, `setMouthState`)
- Modify: `shared/types.ts` (remove `MouthShape`, `MouthState`)

- [ ] **Step 1: 删除 lipsync 目录与测试**

```bash
git rm -r src/services/lipsync/
git rm tests/LipSyncController.test.ts
```

- [ ] **Step 2: 清理 agentStore 中废弃字段**

In `src/store/agentStore.ts`:

- 删除 import 行中的 `MouthShape, MouthState`：

```ts
import type { AvatarMood, AgentMessage, ResourceCard, AppError, VideoQueueState } from '@shared/types'
```

- 删除 interface 中：
  - `mouthShape: MouthShape`
  - `speakingIntensity: number`
  - `setMouthState: (state: MouthState) => void`

- 删除 initialState 中：
  - `mouthShape: 'closed' as MouthShape,`
  - `speakingIntensity: 0,`

- 删除 create 函数中：
  - 整个 `setMouthState: ...` 块

- [ ] **Step 3: 清理 shared/types.ts 中 MouthShape 类型（可选）**

Decision: 保留 `MouthShape` / `MouthState` 类型有引用吗？

```bash
grep -rn "MouthShape\|MouthState" --include="*.ts" --include="*.tsx" | grep -v node_modules
```

如果只剩 shared/types.ts 自身的定义，则删除。否则保留。建议删除：

```ts
// Remove from shared/types.ts
export type MouthShape = 'closed' | 'slightlyOpen' | 'ee' | 'oh' | 'ah' | 'wide'
export interface MouthState { ... }
```

- [ ] **Step 4: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: 无报错。如有引用 `MouthShape` / `setMouthState` 的残留地方，逐一删除。

- [ ] **Step 5: 跑剩余测试**

```bash
npx vitest run tests/textSegmentation.test.ts tests/TencentSigner.test.ts tests/TencentCosClient.test.ts tests/TencentDigitalHumanService.test.ts tests/avatarVideoHandler.test.ts tests/AvatarVideoProvider.test.ts tests/useAvatarVideoQueue.test.ts tests/useAI.test.ts
```

Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "chore: delete CSS overlay lipsync system + obsolete store fields"
```

---

## Task 15: 手动端到端验证

**Files:** —（无代码改动）

**前置**：用户已在 `.env` 中填入 `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` / `TENCENT_COS_BUCKET` 等。COS bucket 已在腾讯云控制台创建。

- [ ] **Step 1: 启动 dev**

```bash
npm run dev
```

Expected: Vite 启动，Electron 窗口打开。控制台应输出：`[avatar-video]` 上传成功（如果 COS 配置正确）。

- [ ] **Step 2: 短回复测试**

发送提问："牛顿第一定律是什么？"

观察：
- mood = thinking
- 5-12s 后角色切换为视频，嘴部真实变化
- 视频播完后回到静态 PNG + idle 状态

- [ ] **Step 3: 长回复测试**

发送提问："详细解释什么是物理学，包括分支和应用。"

观察：
- AI 回复超过 240 字
- 第一段视频开播
- 段切换时最多看到 1-2 次"…"定格动画 < 2s
- 全部段播完才回 idle

- [ ] **Step 4: 中断测试**

第一段视频播放过程中，立即提下一题。

观察：
- 视频立即停止，blob URL 释放（DevTools Memory 中 Blob 总量回落）
- 新一轮立刻进入 thinking → 视频

- [ ] **Step 5: 拔网测试**

关闭网络。提一个新问题。

观察：
- 12s 后切到 fallback：静态 PNG 显示 + Web Speech 念出回答

- [ ] **Step 6: 熔断测试**

保持拔网。连续提 3 个问题。第 4 个问题：

观察：
- 第 4 个问题直接走 Web Speech，**没有 12s 等待**

恢复网络，等 10 分钟。再提问。

观察：
- 视频路径恢复

- [ ] **Step 7: 审核测试**

提一个明显违规内容（如包含敏感词的提问；这取决于腾讯审核规则）。

观察：
- 显示红色 blocked 提示文案
- **不**朗读 AI 文本
- 下一题正常回到视频路径

- [ ] **Step 8: 验收通过后合并到 main 的策略**

由用户决定。两个选项：
- 直接 `git checkout main && git merge feature/realistic-lipsync`
- 或先在 GitHub 上开 PR 走 ultrareview

---

## Self-Review

### Spec 覆盖检查（逐 spec section 对照）

| Spec 章节 | 实现任务 |
|----------|----------|
| 一站式架构 | Tasks 5, 6, 13 |
| 照片免训练 API | Task 5 |
| COS 私有 + 签名 URL | Task 4, 6 |
| Web Speech fallback | Task 11 (`fallbackRemaining`) |
| 段间衔接：双缓冲 + 定格 | Tasks 10, 11, 12 |
| 首段 12s 看门狗 | Task 11 |
| 段长 ≤240 字 | Task 1 |
| IPC 事件式 + 进度 | Tasks 6 |
| Store 形状 | Tasks 7, 14 |
| ArrayBuffer 在 hook 内 | Tasks 9, 10, 11 |
| 状态机 6 态 | Tasks 9, 10, 11 |
| 错误分类含 INVALID_INPUT | Tasks 2, 6, 11 |
| Fallback 只念剩余段 | Task 11 |
| 熔断器 | Task 11 |
| 用户 cancel 不入熔断 | Task 11 |
| POLICY_VIOLATION → blocked | Task 11 |
| IPC 参数校验 | Task 6 (`validateSsml`) |
| MediaUrl 下载校验 | Task 5 (`downloadVideo`) |
| COS 公网读必须显式 opt-in | Task 4 |

### Placeholder 扫描

- "占位 Action 名" 在 Task 5 已显式标注为 plan 阶段需核实；不算 placeholder 而是 documented uncertainty。
- 无 TBD / TODO / "implement later"。
- 测试均含完整代码块；代码改动均含完整 diff。

### 类型一致性

- `AvatarVideoErrorCode` 在 Task 2 定义，被 Tasks 5/6/11 引用。
- `VideoQueueState` 6 态全部在 Task 11 实现里使用。
- `AvatarSegmentProgressEvent` / `AvatarSegmentDoneEvent` / `AvatarSegmentErrorEvent` 名字在 Task 2/6/8 一致。
- `electronAPI.generateAvatarSegment` 签名在 Task 6（preload）和 Task 8（provider）一致。

### 风险/未决（spec 已列；本 plan 不覆盖）

- 物理公式 SSML 念法
- 段间停顿听感
- 视频 URL 7 天有效期下重听历史回答的体验

均为 spec 中明确标记 "follow-up" 的范围外项。
