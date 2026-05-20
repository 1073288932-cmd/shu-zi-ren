# LipSync Avatar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the emoji avatar with a character PNG and add continuous simulated lip-sync — mouth shape and intensity cycle for the entire duration of TTS playback, driven by the audio lifecycle, not the text timeline.

**Architecture:** `LipSyncController` uses `setInterval` (110 ms) to emit `MouthState` updates indefinitely until `stop()` is called externally — this is **audio-lifecycle-driven simulated lip-sync**, not real audio analysis. The controller never decides when talking ends. `useAI` calls `lipSyncController.start(reply, onMouthState)` before TTS, then `.then().catch()` on `ttsProvider.speak()` to call `lipSyncController.stop()` and switch `mood → idle` when audio actually finishes. The `Avatar` component renders the character PNG with a CSS mouth overlay whose dimensions are scaled by both `mouthShape` (CSS class) and `speakingIntensity` (inline style).

**Tech Stack:** React 18, TypeScript 5.9, Zustand, CSS Modules, Vitest 1.6, Electron 28

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/assets/avatar/character.png` | Create | Transparent-background character image |
| `shared/types.ts` | Modify | Add `MouthShape`, `MouthState` |
| `src/store/agentStore.ts` | Modify | Add `mouthShape`, `speakingIntensity`, `setMouthState` |
| `src/services/lipsync/LipSyncController.ts` | Create | setInterval-based state emitter; loops until `stop()` |
| `src/services/lipsync/index.ts` | Create | Singleton export |
| `src/components/Avatar/Avatar.module.css` | Modify | Image container + CSS variables + 6 mouth shape classes |
| `src/components/Avatar/index.tsx` | Modify | Render image + intensity-scaled mouth overlay |
| `src/hooks/useAI.ts` | Modify | TTS `.then().catch()` drives lipSync stop + mood |
| `tests/LipSyncController.test.ts` | Create | Unit tests (fake timers, 8 tests) |
| `tests/useAI.test.ts` | Modify | Add 4 lip-sync lifecycle integration tests |

---

## Pre-flight: Commit Plan + Confirm Worktree

Before writing any code, run these two steps in the **main repository root** (not inside a worktree):

- [ ] **Commit the plan file**

```bash
git add docs/superpowers/plans/2026-05-20-lipsync-avatar.md
git commit -m "docs: add lipsync avatar implementation plan"
```

- [ ] **Confirm execution worktree**

This work should happen on the `feature/mvp-implementation` branch, inside `.worktrees/feature-mvp-implementation`. Verify you are in the correct location:

```bash
git branch --show-current      # expected: feature/mvp-implementation
git rev-parse --show-toplevel  # expected path ends with: .worktrees/feature-mvp-implementation
```

If the worktree doesn't exist yet, create it from the main repo root:

```bash
git worktree add .worktrees/feature-mvp-implementation feature/mvp-implementation
cd .worktrees/feature-mvp-implementation
npm install
```

All subsequent tasks must run from inside `.worktrees/feature-mvp-implementation`.

---

## Task 1: Image Asset + Types + Store

**Files:**
- Create: `src/assets/avatar/character.png`
- Modify: `shared/types.ts`
- Modify: `src/store/agentStore.ts`

- [ ] **Step 1: Copy character image and verify transparency**

```bash
mkdir -p src/assets/avatar
cp "/Users/baofeng/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_o4zo2zpvnhml22_73d4/temp/RWTemp/2026-05/cdd37b701370ef91e27080d2b53c4517/f09dc646967bd3bfc4276bae19e24a58.png" src/assets/avatar/character.png
sips -g hasAlpha src/assets/avatar/character.png
```

If the output contains `hasAlpha: yes` — transparency is confirmed, skip to Step 3.

If it says `hasAlpha: no` — the image has a solid/checkered background and cannot be used directly. **STOP** and ask the user:

> "当前图片没有 Alpha 透明通道（hasAlpha: no），直接使用会在 UI 里显示方形背景。  
> 请提供已抠图的透明 PNG（推荐用 Figma / Photoshop / remove.bg 导出），  
> 或者告诉我是否允许使用 rembg（pip install）自动抠图（效果不可控，仅作 fallback）。"

Wait for the user to either provide a transparent file or explicitly authorize rembg before continuing.

- [ ] **Step 2: (Fallback only, if user authorizes) Remove background with rembg**

Run only if the user explicitly approves:

```bash
pip install rembg pillow -q
python3 - <<'EOF'
from rembg import remove
from PIL import Image
img = Image.open('src/assets/avatar/character.png')
result = remove(img)
result.save('src/assets/avatar/character.png')
print('mode:', result.mode)  # must be RGBA
EOF
sips -g hasAlpha src/assets/avatar/character.png
```

Expected: `hasAlpha: yes`. Visually inspect the output in a browser before continuing — rembg may leave artifacts around hair/edges. If quality is unacceptable, ask the user to provide a manually-exported transparent PNG.

- [ ] **Step 3: Add MouthShape and MouthState to shared/types.ts**

Open `shared/types.ts`. After the `AvatarMood` line, add:

```ts
export type MouthShape = 'closed' | 'slightlyOpen' | 'ee' | 'oh' | 'ah' | 'wide'

