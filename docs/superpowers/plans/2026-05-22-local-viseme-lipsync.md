# 本地 viseme + PNG 嘴型动画 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用纯本地的 viseme + 透明 PNG 嘴型动画替换跑不通的腾讯数智人云端视频，让头像在 TTS 讲话时嘴形持续开合、讲完即闭口。

**Architecture:** AI 回复到达后，`useAI` 立即 `lipSyncController.start(reply, setCurrentViseme)` 并行调用 `ttsProvider.speak()`。`LipSyncController` 用 `textToVisemes()`（中文→拼音→韵母）算出 viseme 序列，按固定 180ms 间隔步进、序列走完循环重播，每帧写入 store `currentViseme`。`Avatar` 底图 `character.png` 不变，只在嘴部叠加一张随 `currentViseme` 切换的透明 PNG。`speak()` 的 resolve/reject 是唯一收尾信号，触发 `lipSyncController.stop()`（强制闭口）。

**Tech Stack:** React 18, TypeScript 5.5（strict + noUnusedLocals）, Zustand 4, CSS Modules, Vitest 1.6（happy-dom）, Electron 28, pinyin-pro

**对应 spec:** `docs/superpowers/specs/2026-05-22-local-viseme-lipsync-design.md`

---

## 执行约定

- **执行位置：** 所有任务在 worktree `.worktrees/feature-local-viseme-lipsync`、分支 `feature/local-viseme-lipsync` 内执行。开工前确认：

  ```bash
  git branch --show-current      # 期望: feature/local-viseme-lipsync
  git rev-parse --show-toplevel  # 期望路径结尾: .worktrees/feature-local-viseme-lipsync
  ```

- **测试命令：** 本项目 vitest 在默认 threads pool 下偶发 libuv 崩溃（`Assertion failed: errno == EINTR`）。**所有测试统一加 `--pool=forks --poolOptions.forks.singleFork=true`**：
  - 全量：`npm test -- --pool=forks --poolOptions.forks.singleFork=true`
  - 单文件：`npx vitest run <file> --pool=forks --poolOptions.forks.singleFork=true`
- **类型检查：** `npx tsc --noEmit` 覆盖 `src` / `shared` / `electron` / `tests`（见 `tsconfig.json` 的 `include`）。
- 每个任务结束都必须 `npx tsc --noEmit` + 相关测试通过后再 commit。提交信息沿用仓库风格（`feat:` / `refactor:` / `chore:` / `test:`）。

---

## File Map

| 文件 | 操作 | 职责 |
|------|------|------|
| `package.json` | 修改 | +`pinyin-pro`，−`cos-nodejs-sdk-v5` |
| `shared/types.ts` | 修改 | +`Viseme`；−腾讯视频生命周期类型 |
| `src/services/lipsync/viseme.ts` | 新增 | `textToVisemes` 纯函数 |
| `src/services/lipsync/LipSyncController.ts` | 新增 | 定时步进控制器 |
| `src/services/lipsync/index.ts` | 新增 | 单例导出 |
| `src/assets/avatar/visemes/{closed,a,o,e,i,u}.png` | 新增 | 6 张透明嘴型小图 |
| `src/store/agentStore.ts` | 修改 | +`currentViseme`/`setCurrentViseme`；−video 字段 |
| `src/components/Avatar/index.tsx` | 修改 | 底图 + viseme overlay，删 `<video>` |
| `src/components/Avatar/Avatar.module.css` | 修改 | overlay 样式 + 校准 CSS 变量 |
| `src/hooks/useAI.ts` | 修改 | 接入 `lipSyncController`，删 video 队列 |
| `src/App.tsx` | 修改 | 删 `onVideoEnded` / `handleVideoEnded` |
| `electron/main.ts` | 修改 | 删 avatar-video IPC 与初始化 |
| `electron/preload.ts` | 修改 | 删 avatar-video API 暴露 |
| `src/types/electron.d.ts` | 修改 | 删 avatar-video IPC 类型 |
| `.env.example` | 修改 | 删腾讯 IVH / COS 配置项 |
| `tests/viseme.test.ts` | 新增 | `textToVisemes` 单元测试 |
| `tests/LipSyncController.test.ts` | 新增 | controller 单元测试 |
| `tests/agentStore.test.ts` | 修改 | +`currentViseme` 测试 |
| `tests/useAI.test.ts` | 修改 | 改为 lipsync 生命周期测试 |
| `src/services/avatarVideo/{AvatarVideoProvider,TencentAvatarVideoProvider,index}.ts` | 删除 | 渲染端 video provider |
| `src/hooks/useAvatarVideoQueue.ts` | 删除 | video 队列 hook |
| `src/services/textSegmentation.ts` | 删除 | video 分段（仅 video 链路使用） |
| `electron/services/{TencentCosClient,TencentDigitalHumanService,TencentSigner,avatarVideoHandler}.ts` | 删除 | 腾讯主进程服务 |
| `tests/{AvatarVideoProvider,useAvatarVideoQueue,textSegmentation,TencentCosClient,TencentDigitalHumanService,TencentSigner,avatarVideoHandler}.test.ts` | 删除 | 对应测试 |

**任务顺序保证每个任务结束时项目可编译、测试通过**：先纯增量地建新模块（Task 1-4），再加 store 字段（Task 5），再切换 Avatar/useAI 使用新链路（Task 6-7），最后删除孤立的旧代码（Task 8-10）。

---

## Task 1: 依赖 + Viseme 类型

**Files:**
- Modify: `package.json`
- Modify: `shared/types.ts`

- [ ] **Step 1: 安装 pinyin-pro**

Run: `npm install pinyin-pro`

预期：`package.json` 的 `dependencies` 新增 `pinyin-pro`，`package-lock.json` 更新。

- [ ] **Step 2: 在 shared/types.ts 增加 Viseme 类型**

打开 `shared/types.ts`，在第 1 行 `export type AvatarMood = ...` 之后插入一行：

```ts
export type Viseme = 'closed' | 'a' | 'o' | 'e' | 'i' | 'u'
```

文件开头变为：