export interface MouthState {
  shape: MouthShape
  intensity: number  // 0–1
}
```

Full file after change:

```ts
export type AvatarMood = 'idle' | 'thinking' | 'talking' | 'error'

export type MouthShape = 'closed' | 'slightlyOpen' | 'ee' | 'oh' | 'ah' | 'wide'

export interface MouthState {
  shape: MouthShape
  intensity: number  // 0–1
}

export interface AvatarState {
  mood: AvatarMood
  isPushing: boolean
}

export type ResourceCard =
  | {
      id: string
      kind: 'external'
      title: string
      type: 'video' | 'doc' | 'exercise' | 'experiment' | 'link'
      description: string
      url: string
      tags: string[]
    }
  | {
      id: string
      kind: 'local'
      title: string
      type: 'video' | 'doc' | 'exercise' | 'experiment' | 'link'
      description: string
      tags: string[]
    }

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AIResponse {
  reply: string
  resourceCards: ResourceCard[]
}

export interface AppError {
  code: string
  message: string
  recoverable: boolean
}
```

- [ ] **Step 4: Update agentStore**

Replace `src/store/agentStore.ts` entirely:

```ts
import { create } from 'zustand'
import type { AvatarMood, MouthShape, MouthState, AgentMessage, ResourceCard, AppError } from '@shared/types'

interface AgentStoreState {
  mood: AvatarMood
  isPushing: boolean
  mouthShape: MouthShape
  speakingIntensity: number
  inputText: string
  isLoading: boolean
  error: AppError | null
  lastUserInput: string
  messages: AgentMessage[]
  resourceCards: ResourceCard[]
  selectedResourceId: string | null

  setMood: (mood: AvatarMood) => void
  setIsPushing: (isPushing: boolean) => void
  setMouthState: (state: MouthState) => void
  setInputText: (text: string) => void
  setIsLoading: (loading: boolean) => void
  setError: (error: AppError | null) => void
  setLastUserInput: (text: string) => void
  addMessage: (message: AgentMessage) => void
  setResourceCards: (cards: ResourceCard[]) => void
  removeResourceCard: (id: string) => void
  setSelectedResourceId: (id: string | null) => void
  reset: () => void
}

export const initialState = {
  mood: 'idle' as AvatarMood,
  isPushing: false,
  mouthShape: 'closed' as MouthShape,
  speakingIntensity: 0,
  inputText: '',
  isLoading: false,
  error: null as AppError | null,
  lastUserInput: '',
  messages: [] as AgentMessage[],
  resourceCards: [] as ResourceCard[],
  selectedResourceId: null as string | null,
}

export const useAgentStore = create<AgentStoreState>()(set => ({
  ...initialState,

  setMood: mood => set({ mood }),
  setIsPushing: isPushing => set({ isPushing }),
  setMouthState: ({ shape, intensity }) => set({ mouthShape: shape, speakingIntensity: intensity }),
  setInputText: inputText => set({ inputText }),
  setIsLoading: isLoading => set({ isLoading }),
  setError: error => set({ error }),
  setLastUserInput: lastUserInput => set({ lastUserInput }),
  addMessage: message => set(state => ({ messages: [...state.messages, message] })),
  setResourceCards: resourceCards => set({ resourceCards }),
  removeResourceCard: id =>
    set(state => ({ resourceCards: state.resourceCards.filter(c => c.id !== id) })),
  setSelectedResourceId: selectedResourceId => set({ selectedResourceId }),
  reset: () => set(initialState),
}))
```

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/assets/avatar/character.png shared/types.ts src/store/agentStore.ts
git commit -m "feat: add MouthShape/MouthState types, speakingIntensity store field, character image"
```

---

## Task 2: LipSyncController (TDD)

**Files:**
- Create: `src/services/lipsync/LipSyncController.ts`
- Create: `src/services/lipsync/index.ts`
- Create: `tests/LipSyncController.test.ts`

The controller emits `MouthState` via `setInterval` at 110 ms intervals, cycling through text segments indefinitely. It has **no concept of "done"** — only external `stop()` ends it.

- [ ] **Step 1: Write failing tests**

Create `tests/LipSyncController.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LipSyncController } from '../src/services/lipsync/LipSyncController'
import type { MouthState } from '../shared/types'

describe('LipSyncController', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('start() emits speaking states for CJK text via interval', () => {
    const ctrl = new LipSyncController()
    const states: MouthState[] = []
    ctrl.start('你好', s => states.push(s))

    vi.advanceTimersByTime(110)  // 1 tick
    expect(states).toHaveLength(1)
    expect(states[0].shape).not.toBe('closed')
    expect(states[0].intensity).toBeGreaterThan(0)

    vi.advanceTimersByTime(110)  // 2nd tick
    expect(states).toHaveLength(2)

    ctrl.stop()
  })

  it('punctuation produces closed pause across multiple frames', () => {
    const ctrl = new LipSyncController()
    const states: MouthState[] = []
    ctrl.start('好。', s => states.push(s))

    vi.advanceTimersByTime(110)   // tick 1: '好' → speaking
    vi.advanceTimersByTime(110)   // tick 2: '。' → closed trigger (pauseFrames set)
    vi.advanceTimersByTime(110)   // tick 3: pause frame
    vi.advanceTimersByTime(110)   // tick 4: pause frame

    expect(states[0].shape).not.toBe('closed')
    expect(states[1].shape).toBe('closed')
    expect(states[1].intensity).toBe(0)
    expect(states[2].shape).toBe('closed')

    ctrl.stop()
  })

  it('stop() emits {shape:closed, intensity:0} immediately and clears interval', () => {
    const ctrl = new LipSyncController()
    const states: MouthState[] = []
    ctrl.start('你好世界', s => states.push(s))

    vi.advanceTimersByTime(110)  // 1 tick
    const before = states.length

    ctrl.stop()
    expect(states).toHaveLength(before + 1)
    expect(states[states.length - 1]).toEqual({ shape: 'closed', intensity: 0 })

    vi.advanceTimersByTime(2000)  // no more ticks
    expect(states).toHaveLength(before + 1)
  })

  it('stop() before any tick still emits closed state and clears', () => {
    const ctrl = new LipSyncController()
    const states: MouthState[] = []
    ctrl.start('你好', s => states.push(s))

    ctrl.stop()
    expect(states).toHaveLength(1)
    expect(states[0]).toEqual({ shape: 'closed', intensity: 0 })

    vi.advanceTimersByTime(2000)
    expect(states).toHaveLength(1)
  })

  it('loops continuously without stop(): keeps emitting after text exhausted', () => {
    const ctrl = new LipSyncController()
    const states: MouthState[] = []
    ctrl.start('你', s => states.push(s))  // single char

    // Advance well past one loop worth of time
    vi.advanceTimersByTime(110 * 5)

    expect(states.length).toBeGreaterThanOrEqual(5)

    ctrl.stop()
  })

  it('second start() stops first loop and begins fresh', () => {
    const ctrl = new LipSyncController()
    const states1: MouthState[] = []
    const states2: MouthState[] = []

    ctrl.start('你好', s => states1.push(s))
    vi.advanceTimersByTime(110)  // 1 tick from first

    ctrl.start('世界', s => states2.push(s))
    // stop() was called internally: last state1 entry must be closed
    expect(states1[states1.length - 1]).toEqual({ shape: 'closed', intensity: 0 })

    vi.advanceTimersByTime(110)  // 1 tick from second
    expect(states2).toHaveLength(1)
    expect(states2[0].shape).not.toBe('closed')
  })

  it('intensity is always in [0, 1] across all character types', () => {
    const ctrl = new LipSyncController()
    const states: MouthState[] = []
    ctrl.start('你好 Hello, world! 再见。', s => states.push(s))

    vi.advanceTimersByTime(110 * 30)
    ctrl.stop()

    for (const s of states) {
      expect(s.intensity).toBeGreaterThanOrEqual(0)
      expect(s.intensity).toBeLessThanOrEqual(1)
    }
  })

  it('ASCII chars produce lower intensity than CJK', () => {
    const ctrl = new LipSyncController()
    const cjkStates: MouthState[] = []
    const asciiStates: MouthState[] = []

    const cjkCtrl = new LipSyncController()
    cjkCtrl.start('你好世界', s => cjkStates.push(s))
    vi.advanceTimersByTime(110 * 4)
    cjkCtrl.stop()

    const asciiCtrl = new LipSyncController()
    asciiCtrl.start('abcd', s => asciiStates.push(s))
    vi.advanceTimersByTime(110 * 4)
    asciiCtrl.stop()

    const cjkAvg = cjkStates
      .filter(s => s.shape !== 'closed')
      .reduce((sum, s) => sum + s.intensity, 0) / cjkStates.filter(s => s.shape !== 'closed').length

    const asciiAvg = asciiStates
      .filter(s => s.shape !== 'closed')
      .reduce((sum, s) => sum + s.intensity, 0) / asciiStates.filter(s => s.shape !== 'closed').length

    expect(asciiAvg).toBeLessThan(cjkAvg)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/LipSyncController.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement LipSyncController**

Create `src/services/lipsync/LipSyncController.ts`:

```ts
import type { MouthShape, MouthState } from '@shared/types'