```ts
export type AvatarMood = 'idle' | 'thinking' | 'talking' | 'error'

export type Viseme = 'closed' | 'a' | 'o' | 'e' | 'i' | 'u'

export interface AvatarState {
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json shared/types.ts
git commit -m "feat: add pinyin-pro dependency and Viseme type"
```

---

## Task 2: textToVisemes 纯函数（TDD）

**Files:**
- Create: `src/services/lipsync/viseme.ts`
- Test: `tests/viseme.test.ts`

`textToVisemes` 把文本拆成 viseme 序列：中文走 `pinyin-pro` 取主元音；标点/空格插入 `closed`；英文/数字粗略映射。

- [ ] **Step 1: 写失败的测试**

Create `tests/viseme.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { textToVisemes } from '../src/services/lipsync/viseme'

describe('textToVisemes', () => {
  it('maps Chinese characters to vowel-based visemes', () => {
    // 你 ni→i, 好 hao→a
    expect(textToVisemes('你好')).toEqual(['i', 'a'])
  })

  it('maps multi-character Chinese correctly', () => {
    // 数 shu→u, 字 zi→i, 人 ren→e
    expect(textToVisemes('数字人')).toEqual(['u', 'i', 'e'])
  })

  it('inserts 3 closed frames for sentence-ending punctuation', () => {
    expect(textToVisemes('好。')).toEqual(['a', 'closed', 'closed', 'closed'])
  })

  it('inserts 1 closed frame for clause punctuation', () => {
    expect(textToVisemes('好，')).toEqual(['a', 'closed'])
  })

  it('inserts 1 closed frame for a space', () => {
    expect(textToVisemes('a b')).toEqual(['a', 'closed', 'e'])
  })

  it('maps ASCII vowels directly', () => {
    expect(textToVisemes('aeiou')).toEqual(['a', 'e', 'i', 'o', 'u'])
  })

  it('maps digits to the a viseme', () => {
    expect(textToVisemes('7')).toEqual(['a'])
  })

  it('returns an empty array for empty string', () => {
    expect(textToVisemes('')).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/viseme.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — 找不到模块 `../src/services/lipsync/viseme`。

- [ ] **Step 3: 实现 viseme.ts**

Create `src/services/lipsync/viseme.ts`:

```ts
import { pinyin } from 'pinyin-pro'
import type { Viseme } from '@shared/types'

const SENTENCE_END = /[。！？]/
const ELLIPSIS = /…/
const CLAUSE = /[，、；：]/
const CJK = /[一-鿿]/
const ASCII_LETTER = /[a-z]/i
const ASCII_VOWEL = /[aeiou]/i
const DIGIT = /[0-9]/

// 主元音优先级：a > o > e > i > u（ü/v 并入 u）
const VOWEL_PRIORITY: ReadonlyArray<readonly [RegExp, Viseme]> = [
  [/a/, 'a'],
  [/o/, 'o'],
  [/e/, 'e'],
  [/i/, 'i'],
  [/u/, 'u'],
  [/[üv]/, 'u'],
]

function syllableToViseme(syllable: string): Viseme {
  const lower = syllable.toLowerCase()
  for (const [re, v] of VOWEL_PRIORITY) {
    if (re.test(lower)) return v
  }
  return 'closed'
}

export function textToVisemes(text: string): Viseme[] {
  const out: Viseme[] = []
  let asciiConsonantIdx = 0

  for (const ch of text) {
    if (SENTENCE_END.test(ch)) { out.push('closed', 'closed', 'closed'); continue }
    if (ELLIPSIS.test(ch))     { out.push('closed', 'closed', 'closed', 'closed'); continue }
    if (CLAUSE.test(ch))       { out.push('closed'); continue }
    if (ch === '\n')           { out.push('closed', 'closed'); continue }
    if (/\s/.test(ch))         { out.push('closed'); continue }

    if (CJK.test(ch)) {
      const py = pinyin(ch, { toneType: 'none', type: 'array' })[0] ?? ''
      out.push(py ? syllableToViseme(py) : 'closed')
      continue
    }

    if (ASCII_LETTER.test(ch)) {
      if (ASCII_VOWEL.test(ch)) {
        out.push(syllableToViseme(ch))
      } else {
        out.push((['e', 'i'] as const)[asciiConsonantIdx % 2])
        asciiConsonantIdx++
      }
      continue
    }

    if (DIGIT.test(ch)) { out.push('a'); continue }

    out.push('closed')
  }

  return out
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/viseme.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: 8 个测试全部 PASS。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/services/lipsync/viseme.ts tests/viseme.test.ts
git commit -m "feat: add textToVisemes — Chinese pinyin to viseme mapping"
```

---

## Task 3: LipSyncController（TDD）

**Files:**
- Create: `src/services/lipsync/LipSyncController.ts`
- Create: `src/services/lipsync/index.ts`
- Test: `tests/LipSyncController.test.ts`

控制器按固定间隔步进 viseme 序列、序列走完循环重播；`stop()` 清定时器并强制 emit `closed`。

- [ ] **Step 1: 写失败的测试**

Create `tests/LipSyncController.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LipSyncController, STEP_INTERVAL } from '../src/services/lipsync/LipSyncController'
import type { Viseme } from '@shared/types'