const INTERVAL = 110  // ms between mouth state updates

const CJK_SHAPES: MouthShape[] = ['ah', 'oh', 'ee', 'wide', 'slightlyOpen']
const ASCII_SHAPES: MouthShape[] = ['slightlyOpen', 'ee', 'oh']
const CJK_MAX_INTENSITY = 1.0
const ASCII_MAX_INTENSITY = 0.55

type SegType = 'cjk' | 'ascii' | 'pause' | 'silence'

interface Segment {
  type: SegType
  char: string
}

function segmentText(text: string): Segment[] {
  return [...text].map(ch => {
    if (/[。！？，、；…\n]/.test(ch)) return { type: 'pause' as const,   char: ch }
    if (/\s/.test(ch))                return { type: 'silence' as const, char: ch }
    if (/[一-鿿぀-ヿ가-힯]/.test(ch)) return { type: 'cjk' as const,     char: ch }
    return                                   { type: 'ascii' as const,   char: ch }
  })
}

function pauseFrames(char: string): number {
  if (/[。！？]/.test(char)) return 3  // 1 trigger + 3 = 4 × 110ms ≈ 440ms
  if (/[，、；]/.test(char)) return 1  // 1 trigger + 1 = 2 × 110ms ≈ 220ms
  if (/[…]/.test(char))      return 4  // 1 trigger + 4 = 5 × 110ms ≈ 550ms
  return 0
}

export class LipSyncController {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private onState: ((state: MouthState) => void) | null = null
  private segments: Segment[] = []
  private segIdx = 0
  private remainingPauseFrames = 0

  start(text: string, onState: (state: MouthState) => void): void {
    this.stop()
    this.onState = onState
    this.segments = segmentText(text)
    this.segIdx = 0
    this.remainingPauseFrames = 0
    if (this.segments.length === 0) return
    this.intervalId = setInterval(() => this._tick(), INTERVAL)
  }

  private _tick(): void {
    if (!this.onState) return

    if (this.remainingPauseFrames > 0) {
      this.remainingPauseFrames--
      this.onState({ shape: 'closed', intensity: 0 })
      return
    }

    const seg = this.segments[this.segIdx % this.segments.length]
    this.segIdx++

    if (seg.type === 'silence') {
      this.onState({ shape: 'closed', intensity: 0 })
      return
    }

    if (seg.type === 'pause') {
      this.remainingPauseFrames = pauseFrames(seg.char)
      this.onState({ shape: 'closed', intensity: 0 })
      return
    }

    const shapes = seg.type === 'cjk' ? CJK_SHAPES : ASCII_SHAPES
    const maxIntensity = seg.type === 'cjk' ? CJK_MAX_INTENSITY : ASCII_MAX_INTENSITY

    // Deterministic variation: avoids mechanical repetition without true randomness
    const shapeIdx = (this.segIdx * 3 + (this.segIdx >> 2)) % shapes.length
    const intensityVariation = 0.7 + 0.3 * Math.abs(Math.sin(this.segIdx * 0.618))
    const intensity = Math.min(1, maxIntensity * intensityVariation)

    this.onState({ shape: shapes[shapeIdx], intensity })
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.onState?.({ shape: 'closed', intensity: 0 })
    this.onState = null
    this.segments = []
    this.segIdx = 0
    this.remainingPauseFrames = 0
  }
}
```

- [ ] **Step 4: Create singleton**

Create `src/services/lipsync/index.ts`:

```ts
import { LipSyncController } from './LipSyncController'

export { LipSyncController }
export const lipSyncController = new LipSyncController()
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/LipSyncController.test.ts
```

Expected: 8 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/lipsync/ tests/LipSyncController.test.ts
git commit -m "feat: add LipSyncController — interval-based looping emitter, TTS drives stop"
```

---

## Task 3: Avatar CSS

**Files:**
- Modify: `src/components/Avatar/Avatar.module.css`

**Note on image size and overlay alignment:** The character image is a full-body shot displayed in a 240×280 container. The mouth area occupies roughly 5–8% of the image height, making the CSS overlay very small and hard to position precisely. Before implementing, confirm with the user:
- Is a **head/upper-body crop** (exported from the original image) available? A portrait crop at roughly 300×360 pt makes overlay calibration much easier.
- If only the full-body image is available, the overlay will still work but `--mouth-y` calibration is critical and the mouth shapes will appear small.

Either way, overlay position **must** be manually calibrated (Step 5 of Final Verification) before the feature is considered done.

- [ ] **Step 1: Replace Avatar.module.css**

Replace the entire file with:

```css
/* ── Layout ─────────────────────────────────────────────────────────── */
.avatar {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0 8px;
  position: relative;
  flex-shrink: 0;

  /* Mouth overlay calibration — adjust these to match the character image */
  --mouth-x: 50%;
  --mouth-y: 27%;
  --mouth-w: 7%;
}

/* ── Character image container ──────────────────────────────────────── */
.characterWrap {
  position: relative;
  width: 240px;
  height: 280px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.characterImg {
  width: 100%;
  height: 100%;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
}

/* ── Mouth overlay base — position driven by CSS vars ───────────────── */
.mouthOverlay {
  position: absolute;
  left: var(--mouth-x);
  top: var(--mouth-y);
  transform-origin: center top;
  /* translateX centering + scaleY driven by speakingIntensity (inline style) */
  width: var(--mouth-w);
  pointer-events: none;
}

/* ── 6 mouth shape classes (base size; scaled by intensity inline) ──── */
.mouthClosed {
  height: 2px;
  background: #7a3018;
  border-radius: 2px;
}

.mouthSlightlyOpen {
  height: 5px;
  background: #7a2a10;
  border-radius: 3px 3px 6px 6px;
}

.mouthEe {
  width: calc(var(--mouth-w) * 1.3);
  height: 4px;
  background: #883020;
  border-radius: 4px;
}

.mouthOh {
  width: calc(var(--mouth-w) * 0.65);
  height: 10px;
  background: #742010;
  border-radius: 50%;
}

.mouthAh {
  height: 14px;
  background: #681808;
  border-radius: 5px 5px 42% 42%;
}

.mouthWide {
  height: 17px;
  background: #5a1005;
  border-radius: 6px 6px 50% 50%;
}

/* ── Status badge ───────────────────────────────────────────────────── */
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

/* ── Mood animations — applied to .characterWrap ────────────────────── */
.avatar[data-mood="idle"] .characterWrap {
  animation: idle-float 3s ease-in-out infinite;
}
@keyframes idle-float {
  0%, 100% { transform: translateY(0); }
  50%       { transform: translateY(-5px); }
}

.avatar[data-mood="thinking"] .characterWrap {
  animation: thinking-pulse 0.9s ease-in-out infinite;
}
@keyframes thinking-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.7; transform: scale(0.96); }
}

/* talking: subtle head bob — lip movement comes from LipSyncController */
.avatar[data-mood="talking"] .characterWrap {
  animation: talking-bob 0.5s ease-in-out infinite alternate;
}
@keyframes talking-bob {
  from { transform: translateY(0); }
  to   { transform: translateY(-2px); }
}

.avatar[data-mood="error"] .characterWrap {
  animation: error-shake 0.45s ease-in-out forwards;
}
@keyframes error-shake {
  0%,100% { transform: translateX(0); }
  20%     { transform: translateX(-5px); }
  40%     { transform: translateX(5px); }
  60%     { transform: translateX(-4px); }
  80%     { transform: translateX(4px); }
}

.avatar[data-pushing="true"] .characterWrap {
  animation: pushing-bounce 0.55s ease-in-out infinite alternate !important;
}
@keyframes pushing-bounce {
  from { transform: translateY(0) rotate(0deg); }
  to   { transform: translateY(-8px) rotate(3deg); }
}

/* ── Pushing flag ───────────────────────────────────────────────────── */
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
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/Avatar/Avatar.module.css
git commit -m "feat: Avatar CSS — image container, CSS vars for mouth calibration, 6 mouth shapes"
```