describe('LipSyncController', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('emits the first viseme immediately on start()', () => {
    const ctrl = new LipSyncController()
    const seen: Viseme[] = []
    ctrl.start('你好', v => seen.push(v))
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toBe('closed')  // 你 → i
    ctrl.stop()
  })

  it('advances one viseme per STEP_INTERVAL', () => {
    const ctrl = new LipSyncController()
    const seen: Viseme[] = []
    ctrl.start('你好世界', v => seen.push(v))  // 4 visemes
    expect(seen).toHaveLength(1)
    vi.advanceTimersByTime(STEP_INTERVAL)
    expect(seen).toHaveLength(2)
    vi.advanceTimersByTime(STEP_INTERVAL)
    expect(seen).toHaveLength(3)
    ctrl.stop()
  })

  it('loops the sequence after it is exhausted', () => {
    const ctrl = new LipSyncController()
    const seen: Viseme[] = []
    ctrl.start('你', v => seen.push(v))  // single viseme
    vi.advanceTimersByTime(STEP_INTERVAL * 4)
    expect(seen.length).toBeGreaterThanOrEqual(5)
    expect(new Set(seen).size).toBe(1)  // looped same viseme
    ctrl.stop()
  })

  it('stop() clears the interval and emits closed', () => {
    const ctrl = new LipSyncController()
    const seen: Viseme[] = []
    ctrl.start('你好世界', v => seen.push(v))
    const before = seen.length
    ctrl.stop()
    expect(seen[seen.length - 1]).toBe('closed')
    vi.advanceTimersByTime(STEP_INTERVAL * 5)
    expect(seen.length).toBe(before + 1)  // no emissions after stop
  })

  it('start() then immediate stop() (no tick) still ends on closed', () => {
    const ctrl = new LipSyncController()
    const seen: Viseme[] = []
    ctrl.start('你好', v => seen.push(v))
    ctrl.stop()
    expect(seen[seen.length - 1]).toBe('closed')
  })

  it('second start() stops the first loop; old callback receives closed', () => {
    const ctrl = new LipSyncController()
    const first: Viseme[] = []
    const second: Viseme[] = []
    ctrl.start('你好', v => first.push(v))
    vi.advanceTimersByTime(STEP_INTERVAL)
    ctrl.start('世界', v => second.push(v))
    expect(first[first.length - 1]).toBe('closed')
    vi.advanceTimersByTime(STEP_INTERVAL)
    expect(second.length).toBeGreaterThanOrEqual(2)
    ctrl.stop()
  })

  it('emits closed for empty text', () => {
    const ctrl = new LipSyncController()
    const seen: Viseme[] = []
    ctrl.start('', v => seen.push(v))
    expect(seen).toEqual(['closed'])
    ctrl.stop()
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/LipSyncController.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — 找不到模块。

- [ ] **Step 3: 实现 LipSyncController.ts**

Create `src/services/lipsync/LipSyncController.ts`:

```ts
import type { Viseme } from '@shared/types'
import { textToVisemes } from './viseme'

export const STEP_INTERVAL = 180  // ms，相邻 viseme 的步进间隔

export class LipSyncController {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private onViseme: ((v: Viseme) => void) | null = null
  private sequence: Viseme[] = []
  private idx = 0

  start(text: string, onViseme: (v: Viseme) => void): void {
    this.stop()
    this.onViseme = onViseme
    this.sequence = textToVisemes(text)
    this.idx = 0
    if (this.sequence.length === 0) {
      onViseme('closed')
      return
    }
    // 立即 emit 首帧，避免开口前有一帧空档
    onViseme(this.sequence[0])
    this.idx = 1
    this.intervalId = setInterval(() => this.tick(), STEP_INTERVAL)
  }

  private tick(): void {
    if (!this.onViseme || this.sequence.length === 0) return
    this.onViseme(this.sequence[this.idx % this.sequence.length])
    this.idx++
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    // 强制闭口：无论当前处于什么 viseme
    this.onViseme?.('closed')
    this.onViseme = null
    this.sequence = []
    this.idx = 0
  }
}
```

- [ ] **Step 4: 创建单例导出**

Create `src/services/lipsync/index.ts`:

```ts
import { LipSyncController } from './LipSyncController'

export { LipSyncController } from './LipSyncController'
export const lipSyncController = new LipSyncController()
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npx vitest run tests/LipSyncController.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: 7 个测试全部 PASS。

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
git add src/services/lipsync/LipSyncController.ts src/services/lipsync/index.ts tests/LipSyncController.test.ts
git commit -m "feat: add LipSyncController — interval-stepped looping viseme emitter"
```

---

## Task 4: viseme 嘴型 PNG 素材

**Files:**
- Create: `src/assets/avatar/visemes/{closed,a,o,e,i,u}.png`

需要 6 张统一 256×128 的透明 PNG，每张把对应嘴型画在画布内固定位置。**主路径是用户提供成套美术素材。**

- [ ] **Step 1: 建目录，检查用户素材**

```bash
mkdir -p src/assets/avatar/visemes
ls src/assets/avatar/visemes/
```

如果 `closed.png` / `a.png` / `o.png` / `e.png` / `i.png` / `u.png` 六张都已就位 → 跳到 Step 3。

如果缺失 → 优先**停下来向用户索取**这 6 张透明 PNG（256×128，嘴型画在画布内固定锚点）。若用户希望先用占位图推进开发（最终美术稿在 Task 11 校准前替换），执行 Step 2。

- [ ] **Step 2:（占位图回退，仅在用户同意时）生成可见占位 PNG**

下面脚本生成 6 张 256×128 半透明品红色块——便于在 Task 11 校准 `--mouth-x/y/w` 时看清 overlay 位置。`--input-type=commonjs` 保证不受 package.json 模块类型影响。

```bash
node --input-type=commonjs <<'EOF'
const zlib = require('zlib'), fs = require('fs')
function crc(buf){let c=0xffffffff;for(let i=0;i<buf.length;i++){c^=buf[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xedb88320&-(c&1))}return (c^0xffffffff)>>>0}
function chunk(type,data){const t=Buffer.from(type);const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const body=Buffer.concat([t,data]);const cr=Buffer.alloc(4);cr.writeUInt32BE(crc(body));return Buffer.concat([len,body,cr])}
const W=256,H=128
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=6
const raw=Buffer.alloc(H*(1+W*4))
for(let y=0;y<H;y++){const o=y*(1+W*4);raw[o]=0;for(let x=0;x<W;x++){const p=o+1+x*4;raw[p]=255;raw[p+1]=0;raw[p+2]=255;raw[p+3]=150}}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))])
for(const n of ['closed','a','o','e','i','u']) fs.writeFileSync(`src/assets/avatar/visemes/${n}.png`,png)
console.log('placeholder visemes written')
EOF
```

**注意：占位图必须在 Task 11 验收前由真实美术稿替换。**

- [ ] **Step 3: 验证 6 张文件存在**

```bash
ls src/assets/avatar/visemes/
```

Expected: 输出包含 `a.png o.png e.png i.png u.png closed.png`。

- [ ] **Step 4: Commit**

```bash
git add src/assets/avatar/visemes/
git commit -m "feat: add 6 viseme mouth-shape PNG assets"
```

（若用的是占位图，commit message 改为 `chore: add placeholder viseme PNG assets (replace with final art)`。）

---

## Task 5: store 增加 currentViseme（TDD）

**Files:**
- Modify: `src/store/agentStore.ts`
- Test: `tests/agentStore.test.ts`

**纯增量**：只加 `currentViseme` / `setCurrentViseme`，暂不动 video 字段（Task 10 才删），保证本任务结束项目仍可编译。

- [ ] **Step 1: 在 agentStore.test.ts 增加失败测试**

打开 `tests/agentStore.test.ts`，在 `describe('agentStore', ...)` 内、`reset` 测试之后追加三个测试：

```ts
  it('currentViseme starts as closed', () => {
    expect(useAgentStore.getState().currentViseme).toBe('closed')
  })

  it('setCurrentViseme updates the viseme', () => {
    useAgentStore.getState().setCurrentViseme('a')
    expect(useAgentStore.getState().currentViseme).toBe('a')
  })

  it('reset restores currentViseme to closed', () => {
    useAgentStore.getState().setCurrentViseme('o')
    useAgentStore.getState().reset()
    expect(useAgentStore.getState().currentViseme).toBe('closed')
  })
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/agentStore.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — `currentViseme` / `setCurrentViseme` 不存在。

- [ ] **Step 3: 修改 agentStore.ts —— 改 import**

把第 2 行：

```ts
import type { AvatarMood, AgentMessage, ResourceCard, AppError, VideoQueueState } from '@shared/types'
```

改为：

```ts
import type { AvatarMood, AgentMessage, ResourceCard, AppError, VideoQueueState, Viseme } from '@shared/types'
```

- [ ] **Step 4: 修改 agentStore.ts —— 接口加字段**

在 `interface AgentStoreState` 内，`avatarVideoError: AppError | null` 一行之后加：

```ts
  currentViseme: Viseme
```

在 `setAvatarVideoError: (error: AppError | null) => void` 一行之后加：

```ts
  setCurrentViseme: (viseme: Viseme) => void
```

- [ ] **Step 5: 修改 agentStore.ts —— initialState 加字段**

在 `export const initialState` 内，`avatarVideoError: null as AppError | null,` 一行之后加：

```ts
  currentViseme: 'closed' as Viseme,
```

- [ ] **Step 6: 修改 agentStore.ts —— create 加 setter**

在 `setAvatarVideoError: avatarVideoError => set({ avatarVideoError }),` 一行之后加：

```ts
  setCurrentViseme: currentViseme => set({ currentViseme }),
```

- [ ] **Step 7: 运行测试 + 类型检查**

Run: `npx vitest run tests/agentStore.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: 全部 PASS（含新增 3 个）。

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 8: Commit**

```bash
git add src/store/agentStore.ts tests/agentStore.test.ts
git commit -m "feat: add currentViseme state to agentStore"
```

---

## Task 6: Avatar 组件 + CSS + App.tsx

**Files:**
- Modify: `src/components/Avatar/index.tsx`
- Modify: `src/components/Avatar/Avatar.module.css`
- Modify: `src/App.tsx`

Avatar 改为底图 `character.png` + 嘴部 overlay `<img>`，删除 `<video>`/`stalled`/`blocked` 全部逻辑。Avatar 不再接受任何 props。

- [ ] **Step 1: 整体替换 src/components/Avatar/index.tsx**

```tsx
import { useEffect } from 'react'
import { useAgentStore } from '../../store/agentStore'
import type { Viseme } from '@shared/types'
import characterImg from '../../assets/avatar/character.png'
import closedPng from '../../assets/avatar/visemes/closed.png'
import aPng from '../../assets/avatar/visemes/a.png'
import oPng from '../../assets/avatar/visemes/o.png'
import ePng from '../../assets/avatar/visemes/e.png'
import iPng from '../../assets/avatar/visemes/i.png'
import uPng from '../../assets/avatar/visemes/u.png'
import styles from './Avatar.module.css'

const VISEME_SRC: Record<Viseme, string> = {
  closed: closedPng,
  a: aPng,
  o: oPng,
  e: ePng,
  i: iPng,
  u: uPng,
}

export function Avatar() {
  const mood = useAgentStore(s => s.mood)
  const isPushing = useAgentStore(s => s.isPushing)
  const currentViseme = useAgentStore(s => s.currentViseme)
  const setCurrentViseme = useAgentStore(s => s.setCurrentViseme)

  // 防御性 cleanup：Avatar 是常驻组件，实际只在热重载 / 应用退出时触发。
  // controller 生命周期由 useAI 负责（spec Section 9 约束 1），此处不调 stop()。
  useEffect(() => {
    return () => { setCurrentViseme('closed') }
  }, [setCurrentViseme])

  const wrapClass = [
    styles.characterWrap,
    mood === 'thinking' ? styles.thinking : '',
    mood === 'talking' ? styles.talking : '',
    mood === 'error' ? styles.error : '',
    isPushing ? styles.pushing : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={styles.avatar}>
      <div className={wrapClass}>
        <img className={styles.characterImg} src={characterImg} alt="avatar" draggable={false} />
        <img className={styles.mouthOverlay} src={VISEME_SRC[currentViseme]} alt="" draggable={false} />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 整体替换 src/components/Avatar/Avatar.module.css**

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

  /* 嘴型 overlay 校准变量 —— 在 Task 11 手动调到对齐角色嘴部。
     --mouth-w 控制 overlay 屏幕显示尺寸（不得在 TS 里写死像素）。 */
  --mouth-x: 50%;
  --mouth-y: 62%;
  --mouth-w: 22%;
}

.characterImg {
  width: 100%;
  height: 100%;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
}

.mouthOverlay {
  position: absolute;
  left: var(--mouth-x);
  top: var(--mouth-y);
  width: var(--mouth-w);
  height: auto;            /* 由 <img> 按 256:128 自动保持比例 */
  transform: translate(-50%, -50%);
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
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
```

- [ ] **Step 3: 修改 src/App.tsx**

把第 13 行：

```tsx
  const { sendMessage, retry, handleVideoEnded } = useAI()
```

改为：

```tsx
  const { sendMessage, retry } = useAI()
```

把第 19 行：

```tsx
      <Avatar onVideoEnded={handleVideoEnded} />
```

改为：

```tsx
      <Avatar />
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。（`useAI` 此刻仍返回 `handleVideoEnded`，App 不解构它不会报错；Avatar 不再接受 props。）

- [ ] **Step 5: 全量测试（回归）**

Run: `npm test -- --pool=forks --poolOptions.forks.singleFork=true`
Expected: 全部 PASS（本任务未改测试，纯回归确认）。

- [ ] **Step 6: Commit**

```bash
git add src/components/Avatar/index.tsx src/components/Avatar/Avatar.module.css src/App.tsx
git commit -m "feat: Avatar renders character base + viseme PNG mouth overlay"
```

---

## Task 7: useAI 接入 lipSyncController

**Files:**
- Modify: `src/hooks/useAI.ts`
- Modify: `tests/useAI.test.ts`

- [ ] **Step 1: 整体替换 tests/useAI.test.ts**

```ts
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAI } from '../src/hooks/useAI'
import { useAgentStore, initialState } from '../src/store/agentStore'
import type { AIResponse } from '@shared/types'

const mockChat = vi.hoisted(() => vi.fn())
const mockSpeak = vi.hoisted(() => vi.fn())
const mockTtsStop = vi.hoisted(() => vi.fn())
const mockLipStart = vi.hoisted(() => vi.fn())
const mockLipStop = vi.hoisted(() => vi.fn())

vi.mock('../src/services/ai', () => ({
  aiProvider: { chat: mockChat },
}))
vi.mock('../src/services/tts', () => ({
  ttsProvider: { speak: mockSpeak, stop: mockTtsStop },
}))
vi.mock('../src/services/lipsync', () => ({
  lipSyncController: { start: mockLipStart, stop: mockLipStop },
}))

const mockReply = 'Test AI reply about friction'
const mockResponse: AIResponse = {
  reply: mockReply,
  resourceCards: [
    { id: 'c1', kind: 'external', title: 'Test', type: 'link', description: 'desc', url: 'https://example.com', tags: [] },
  ],
}

describe('useAI', () => {
  beforeEach(() => {
    mockChat.mockResolvedValue(mockResponse)
    mockSpeak.mockResolvedValue(undefined)
    vi.useFakeTimers()
    useAgentStore.setState(initialState)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('sets mood to thinking then talking on success', async () => {
    const { result } = renderHook(() => useAI())
    expect(useAgentStore.getState().mood).toBe('idle')
    act(() => { result.current.sendMessage('摩擦力') })
    expect(useAgentStore.getState().mood).toBe('thinking')
    expect(useAgentStore.getState().isLoading).toBe(true)
    await act(async () => { await vi.runAllTicks() })
    expect(useAgentStore.getState().mood).toBe('talking')
    expect(useAgentStore.getState().isLoading).toBe(false)
    expect(useAgentStore.getState().isPushing).toBe(true)
  })

  it('does not submit when isLoading is true', () => {
    const { result } = renderHook(() => useAI())
    act(() => { result.current.sendMessage('first') })
    act(() => { result.current.sendMessage('second') })
    expect(mockChat).toHaveBeenCalledTimes(1)
  })

  it('sets mood to error and stores lastUserInput on failure', async () => {
    mockChat.mockRejectedValue(new Error('network error'))
    const { result } = renderHook(() => useAI())
    await act(async () => { result.current.sendMessage('摩擦力'); await vi.runAllTicks() })
    const s = useAgentStore.getState()
    expect(s.mood).toBe('error')
    expect(s.error?.code).toBe('AI_ERROR')
    expect(s.lastUserInput).toBe('摩擦力')
    expect(s.isLoading).toBe(false)
  })

  it('retry sends lastUserInput again', async () => {
    mockChat.mockRejectedValueOnce(new Error('fail'))
    mockChat.mockResolvedValueOnce(mockResponse)
    const { result } = renderHook(() => useAI())
    await act(async () => { result.current.sendMessage('摩擦力'); await vi.runAllTicks() })
    expect(useAgentStore.getState().mood).toBe('error')
    await act(async () => { result.current.retry(); await vi.runAllTicks() })
    expect(mockChat).toHaveBeenCalledTimes(2)
    expect(useAgentStore.getState().mood).toBe('talking')
  })

  it('starts lip-sync with the reply text on AI success', async () => {
    mockSpeak.mockReturnValue(new Promise<void>(() => {}))  // never resolves
    const { result } = renderHook(() => useAI())
    await act(async () => { result.current.sendMessage('牛顿第一定律'); await vi.runAllTicks() })
    expect(mockLipStart).toHaveBeenCalledWith(mockReply, expect.any(Function))
    expect(useAgentStore.getState().mood).toBe('talking')
  })

  it('stops lip-sync and returns to idle after TTS resolves', async () => {
    let resolveSpeak!: () => void
    mockSpeak.mockReturnValue(new Promise<void>(r => { resolveSpeak = r }))
    const { result } = renderHook(() => useAI())
    await act(async () => { result.current.sendMessage('test'); await vi.runAllTicks() })
    expect(useAgentStore.getState().mood).toBe('talking')
    await act(async () => { resolveSpeak(); await vi.runAllTicks() })
    expect(mockLipStop).toHaveBeenCalled()
    expect(useAgentStore.getState().mood).toBe('idle')
    expect(useAgentStore.getState().isPushing).toBe(false)
  })

  it('stops lip-sync and returns to idle after TTS rejects', async () => {
    let rejectSpeak!: () => void
    mockSpeak.mockReturnValue(new Promise<void>((_, rej) => { rejectSpeak = () => rej(new Error('tts fail')) }))
    const { result } = renderHook(() => useAI())
    await act(async () => { result.current.sendMessage('test'); await vi.runAllTicks() })
    await act(async () => { rejectSpeak(); await vi.runAllTicks() })
    expect(mockLipStop).toHaveBeenCalled()
    expect(useAgentStore.getState().mood).toBe('idle')
  })

  it('stops previous TTS and lip-sync at the start of a new message', async () => {
    mockSpeak.mockReturnValue(new Promise<void>(() => {}))
    const { result } = renderHook(() => useAI())
    await act(async () => { result.current.sendMessage('first'); await vi.runAllTicks() })
    mockTtsStop.mockClear()
    mockLipStop.mockClear()
    await act(async () => { result.current.sendMessage('second'); await vi.runAllTicks() })
    expect(mockTtsStop).toHaveBeenCalled()
    expect(mockLipStop).toHaveBeenCalled()
  })

  it('stops lip-sync on AI failure', async () => {
    mockChat.mockRejectedValueOnce(new Error('network error'))
    const { result } = renderHook(() => useAI())
    await act(async () => { result.current.sendMessage('hi'); await vi.runAllTicks() })
    expect(mockLipStop).toHaveBeenCalled()
    expect(useAgentStore.getState().mood).toBe('error')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/useAI.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL —— 当前 `useAI.ts` 仍引用 `useAvatarVideoQueue`，与新 mock 不匹配（断言失败或引用错误）。

- [ ] **Step 3: 整体替换 src/hooks/useAI.ts**

```ts
import { useCallback } from 'react'
import { useAgentStore } from '../store/agentStore'
import { aiProvider } from '../services/ai'
import { ttsProvider } from '../services/tts'
import { lipSyncController } from '../services/lipsync'
import { isAppError } from '../services/ai/ElectronAIProvider'
import type { AppError } from '@shared/types'

export function useAI() {
  const sendMessage = useCallback(async (text: string) => {
    if (useAgentStore.getState().isLoading) return

    // 新一轮开始前，停掉上一条的 TTS 与口型（spec Section 9 约束 1）
    ttsProvider.stop()
    lipSyncController.stop()

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

      // 立即启动口型，再说话；speak() 的 resolve/reject 是唯一收尾信号
      lipSyncController.start(response.reply, useAgentStore.getState().setCurrentViseme)

      const finishTalking = () => {
        lipSyncController.stop()
        const st = useAgentStore.getState()
        st.setMood('idle')
        st.setIsPushing(false)
      }
      ttsProvider.speak(response.reply).then(finishTalking, finishTalking)
    } catch (err: unknown) {
      const appError: AppError = isAppError(err)
        ? (err as AppError)
        : { code: 'AI_ERROR', message: err instanceof Error ? err.message : String(err), recoverable: true }

      ttsProvider.stop()
      lipSyncController.stop()
      const s = useAgentStore.getState()
      s.setMood('error')
      s.setIsPushing(false)
      s.setError(appError)
      s.setIsLoading(false)
    }
  }, [])

  const retry = useCallback(() => {
    const { lastUserInput } = useAgentStore.getState()
    if (lastUserInput) sendMessage(lastUserInput)
  }, [sendMessage])

  return { sendMessage, retry }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/useAI.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: 9 个测试全部 PASS。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。（`useAvatarVideoQueue.ts` 此刻已无人引用，但文件仍在；Task 8 删除。）

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useAI.ts tests/useAI.test.ts
git commit -m "feat: useAI drives lipSyncController; TTS resolve/reject ends talking"
```

---

## Task 8: 删除渲染端 avatar-video 旧代码

**Files:**
- Delete: `src/services/avatarVideo/AvatarVideoProvider.ts`
- Delete: `src/services/avatarVideo/TencentAvatarVideoProvider.ts`
- Delete: `src/services/avatarVideo/index.ts`
- Delete: `src/hooks/useAvatarVideoQueue.ts`
- Delete: `src/services/textSegmentation.ts`
- Delete: `tests/AvatarVideoProvider.test.ts`
- Delete: `tests/useAvatarVideoQueue.test.ts`
- Delete: `tests/textSegmentation.test.ts`

- [ ] **Step 1: 确认无残留引用**

```bash
grep -rln 'avatarVideo\|useAvatarVideoQueue\|textSegmentation' src/ tests/
```

Expected: 仅列出即将删除的文件本身（`src/services/avatarVideo/*`、`src/hooks/useAvatarVideoQueue.ts`、`src/services/textSegmentation.ts` 及其 3 个测试）。若 `src/` 下其它文件仍引用 → 先回查 Task 6/7 是否漏改。

- [ ] **Step 2: 删除文件**

```bash
git rm src/services/avatarVideo/AvatarVideoProvider.ts \
       src/services/avatarVideo/TencentAvatarVideoProvider.ts \
       src/services/avatarVideo/index.ts \
       src/hooks/useAvatarVideoQueue.ts \
       src/services/textSegmentation.ts \
       tests/AvatarVideoProvider.test.ts \
       tests/useAvatarVideoQueue.test.ts \
       tests/textSegmentation.test.ts
```

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `npx tsc --noEmit`
Expected: 无错误。（`agentStore.ts` 仍保留 video 字段、`shared/types.ts` 仍有 `VideoQueueState`，Task 10 才删。）

Run: `npm test -- --pool=forks --poolOptions.forks.singleFork=true`
Expected: 全部 PASS（测试文件数比之前少 3 个）。

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: remove renderer-side avatar-video queue and Tencent provider"
```

---

## Task 9: 删除主进程腾讯数智人管线

**Files:**
- Delete: `electron/services/TencentCosClient.ts`
- Delete: `electron/services/TencentDigitalHumanService.ts`
- Delete: `electron/services/TencentSigner.ts`
- Delete: `electron/services/avatarVideoHandler.ts`
- Delete: `tests/TencentCosClient.test.ts`
- Delete: `tests/TencentDigitalHumanService.test.ts`
- Delete: `tests/TencentSigner.test.ts`
- Delete: `tests/avatarVideoHandler.test.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/types/electron.d.ts`
- Modify: `.env.example`
- Modify: `package.json`

- [ ] **Step 1: 删除主进程腾讯服务文件与测试**

```bash
git rm electron/services/TencentCosClient.ts \
       electron/services/TencentDigitalHumanService.ts \
       electron/services/TencentSigner.ts \
       electron/services/avatarVideoHandler.ts \
       tests/TencentCosClient.test.ts \
       tests/TencentDigitalHumanService.test.ts \
       tests/TencentSigner.test.ts \
       tests/avatarVideoHandler.test.ts
```

- [ ] **Step 2: electron/main.ts —— 删 import 块**

删除这 4 行（第 15-18 行，紧跟在 `import type { AppError } from '../shared/types'` 之后）：

```ts
import { TencentCosClient } from './services/TencentCosClient'
import { TencentDigitalHumanService } from './services/TencentDigitalHumanService'
import { runAvatarSegmentJob, validateSsml, type JobDeps, type JobEvents } from './services/avatarVideoHandler'
import { randomUUID } from 'crypto'
```

- [ ] **Step 3: electron/main.ts —— 删模块级变量**

删除这 4 行（原第 38-41 行，紧跟 `let deepseekProvider!: DeepseekAIProvider` 之后）：

```ts
let cosClient: TencentCosClient | null = null
let cachedRefPhotoUrl: Promise<string> | null = null
let dhService: TencentDigitalHumanService | null = null
const inFlightJobs = new Map<string, AbortController>()
```

- [ ] **Step 4: electron/main.ts —— 删辅助函数**

删除整段（原第 43-98 行）：`readConfigJson`、`writeConfigJson`、`resolveAvatarImagePath`、`initAvatarVideoServices` 四个函数。删完后 `let deepseekProvider!: DeepseekAIProvider` 的下一段应直接是 `function reloadApiKey(): void {`。要删的内容：

```ts
function readConfigJson(): Record<string, unknown> {
  const p = path.join(app.getPath('userData'), 'config.json')
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown> } catch { return {} }
}
function writeConfigJson(next: Record<string, unknown>): void {
  const p = path.join(app.getPath('userData'), 'config.json')
  fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8')
}

function resolveAvatarImagePath(): string {
  return path.join(__dirname, '..', 'resources', 'avatar', 'character.png')
}

function initAvatarVideoServices(): void {
  const ivhAppkey = process.env.TENCENT_IVH_APPKEY ?? ''
  const ivhAccesstoken = process.env.TENCENT_IVH_ACCESSTOKEN ?? ''
  const ivhEndpoint = process.env.TENCENT_IVH_ENDPOINT ?? 'gw.tvs.qq.com'

  if (!ivhAppkey || !ivhAccesstoken) {
    console.warn('[avatar-video] IVH appkey/accesstoken missing — video disabled, Web Speech fallback active')
    return
  }

  const secretId = process.env.TENCENT_SECRET_ID ?? ''
  const secretKey = process.env.TENCENT_SECRET_KEY ?? ''
  const cosRegion = process.env.TENCENT_COS_REGION ?? 'ap-shanghai'
  const cosBucket = process.env.TENCENT_COS_BUCKET ?? ''
  const useSignedUrl = (process.env.TENCENT_COS_USE_SIGNED_URL ?? 'true') !== 'false'

  if (!secretId || !secretKey || !cosBucket) {
    console.warn('[avatar-video] COS credentials or bucket missing — video disabled')
    return
  }

  cosClient = new TencentCosClient(
    { secretId, secretKey, region: cosRegion, bucket: cosBucket, useSignedUrl },
    { read: readConfigJson, write: writeConfigJson }
  )
  dhService = new TencentDigitalHumanService({
    appkey: ivhAppkey,
    accesstoken: ivhAccesstoken,
    endpoint: ivhEndpoint,
  })

  const characterPath = resolveAvatarImagePath()
  cachedRefPhotoUrl = (async () => {
    try {
      const buf = fs.readFileSync(characterPath)
      return await cosClient!.ensureRefPhotoUrl(buf)
    } catch (err) {
      console.error('[avatar-video] COS upload failed:', err)
      throw { code: 'COS_NOT_READY', message: String(err), recoverable: true } as AppError
    }
  })()
  cachedRefPhotoUrl.catch(() => {/* don't crash main */})
}
```

- [ ] **Step 5: electron/main.ts —— 删 init 调用**

在 `app.whenReady().then(() => { ... })` 内删除这一行：

```ts
  initAvatarVideoServices()
```

删完后 `.then()` 回调体最后一行是 `createWindow()`，紧接 `})`。

- [ ] **Step 6: electron/main.ts —— 删两个 IPC handler**

删除文件末尾的两个 handler（原第 260-305 行），即从 `ipcMain.handle('avatar-video:generate', ...)` 到文件结尾 `ipcMain.on('avatar-video:cancel', ...)` 的全部内容。删完后文件最后一个 handler 是 `ipcMain.handle('chat', ...)`。要删的内容：

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

- [ ] **Step 7: electron/preload.ts —— 删 avatar-video API**

删除 `transcribeAudio` 方法之后、对象结尾 `})` 之前的全部 5 个方法（原第 40-65 行）。删完后 `transcribeAudio(...) { ... },` 直接跟 `})`。要删的内容：

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

- [ ] **Step 8: 整体替换 src/types/electron.d.ts**

```ts
import type {
  AppError,
  AIResponse,
  AgentMessage,
} from '@shared/types'

declare global {
  interface Window {
    electronAPI: {
      resizeWindow(height: number): void
      openExternal(url: string): Promise<AppError | undefined>
      openResource(resourceId: string): Promise<AppError | undefined>
      onError(cb: (err: AppError) => void): () => void
      chat(messages: AgentMessage[]): Promise<AIResponse | AppError>
      setApiKey(key: string): Promise<AppError | undefined>
      transcribeAudio(buffer: ArrayBuffer): Promise<AppError | string>
    }
  }
}

export {}
```

- [ ] **Step 9: .env.example —— 删腾讯配置**

删除文件中「腾讯云数智人 IVH API」与「腾讯云 COS」两整段（从 `# 腾讯云数智人 IVH API` 注释行到 `TENCENT_COS_USE_SIGNED_URL=true` 行）。删完后 `.env.example` 只剩 `DEEPSEEK_API_KEY` 与 `SILICONFLOW_API_KEY` 两段。

- [ ] **Step 10: package.json —— 移除 cos 依赖**

Run: `npm uninstall cos-nodejs-sdk-v5`

预期：`package.json` 的 `dependencies` 不再有 `cos-nodejs-sdk-v5`，lockfile 更新。

- [ ] **Step 11: 类型检查 + 构建 + 全量测试**

Run: `npx tsc --noEmit`
Expected: 无错误。

Run: `npm run build`
Expected: 构建成功（覆盖 renderer + electron 编译；会生成未跟踪的 `dist/`、`dist-electron/`——**不要 git add 它们**）。

Run: `npm test -- --pool=forks --poolOptions.forks.singleFork=true`
Expected: 全部 PASS（测试文件数再少 4 个）。

- [ ] **Step 12: Commit**

```bash
git add electron/main.ts electron/preload.ts src/types/electron.d.ts .env.example package.json package-lock.json
git commit -m "chore: remove Tencent digital-human pipeline from main process"
```

---

## Task 10: 清除 store / shared 中的 video 死状态

**Files:**
- Modify: `src/store/agentStore.ts`
- Modify: `shared/types.ts`

此刻已无任何代码引用 video 状态，安全删除。

- [ ] **Step 1: 整体替换 src/store/agentStore.ts**

```ts
import { create } from 'zustand'
import type { AvatarMood, AgentMessage, ResourceCard, AppError, Viseme } from '@shared/types'

interface AgentStoreState {
  mood: AvatarMood
  isPushing: boolean
  inputText: string
  isLoading: boolean
  error: AppError | null
  lastUserInput: string
  messages: AgentMessage[]
  resourceCards: ResourceCard[]
  selectedResourceId: string | null
  currentViseme: Viseme

  setMood: (mood: AvatarMood) => void
  setIsPushing: (isPushing: boolean) => void
  setInputText: (text: string) => void
  setIsLoading: (loading: boolean) => void
  setError: (error: AppError | null) => void
  setLastUserInput: (text: string) => void
  addMessage: (message: AgentMessage) => void
  setResourceCards: (cards: ResourceCard[]) => void
  removeResourceCard: (id: string) => void
  setSelectedResourceId: (id: string | null) => void
  setCurrentViseme: (viseme: Viseme) => void
  reset: () => void
}

export const initialState = {
  mood: 'idle' as AvatarMood,
  isPushing: false,
  inputText: '',
  isLoading: false,
  error: null as AppError | null,
  lastUserInput: '',
  messages: [] as AgentMessage[],
  resourceCards: [] as ResourceCard[],
  selectedResourceId: null as string | null,
  currentViseme: 'closed' as Viseme,
}

export const useAgentStore = create<AgentStoreState>()(set => ({
  ...initialState,

  setMood: mood => set({ mood }),
  setIsPushing: isPushing => set({ isPushing }),
  setInputText: inputText => set({ inputText }),
  setIsLoading: isLoading => set({ isLoading }),
  setError: error => set({ error }),
  setLastUserInput: lastUserInput => set({ lastUserInput }),
  addMessage: message => set(state => ({ messages: [...state.messages, message] })),
  setResourceCards: resourceCards => set({ resourceCards }),
  removeResourceCard: id =>
    set(state => ({ resourceCards: state.resourceCards.filter(c => c.id !== id) })),
  setSelectedResourceId: selectedResourceId => set({ selectedResourceId }),
  setCurrentViseme: currentViseme => set({ currentViseme }),
  reset: () => set(initialState),
}))
```

- [ ] **Step 2: shared/types.ts —— 删 video 生命周期类型**

删除文件末尾「Avatar video lifecycle」整段，即从注释行 `// ── Avatar video lifecycle (Tencent digital human integration) ────` 到文件结尾。要删的内容：

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

删完后 `shared/types.ts` 最后一个声明是 `export interface AppError { ... }`。

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `npx tsc --noEmit`
Expected: 无错误。

Run: `npm test -- --pool=forks --poolOptions.forks.singleFork=true`
Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add src/store/agentStore.ts shared/types.ts
git commit -m "chore: remove dead avatar-video state from store and shared types"
```

---

## Task 11: 最终验证与口型校准

**Files:** 无代码变更（除 Step 4 校准 `Avatar.module.css`）。

- [ ] **Step 1: 全量自动验证**

```bash
npx tsc --noEmit
npm test -- --pool=forks --poolOptions.forks.singleFork=true
npm run build
```

Expected：类型检查无错误；全部测试 PASS；构建成功。（`dist/`、`dist-electron/` 为构建产物，不要提交。）

- [ ] **Step 2: 确认最终美术稿就位**

确认 `src/assets/avatar/visemes/` 下 6 张是**真实嘴型美术稿**（非 Task 4 的品红占位图）。若仍是占位图，向用户索取最终素材后替换并重新 `npm run build`。

- [ ] **Step 3: 手动冒烟测试**

```bash
npm run dev
```

逐项确认：
1. 头像正常显示，嘴部 overlay 落在脸上、不超出脸部范围。
2. 发送一条消息 → thinking 时角色轻微脉冲 → AI 回复后嘴在整段 TTS 期间持续开合 → 语音结束后嘴**立即闭合**、mood 回 idle。
3. 回复含标点（。，）处能看到短暂闭口停顿。
4. 快速连发两条消息 → 第二条开始时第一条口型立即停止，无残影。
5. 断网触发 AI error → 嘴闭合、mood=error。

- [ ] **Step 4: 口型位置校准（主观验收，不可跳过）**

在 `src/components/Avatar/Avatar.module.css` 的 `.characterWrap` 里调整三个变量，直到 overlay 与角色嘴部对齐：

```css
  --mouth-x: 50%;   /* 水平锚点：向左减小、向右增大 */
  --mouth-y: 62%;   /* 垂直锚点：向下增大 */
  --mouth-w: 22%;   /* overlay 显示宽度：嘴型太小则增大 */
```

验收标准（由用户确认）：
- [ ] 6 个 viseme overlay 都对齐角色嘴部，不在额头/下巴。
- [ ] 张嘴类 viseme（a/o）明显可见。
- [ ] `closed` 自然，且能完整遮盖底图原有嘴巴（无底图嘴巴透出）。
- [ ] 说话时 overlay 整体不超出脸部范围。

- [ ] **Step 5: 提交校准结果**

```bash
git add src/components/Avatar/Avatar.module.css
git commit -m "chore: calibrate viseme mouth overlay position"
```

（若 Step 2 替换了美术稿：`git add src/assets/avatar/visemes/ && git commit -m "feat: add final viseme mouth-shape artwork"`。）

---

## 完成后

实现完成、全部测试通过后，按项目流程进入 Superpowers **code review**，再走 OpenSpec **verify → archive**。本分支 `feature/local-viseme-lipsync` 通过 review 后再决定合并方式。