---

## Task 4: Avatar Component

**Files:**
- Modify: `src/components/Avatar/index.tsx`

The mouth overlay's `scaleY` and `opacity` are set via inline style from `speakingIntensity`, so the overlay visually shrinks/grows with intensity without CSS animation (which would fight the LipSyncController's rapid updates).

- [ ] **Step 1: Replace Avatar/index.tsx**

```tsx
import { useEffect } from 'react'
import { useAgentStore } from '../../store/agentStore'
import { lipSyncController } from '../../services/lipsync'
import type { MouthShape } from '@shared/types'
import characterImg from '../../assets/avatar/character.png'
import styles from './Avatar.module.css'

interface AvatarProps {
  children?: React.ReactNode
}

const MOOD_LABELS: Record<string, string> = {
  idle: '',
  thinking: '🤔 思考中…',
  talking: '🔊 讲解中',
  error: '⚠️ 出错了',
}

const MOUTH_CLASSES: Record<MouthShape, string> = {
  closed:       styles.mouthClosed,
  slightlyOpen: styles.mouthSlightlyOpen,
  ee:           styles.mouthEe,
  oh:           styles.mouthOh,
  ah:           styles.mouthAh,
  wide:         styles.mouthWide,
}

export function Avatar({ children }: AvatarProps) {
  const mood             = useAgentStore(state => state.mood)
  const isPushing        = useAgentStore(state => state.isPushing)
  const mouthShape       = useAgentStore(state => state.mouthShape)
  const speakingIntensity = useAgentStore(state => state.speakingIntensity)

  useEffect(() => {
    return () => {
      lipSyncController.stop()
    }
  }, [])

  // For closed shape, keep full (tiny) size; for open shapes, scale by intensity
  const overlayScaleY = mouthShape === 'closed' ? 1 : speakingIntensity
  const overlayOpacity = mouthShape === 'closed' ? 1 : Math.max(0.2, speakingIntensity)

  return (
    <div className={styles.avatar} data-mood={mood} data-pushing={isPushing}>
      {isPushing && <span className={styles.pushingFlag}>📢</span>}

      {children ?? (
        <div className={styles.characterWrap}>
          <img
            src={characterImg}
            alt="教学助手"
            className={styles.characterImg}
            draggable={false}
          />
          {mood === 'talking' && (
            <div
              className={`${styles.mouthOverlay} ${MOUTH_CLASSES[mouthShape]}`}
              style={{
                transform: `translateX(-50%) scaleY(${overlayScaleY})`,
                opacity: overlayOpacity,
              }}
            />
          )}
        </div>
      )}

      <span className={styles.statusBadge}>{MOOD_LABELS[mood]}</span>
    </div>
  )
}
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

If you see "Cannot find module '*.png'", create `src/types/assets.d.ts`:

```ts
declare module '*.png' {
  const src: string
  export default src
}
```

Re-run `npx tsc --noEmit`. Expected: no errors.

- [ ] **Step 3: Run full test suite**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: all existing tests pass, 8 LipSyncController tests pass, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/Avatar/index.tsx src/types/
git commit -m "feat: Avatar renders character PNG with intensity-scaled mouth overlay"
```

---

## Task 5: useAI Integration + Tests

**Files:**
- Modify: `src/hooks/useAI.ts`
- Modify: `tests/useAI.test.ts`

### Part A — Verify ttsProvider.speak() returns Promise\<void\>

- [ ] **Step 1: Check speak() return type**

```bash
grep -n 'speak' src/services/tts/*.ts
```

The `speak(text: string)` method must return `Promise<void>` that resolves when audio playback ends. If the current signature is `speak(text: string): void`, update it to return a Promise and resolve it in the audio completion handler. Example pattern:

```ts
speak(text: string): Promise<void> {
  return new Promise(resolve => {
    // existing code...
    utterance.onend = () => resolve()
    // or for Web Audio: source.onended = () => resolve()
  })
}
```

After any change run:

```bash
npx tsc --noEmit
```

Expected: no errors.

### Part B — Replace useAI.ts

- [ ] **Step 2: Replace src/hooks/useAI.ts**

```ts
import { useCallback, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { aiProvider } from '../services/ai'
import { ttsProvider } from '../services/tts'
import { lipSyncController } from '../services/lipsync'
import { isAppError } from '../services/ai/ElectronAIProvider'
import type { AppError } from '@shared/types'

export function useAI() {
  const genRef = useRef(0)

  const sendMessage = useCallback(async (text: string) => {
    if (useAgentStore.getState().isLoading) return

    const myGen = ++genRef.current

    // Stop any in-progress TTS + lip-sync before starting new message
    ttsProvider.stop()
    lipSyncController.stop()
    useAgentStore.getState().setMouthState({ shape: 'closed', intensity: 0 })

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

      // Lip-sync loops indefinitely; TTS lifecycle drives the stop
      lipSyncController.start(response.reply, state => {
        if (genRef.current === myGen) {
          useAgentStore.getState().setMouthState(state)
        }
      })

      const finishTalking = () => {
        if (genRef.current === myGen) {
          lipSyncController.stop()
          useAgentStore.getState().setMouthState({ shape: 'closed', intensity: 0 })
          useAgentStore.getState().setMood('idle')
          useAgentStore.getState().setIsPushing(false)
        }
      }

      // Wrap in try/catch to handle synchronous throws from speak()
      try {
        ttsProvider.speak(response.reply).then(finishTalking).catch(finishTalking)
      } catch {
        finishTalking()
      }
    } catch (err: unknown) {
      const appError: AppError = isAppError(err)
        ? (err as AppError)
        : { code: 'AI_ERROR', message: err instanceof Error ? err.message : String(err), recoverable: true }

      ttsProvider.stop()
      lipSyncController.stop()
      const s = useAgentStore.getState()
      s.setMouthState({ shape: 'closed', intensity: 0 })
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

  return { sendMessage, retry }
}
```

### Part C — Add integration tests

- [ ] **Step 3: Add lip-sync lifecycle tests to tests/useAI.test.ts**

Open `tests/useAI.test.ts`. Locate the existing `vi.mock(...)` calls at the top. Add a mock for `lipSyncController` alongside the existing service mocks:

```ts
vi.mock('../src/services/lipsync', () => ({
  lipSyncController: {
    start: vi.fn(),
    stop:  vi.fn(),
  },
}))
```

Add this import after existing imports:

```ts
import { lipSyncController } from '../src/services/lipsync'
```

Add these 4 tests at the end of the file in their own `describe` block:

```ts
describe('useAI lip-sync lifecycle', () => {
  beforeEach(() => {
    vi.mocked(lipSyncController.start).mockClear()
    vi.mocked(lipSyncController.stop).mockClear()
    useAgentStore.setState(initialState)
  })

  it('calls lipSyncController.start with reply when AI responds', async () => {
    vi.mocked(ttsProvider.speak).mockReturnValue(new Promise(() => {}))  // never resolves

    const { sendMessage } = renderHook(() => useAI()).result.current
    await act(async () => { await sendMessage('test') })

    expect(lipSyncController.start).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
    )
    // TTS still pending: mood stays talking
    expect(useAgentStore.getState().mood).toBe('talking')
  })

  it('stops lip-sync and sets mood=idle after TTS resolves', async () => {
    let ttsResolve!: () => void
    vi.mocked(ttsProvider.speak).mockReturnValue(
      new Promise<void>(r => { ttsResolve = r }),
    )

    const { sendMessage } = renderHook(() => useAI()).result.current
    await act(async () => { await sendMessage('test') })
    expect(useAgentStore.getState().mood).toBe('talking')

    await act(async () => { ttsResolve() })

    expect(lipSyncController.stop).toHaveBeenCalled()
    expect(useAgentStore.getState().mood).toBe('idle')
    expect(useAgentStore.getState().mouthShape).toBe('closed')
    expect(useAgentStore.getState().speakingIntensity).toBe(0)
  })

  it('new request stops previous lip-sync immediately', async () => {
    vi.mocked(ttsProvider.speak).mockReturnValue(new Promise(() => {}))

    const { sendMessage } = renderHook(() => useAI()).result.current
    await act(async () => { await sendMessage('first') })
    vi.mocked(lipSyncController.stop).mockClear()

    await act(async () => { await sendMessage('second') })

    expect(lipSyncController.stop).toHaveBeenCalled()
  })

  it('AI error path stops lip-sync and sets mood=error', async () => {
    vi.mocked(aiProvider.chat).mockRejectedValueOnce(new Error('AI failed'))

    const { sendMessage } = renderHook(() => useAI()).result.current
    await act(async () => { await sendMessage('test') })

    expect(lipSyncController.stop).toHaveBeenCalled()
    expect(useAgentStore.getState().mood).toBe('error')
    expect(useAgentStore.getState().mouthShape).toBe('closed')
    expect(useAgentStore.getState().speakingIntensity).toBe(0)
  })
})
```

Note: if `renderHook`, `act`, and the mock variable names differ from the patterns above (e.g., if `ttsProvider` or `aiProvider` are mocked differently in the existing file), adapt the scaffolding to match. The `expect(...)` assertions must not change.

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run
```

Expected: all existing tests pass, 8 LipSyncController tests pass, 4 new useAI lip-sync tests pass.

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useAI.ts tests/useAI.test.ts
git commit -m "feat: useAI — TTS .then/.catch drives lipSync stop, mouth closed, mood idle"
```

---

## Final Verification

```bash
npx vitest run
npx tsc --noEmit
```

**Manual smoke test (requires running app):**

1. `npm run dev`
2. 确认角色图片无棋盘格背景（透明 PNG 正确渲染）
3. 发送消息 → 思考时轻微脉冲 → AI 回复后嘴巴**持续**开合直到语音播完 → 语音结束后嘴巴闭合，mood 恢复 idle
4. 快速连发两条消息 → 第二条开始时第一条口型立即停止，不留残影
5. 网络断开测试 → AI error 后嘴巴闭合，mood=error

**必须验收：口型位置校准（不可跳过）**

这是主观视觉验收，不能由测试代替。在 `Avatar.module.css` 的 `.avatar` 里调整三个 CSS 变量，直到覆盖层与角色嘴部对齐：

```css
.avatar {
  --mouth-x: 50%;   /* 水平居中；向左减小，向右增大 */
  --mouth-y: 27%;   /* 距容器顶部的百分比；向下增大 */
  --mouth-w: 7%;    /* 覆盖层宽度；嘴型太小则增大 */
}
```

验收标准（由用户确认）：
- [ ] 口型覆盖层落在角色嘴巴位置，而不是在额头/下巴
- [ ] `mouthAh`（最大开口）在视觉上明显可见，不像一条线
- [ ] `mouthClosed`（闭口）是一条细线，自然
- [ ] 说话时覆盖层整体不超出脸部范围

**注意：** 如果使用全身图，覆盖层会很小。如果视觉效果不理想，此处需要提供头部裁切版本并重新校准。
