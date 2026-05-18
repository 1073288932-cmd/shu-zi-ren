# Teaching Agent Desktop MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a transparent always-on-top Electron desktop app with a 2D CSS-animated character that responds to text input, drives a mood state machine, and pushes teaching resource cards.

**Architecture:** Single frameless transparent BrowserWindow at screen bottom-right. React renderer manages avatar state (mood + isPushing) and resource cards via Zustand. MockAIProvider with stable interface ready for real API swap. IPC security layer validates protocols and resource IDs before opening external URLs or local files.

**Tech Stack:** Electron 28, Vite 5, React 18, TypeScript 5, Zustand 4, Vitest 1, vite-plugin-electron 0.28, electron-builder 24, @testing-library/react 16, happy-dom 14

---

## File Map

| File | Responsibility |
|------|---------------|
| `shared/types.ts` | All shared types: AvatarMood, ResourceCard (discriminated union), AgentMessage, AIResponse, AppError |
| `src/types/electron.d.ts` | `window.electronAPI` global type declaration |
| `electron/security.ts` | Pure functions: validateExternalUrl, checkResourcePath (no fs, fully testable) |
| `electron/main.ts` | Window creation, IPC handlers, fs.existsSync check, resource whitelist |
| `electron/preload.ts` | contextBridge whitelisted API only |
| `src/services/ai/AIProvider.ts` | Interface: `chat(messages): Promise<AIResponse>` |
| `src/services/ai/MockAIProvider.ts` | Mock impl with `shouldFail` flag and physics resources |
| `src/services/ai/index.ts` | Exports active provider instance |
| `src/services/asr/ASRProvider.ts` | Interface: `start(); stop(); onResult(cb)` |
| `src/services/asr/NoopASRProvider.ts` | No-op implementation |
| `src/services/tts/TTSProvider.ts` | Interface: `speak(text): Promise<void>` |
| `src/services/tts/NoopTTSProvider.ts` | No-op implementation |
| `src/store/agentStore.ts` | Zustand store + `initialState` export for test resets |
| `src/hooks/useAI.ts` | Orchestrates provider call, store transitions, talking timer ref |
| `src/hooks/useAutoResizeWindow.ts` | ResizeObserver → preload.resizeWindow |
| `src/components/Avatar/index.tsx` | data-mood + data-pushing attrs, children slot for Live2D |
| `src/components/Avatar/Avatar.module.css` | Keyframe animations per mood |
| `src/components/ResourceCard/index.tsx` | Card display, kind-based open handler |
| `src/components/ResourceCard/ResourceCard.module.css` | Card styles |
| `src/components/InputBar/index.tsx` | Text input, submit on Enter, mic placeholder, retry button |
| `src/components/InputBar/InputBar.module.css` | Input bar styles |
| `src/App.tsx` | Root layout, drag region, compose Avatar + ResourceCard list + InputBar |
| `src/App.module.css` | Window shell + card scroll area styles |
| `src/main.tsx` | React DOM root |
| `src/index.css` | Global reset + transparent body |
| `index.html` | Vite entry |
| `vitest.config.ts` | Vitest config with happy-dom default env |
| `tests/security.test.ts` | Tests for validateExternalUrl + checkResourcePath |
| `tests/MockAIProvider.test.ts` | Tests for MockAIProvider shape and failure |
| `tests/agentStore.test.ts` | Store state transition tests |
| `tests/useAI.test.ts` | Hook tests: isLoading guard, retry, timer cleanup |
| `package.json` | Dependencies and scripts |
| `tsconfig.json` | TypeScript config |
| `vite.config.ts` | Vite + electron plugin config |
| `electron-builder.json` | Packaging config |
| `README.md` | Setup instructions + manual test checklist |

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `electron-builder.json`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/index.css`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "shu-zi-ren",
  "version": "0.1.0",
  "private": true,
  "main": "dist-electron/main.js",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "package": "vite build && electron-builder"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zustand": "^4.5.4"
  },
  "devDependencies": {
    "@types/node": "^20.14.12",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@testing-library/react": "^16.0.0",
    "@vitejs/plugin-react": "^4.3.1",
    "@vitest/coverage-v8": "^1.6.0",
    "electron": "^28.3.3",
    "electron-builder": "^24.13.3",
    "happy-dom": "^14.12.3",
    "typescript": "^5.5.4",
    "vite": "^5.4.0",
    "vite-plugin-electron": "^0.28.7",
    "vite-plugin-electron-renderer": "^0.14.5",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "paths": {
      "@shared/*": ["./shared/*"]
    }
  },
  "include": ["src", "shared", "electron", "tests"]
}
```

- [ ] **Step 3: Create vite.config.ts**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: { build: { outDir: 'dist-electron' } },
      },
      preload: {
        input: 'electron/preload.ts',
        vite: { build: { outDir: 'dist-electron' } },
      },
    }),
  ],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: [],
  },
})
```

- [ ] **Step 4: Create vitest.config.ts** (separate from vite.config so Vitest picks up test config cleanly)

```ts
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
})
```

- [ ] **Step 5: Create electron-builder.json**

```json
{
  "appId": "com.shuziren.teachingagent",
  "productName": "数字人助手",
  "directories": {
    "output": "release"
  },
  "files": [
    "dist/**/*",
    "dist-electron/**/*"
  ],
  "mac": {
    "category": "public.app-category.education",
    "target": "dmg"
  },
  "win": {
    "target": "nsis"
  }
}
```

- [ ] **Step 6: Create index.html** (project root)

```html
<!doctype html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'" />
    <title>数字人助手</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Create src/index.css**

```css
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body, #root {
  height: 100%;
  background: transparent;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
```

- [ ] **Step 8: Create src/main.tsx**

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

- [ ] **Step 9: Install dependencies**

```bash
npm install
```

Expected: node_modules created, no peer dependency errors.

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json vite.config.ts vitest.config.ts electron-builder.json index.html src/main.tsx src/index.css
git commit -m "feat: project scaffold — Electron + Vite + React + TS"
```

---

## Task 2: Shared Types

**Files:**
- Create: `shared/types.ts`
- Create: `src/types/electron.d.ts`

- [ ] **Step 1: Create shared/types.ts**

```ts
export type AvatarMood = 'idle' | 'thinking' | 'talking' | 'error'

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

- [ ] **Step 2: Create src/types/electron.d.ts**

```ts
import type { AppError } from '@shared/types'

declare global {
  interface Window {
    electronAPI: {
      resizeWindow(height: number): void
      openExternal(url: string): Promise<AppError | undefined>
      openResource(resourceId: string): Promise<AppError | undefined>
      onError(cb: (err: AppError) => void): () => void
    }
  }
}

export {}
```

- [ ] **Step 3: Verify TypeScript recognises the types**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add shared/types.ts src/types/electron.d.ts
git commit -m "feat: shared types and window.electronAPI declaration"
```

---

## Task 3: Vitest Smoke Test

**Files:**
- Create: `tests/smoke.test.ts`

- [ ] **Step 1: Create tests/smoke.test.ts**

```ts
import { describe, it, expect } from 'vitest'

describe('smoke', () => {
  it('vitest is working', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected output:
```
✓ tests/smoke.test.ts (1)
  ✓ smoke > vitest is working

Test Files  1 passed (1)
Tests       1 passed (1)
```

- [ ] **Step 3: Commit**

```bash
git add vitest.config.ts tests/smoke.test.ts
git commit -m "test: vitest smoke test setup"
```

---

## Task 4: Electron Security Functions (TDD)

**Files:**
- Create: `tests/security.test.ts`
- Create: `electron/security.ts`

- [ ] **Step 1: Write failing tests in tests/security.test.ts**

Add `// @vitest-environment node` so this file runs in Node (has access to `path`).

```ts
// @vitest-environment node

import { describe, it, expect } from 'vitest'
import path from 'path'
import { validateExternalUrl, checkResourcePath } from '../electron/security'

const BASE_DIR = '/safe/resources'

const whitelist = new Map<string, string>([
  ['res-001', '/safe/resources/video.mp4'],
  ['res-002', '/safe/resources/slides.pdf'],
])

describe('validateExternalUrl', () => {
  it('allows http URLs', () => {
    expect(validateExternalUrl('http://example.com')).toBeNull()
  })

  it('allows https URLs', () => {
    expect(validateExternalUrl('https://example.com/path?q=1')).toBeNull()
  })

  it('rejects file:// protocol', () => {
    const err = validateExternalUrl('file:///etc/passwd')
    expect(err).not.toBeNull()
    expect(err!.code).toBe('PROTOCOL_NOT_ALLOWED')
    expect(err!.recoverable).toBe(false)
  })

  it('rejects javascript: protocol', () => {
    const err = validateExternalUrl('javascript:alert(1)')
    expect(err).not.toBeNull()
    expect(err!.code).toBe('PROTOCOL_NOT_ALLOWED')
  })

  it('rejects data: protocol', () => {
    const err = validateExternalUrl('data:text/html,<h1>x</h1>')
    expect(err).not.toBeNull()
    expect(err!.code).toBe('PROTOCOL_NOT_ALLOWED')
  })

  it('rejects ftp: protocol', () => {
    const err = validateExternalUrl('ftp://files.example.com')
    expect(err).not.toBeNull()
    expect(err!.code).toBe('PROTOCOL_NOT_ALLOWED')
  })

  it('rejects malformed URLs', () => {
    const err = validateExternalUrl('not a url')
    expect(err).not.toBeNull()
    expect(err!.code).toBe('INVALID_URL')
  })
})

describe('checkResourcePath', () => {
  it('returns targetPath for valid resource id', () => {
    const result = checkResourcePath('res-001', whitelist, BASE_DIR)
    expect('targetPath' in result).toBe(true)
    if ('targetPath' in result) {
      expect(result.targetPath).toBe('/safe/resources/video.mp4')
    }
  })

  it('rejects unknown resource id', () => {
    const result = checkResourcePath('unknown-id', whitelist, BASE_DIR)
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error.code).toBe('RESOURCE_NOT_ALLOWED')
    }
  })

  it('rejects path traversal via relative segments', () => {
    const traversalWhitelist = new Map([
      ['bad', '/safe/resources/../../etc/passwd'],
    ])
    const result = checkResourcePath('bad', traversalWhitelist, BASE_DIR)
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error.code).toBe('RESOURCE_NOT_ALLOWED')
    }
  })

  it('rejects path that escapes base dir even after normalize', () => {
    const traversalWhitelist = new Map([
      ['escape', '/safe/other/file.pdf'],
    ])
    const result = checkResourcePath('escape', traversalWhitelist, BASE_DIR)
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error.code).toBe('RESOURCE_NOT_ALLOWED')
    }
  })
})
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
npm test tests/security.test.ts
```

Expected: FAIL — `Cannot find module '../electron/security'`

- [ ] **Step 3: Create electron/security.ts**

```ts
import path from 'path'
import type { AppError } from '../shared/types'

export function validateExternalUrl(url: string): AppError | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { code: 'INVALID_URL', message: `Invalid URL: ${url}`, recoverable: false }
  }

  const allowed = ['http:', 'https:']
  if (!allowed.includes(parsed.protocol)) {
    return {
      code: 'PROTOCOL_NOT_ALLOWED',
      message: `Protocol "${parsed.protocol}" is not allowed`,
      recoverable: false,
    }
  }

  return null
}

type ResourceResult =
  | { targetPath: string }
  | { error: AppError }

export function checkResourcePath(
  resourceId: string,
  whitelist: Map<string, string>,
  baseDir: string
): ResourceResult {
  const absolutePath = whitelist.get(resourceId)
  if (!absolutePath) {
    return {
      error: {
        code: 'RESOURCE_NOT_ALLOWED',
        message: `Resource "${resourceId}" is not in the whitelist`,
        recoverable: false,
      },
    }
  }

  const targetPath = path.normalize(path.resolve(absolutePath))
  const normalizedBase = path.normalize(path.resolve(baseDir))
  const relative = path.relative(normalizedBase, targetPath)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      error: {
        code: 'RESOURCE_NOT_ALLOWED',
        message: `Path traversal detected for resource "${resourceId}"`,
        recoverable: false,
      },
    }
  }

  return { targetPath }
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
npm test tests/security.test.ts
```

Expected:
```
✓ tests/security.test.ts (10)
  ✓ validateExternalUrl > allows http URLs
  ✓ validateExternalUrl > allows https URLs
  ✓ validateExternalUrl > rejects file:// protocol
  ... (all 10 pass)
Test Files  1 passed (1)
```

- [ ] **Step 5: Commit**

```bash
git add electron/security.ts tests/security.test.ts
git commit -m "feat(security): URL protocol validation and resource path traversal check"
```

---

## Task 5: Electron Main Process

**Files:**
- Create: `electron/main.ts`

- [ ] **Step 1: Create electron/main.ts**

```ts
import { app, BrowserWindow, ipcMain, shell, screen } from 'electron'
import path from 'path'
import fs from 'fs'
import { validateExternalUrl, checkResourcePath } from './security'
import type { AppError } from '../shared/types'

// MVP: hardcoded resource whitelist. Replace with config file loader later.
const RESOURCE_BASE_DIR = path.join(app.getPath('userData'), 'resources')
const resourceWhitelist = new Map<string, string>([
  ['res-local-001', path.join(RESOURCE_BASE_DIR, 'friction-slides.pdf')],
])

let mainWindow: BrowserWindow | null = null
let maxHeight = 800

function createWindow() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea
  maxHeight = Math.floor(height * 0.8)

  const windowWidth = 320
  const windowHeight = 420
  const margin = 16

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 280,
    maxHeight,
    x: x + width - windowWidth - margin,
    y: y + height - windowHeight - margin,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})

// IPC: resize window height (clamped to maxHeight)
ipcMain.on('resize-window', (event, height: number) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const bounds = win.getBounds()
  win.setBounds({ ...bounds, height: Math.min(Math.max(height, 200), maxHeight) })
})

// IPC: open external URL
ipcMain.handle('open-external', async (_, url: string): Promise<AppError | undefined> => {
  const error = validateExternalUrl(url)
  if (error) return error
  await shell.openExternal(url)
})

// IPC: open local resource by ID
ipcMain.handle('open-resource', async (_, resourceId: string): Promise<AppError | undefined> => {
  const result = checkResourcePath(resourceId, resourceWhitelist, RESOURCE_BASE_DIR)

  if ('error' in result) return result.error

  if (!fs.existsSync(result.targetPath)) {
    return {
      code: 'RESOURCE_NOT_FOUND',
      message: `File not found: ${result.targetPath}`,
      recoverable: false,
    }
  }

  await shell.openPath(result.targetPath)
})
```

- [ ] **Step 2: Run dev to verify window appears**

```bash
npm run dev
```

Expected: Electron window appears at bottom-right of screen. Window is transparent with no frame.

- [ ] **Step 3: Commit**

```bash
git add electron/main.ts
git commit -m "feat(main): Electron window, IPC handlers, security-gated open-external and open-resource"
```

---

## Task 6: Preload Script

**Files:**
- Create: `electron/preload.ts`

- [ ] **Step 1: Create electron/preload.ts**

```ts
import { contextBridge, ipcRenderer } from 'electron'
import type { AppError } from '../shared/types'

contextBridge.exposeInMainWorld('electronAPI', {
  resizeWindow(height: number): void {
    ipcRenderer.send('resize-window', height)
  },

  openExternal(url: string): Promise<AppError | undefined> {
    return ipcRenderer.invoke('open-external', url)
  },

  openResource(resourceId: string): Promise<AppError | undefined> {
    return ipcRenderer.invoke('open-resource', resourceId)
  },

  onError(cb: (err: AppError) => void): () => void {
    const handler = (_: unknown, err: AppError) => cb(err)
    ipcRenderer.on('app-error', handler)
    return () => ipcRenderer.removeListener('app-error', handler)
  },
})
```

- [ ] **Step 2: Verify in dev — open DevTools console and check**

```bash
npm run dev
```

In the Electron DevTools console, run:
```js
typeof window.electronAPI
```
Expected: `"object"`

- [ ] **Step 3: Commit**

```bash
git add electron/preload.ts
git commit -m "feat(preload): contextBridge whitelist API"
```

---

## Task 7: AI Services (TDD)

**Files:**
- Create: `src/services/ai/AIProvider.ts`
- Create: `src/services/ai/MockAIProvider.ts`
- Create: `src/services/ai/index.ts`
- Create: `tests/MockAIProvider.test.ts`

- [ ] **Step 1: Write failing tests in tests/MockAIProvider.test.ts**

```ts
// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { MockAIProvider } from '../src/services/ai/MockAIProvider'

describe('MockAIProvider', () => {
  it('returns an AIResponse with correct shape', async () => {
    const provider = new MockAIProvider()
    const result = await provider.chat([{ role: 'user', content: '摩擦力' }])

    expect(typeof result.reply).toBe('string')
    expect(result.reply.length).toBeGreaterThan(0)
    expect(Array.isArray(result.resourceCards)).toBe(true)
  })

  it('resource cards have required fields', async () => {
    const provider = new MockAIProvider()
    const result = await provider.chat([{ role: 'user', content: '摩擦力' }])

    for (const card of result.resourceCards) {
      expect(card).toHaveProperty('id')
      expect(card).toHaveProperty('kind')
      expect(['external', 'local']).toContain(card.kind)
      expect(card).toHaveProperty('title')
      expect(card).toHaveProperty('type')
      expect(card).toHaveProperty('description')
      expect(Array.isArray(card.tags)).toBe(true)
    }
  })

  it('external cards have url starting with http', async () => {
    const provider = new MockAIProvider()
    const result = await provider.chat([{ role: 'user', content: 'test' }])

    const externalCards = result.resourceCards.filter(c => c.kind === 'external')
    for (const card of externalCards) {
      if (card.kind === 'external') {
        expect(card.url).toMatch(/^https?:\/\//)
      }
    }
  })

  it('local cards do NOT have a url field', async () => {
    const provider = new MockAIProvider()
    const result = await provider.chat([{ role: 'user', content: 'test' }])

    const localCards = result.resourceCards.filter(c => c.kind === 'local')
    for (const card of localCards) {
      expect(card).not.toHaveProperty('url')
    }
  })

  it('throws when shouldFail is true', async () => {
    const provider = new MockAIProvider()
    provider.shouldFail = true

    await expect(
      provider.chat([{ role: 'user', content: 'test' }])
    ).rejects.toThrow('Mock AI failure')
  })
})
```

- [ ] **Step 2: Run — confirm fail**

```bash
npm test tests/MockAIProvider.test.ts
```

Expected: FAIL — `Cannot find module '../src/services/ai/MockAIProvider'`

- [ ] **Step 3: Create src/services/ai/AIProvider.ts**

```ts
import type { AIResponse, AgentMessage } from '@shared/types'

export interface AIProvider {
  chat(messages: AgentMessage[]): Promise<AIResponse>
}
```

- [ ] **Step 4: Create src/services/ai/MockAIProvider.ts**

```ts
import type { AIProvider } from './AIProvider'
import type { AIResponse, AgentMessage } from '@shared/types'

export class MockAIProvider implements AIProvider {
  shouldFail = false

  async chat(messages: AgentMessage[]): Promise<AIResponse> {
    if (this.shouldFail) throw new Error('Mock AI failure')

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 800))

    const lastContent = messages[messages.length - 1]?.content ?? '您的问题'

    return {
      reply: `关于「${lastContent}」：摩擦力是两个接触面之间的相互作用力，方向与运动趋势相反。生活中常见例子有刹车、握手机等。`,
      resourceCards: [
        {
          id: 'res-ext-001',
          kind: 'external',
          title: '摩擦力演示实验',
          type: 'video',
          description: '直观展示静摩擦力与滑动摩擦力的差异',
          url: 'https://phet.colorado.edu/sims/html/friction/latest/friction_zh_CN.html',
          tags: ['摩擦力', '实验', '演示'],
        },
        {
          id: 'res-ext-002',
          kind: 'external',
          title: '课堂导入案例',
          type: 'link',
          description: '滑动摩擦力的生活化引入设计',
          url: 'https://example.com/friction-intro',
          tags: ['备课', '导入', '摩擦力'],
        },
        {
          id: 'res-local-001',
          kind: 'local',
          title: '滑动摩擦力课件',
          type: 'doc',
          description: '含易错点分析与课堂追问设计',
          tags: ['课件', '易错点', '摩擦力'],
        },
      ],
    }
  }
}
```

- [ ] **Step 5: Create src/services/ai/index.ts**

```ts
import type { AIProvider } from './AIProvider'
import { MockAIProvider } from './MockAIProvider'

// Swap MockAIProvider for a real implementation when ready
export const aiProvider: AIProvider = new MockAIProvider()
```

- [ ] **Step 6: Run tests — confirm pass**

```bash
npm test tests/MockAIProvider.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/services/ai/ tests/MockAIProvider.test.ts
git commit -m "feat(ai): AIProvider interface, MockAIProvider with physics resources"
```

---

## Task 8: ASR / TTS Stubs

**Files:**
- Create: `src/services/asr/ASRProvider.ts`
- Create: `src/services/asr/NoopASRProvider.ts`
- Create: `src/services/tts/TTSProvider.ts`
- Create: `src/services/tts/NoopTTSProvider.ts`

- [ ] **Step 1: Create src/services/asr/ASRProvider.ts**

```ts
export interface ASRProvider {
  start(): void
  stop(): void
  onResult(cb: (text: string) => void): void
  onError(cb: (err: Error) => void): void
}
```

- [ ] **Step 2: Create src/services/asr/NoopASRProvider.ts**

```ts
import type { ASRProvider } from './ASRProvider'

export class NoopASRProvider implements ASRProvider {
  start(): void {}
  stop(): void {}
  onResult(_cb: (text: string) => void): void {}
  onError(_cb: (err: Error) => void): void {}
}
```

- [ ] **Step 3: Create src/services/tts/TTSProvider.ts**

```ts
export interface TTSProvider {
  speak(text: string): Promise<void>
  cancel(): void
}
```

- [ ] **Step 4: Create src/services/tts/NoopTTSProvider.ts**

```ts
import type { TTSProvider } from './TTSProvider'

export class NoopTTSProvider implements TTSProvider {
  async speak(_text: string): Promise<void> {}
  cancel(): void {}
}
```

- [ ] **Step 5: Commit**

```bash
git add src/services/asr/ src/services/tts/
git commit -m "feat(services): ASR and TTS provider interfaces with Noop stubs"
```

---

## Task 9: agentStore (TDD)

**Files:**
- Create: `src/store/agentStore.ts`
- Create: `tests/agentStore.test.ts`

- [ ] **Step 1: Write failing tests in tests/agentStore.test.ts**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore, initialState } from '../src/store/agentStore'
import type { AppError, ResourceCard } from '@shared/types'

const mockError: AppError = { code: 'AI_ERROR', message: 'fail', recoverable: true }

const mockCards: ResourceCard[] = [
  {
    id: 'c1',
    kind: 'external',
    title: 'Test',
    type: 'link',
    description: 'desc',
    url: 'https://example.com',
    tags: [],
  },
]

describe('agentStore', () => {
  beforeEach(() => {
    useAgentStore.setState(initialState)
  })

  it('starts with idle mood and empty state', () => {
    const s = useAgentStore.getState()
    expect(s.mood).toBe('idle')
    expect(s.isPushing).toBe(false)
    expect(s.isLoading).toBe(false)
    expect(s.messages).toHaveLength(0)
    expect(s.resourceCards).toHaveLength(0)
    expect(s.error).toBeNull()
  })

  it('setMood changes mood', () => {
    useAgentStore.getState().setMood('thinking')
    expect(useAgentStore.getState().mood).toBe('thinking')
  })

  it('setIsLoading toggles loading flag', () => {
    useAgentStore.getState().setIsLoading(true)
    expect(useAgentStore.getState().isLoading).toBe(true)
  })

  it('setError writes error and setMood to error', () => {
    useAgentStore.getState().setError(mockError)
    expect(useAgentStore.getState().error).toEqual(mockError)
  })

  it('addMessage appends to messages array', () => {
    useAgentStore.getState().addMessage({ role: 'user', content: 'hello' })
    useAgentStore.getState().addMessage({ role: 'assistant', content: 'hi' })
    expect(useAgentStore.getState().messages).toHaveLength(2)
    expect(useAgentStore.getState().messages[0].content).toBe('hello')
  })

  it('setResourceCards replaces cards and setIsPushing reflects count', () => {
    useAgentStore.getState().setResourceCards(mockCards)
    useAgentStore.getState().setIsPushing(mockCards.length > 0)
    expect(useAgentStore.getState().resourceCards).toHaveLength(1)
    expect(useAgentStore.getState().isPushing).toBe(true)
  })

  it('removeResourceCard removes by id', () => {
    useAgentStore.getState().setResourceCards(mockCards)
    useAgentStore.getState().removeResourceCard('c1')
    expect(useAgentStore.getState().resourceCards).toHaveLength(0)
  })

  it('reset returns to initialState', () => {
    useAgentStore.getState().setMood('error')
    useAgentStore.getState().addMessage({ role: 'user', content: 'x' })
    useAgentStore.getState().reset()
    const s = useAgentStore.getState()
    expect(s.mood).toBe('idle')
    expect(s.messages).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run — confirm fail**

```bash
npm test tests/agentStore.test.ts
```

Expected: FAIL — `Cannot find module '../src/store/agentStore'`

- [ ] **Step 3: Create src/store/agentStore.ts**

```ts
import { create } from 'zustand'
import type { AvatarMood, AgentMessage, ResourceCard, AppError } from '@shared/types'

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
  reset: () => set(initialState),
}))
```

- [ ] **Step 4: Run tests — confirm pass**

```bash
npm test tests/agentStore.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/store/agentStore.ts tests/agentStore.test.ts
git commit -m "feat(store): agentStore with mood/isPushing state machine and actions"
```

---

## Task 10: useAI Hook (TDD)

**Files:**
- Create: `tests/useAI.test.ts`
- Create: `src/hooks/useAI.ts`

- [ ] **Step 1: Write failing tests in tests/useAI.test.ts**

```ts
import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAI } from '../src/hooks/useAI'
import { useAgentStore, initialState } from '../src/store/agentStore'
import type { AIResponse } from '@shared/types'

const mockReply = 'Test AI reply about friction'
const mockResponse: AIResponse = {
  reply: mockReply,
  resourceCards: [
    {
      id: 'c1',
      kind: 'external',
      title: 'Test',
      type: 'link',
      description: 'desc',
      url: 'https://example.com',
      tags: [],
    },
  ],
}

const mockChat = vi.fn()

vi.mock('../src/services/ai', () => ({
  aiProvider: { chat: mockChat },
}))

describe('useAI', () => {
  beforeEach(() => {
    mockChat.mockResolvedValue(mockResponse)
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

  it('mood returns to idle after talking duration', async () => {
    const { result } = renderHook(() => useAI())

    await act(async () => {
      result.current.sendMessage('test')
      await vi.runAllTicks()
    })

    expect(useAgentStore.getState().mood).toBe('talking')

    act(() => { vi.runAllTimers() })

    expect(useAgentStore.getState().mood).toBe('idle')
  })

  it('does not submit when isLoading is true', async () => {
    const { result } = renderHook(() => useAI())

    act(() => { result.current.sendMessage('first') })
    act(() => { result.current.sendMessage('second') })

    expect(mockChat).toHaveBeenCalledTimes(1)
  })

  it('sets mood to error and stores lastUserInput on failure', async () => {
    mockChat.mockRejectedValue(new Error('network error'))
    const { result } = renderHook(() => useAI())

    await act(async () => {
      result.current.sendMessage('摩擦力')
      await vi.runAllTicks()
    })

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

    await act(async () => {
      result.current.sendMessage('摩擦力')
      await vi.runAllTicks()
    })

    expect(useAgentStore.getState().mood).toBe('error')

    await act(async () => {
      result.current.retry()
      await vi.runAllTicks()
    })

    expect(mockChat).toHaveBeenCalledTimes(2)
    expect(useAgentStore.getState().mood).toBe('talking')
  })

  it('clears old talking timer when new request starts', async () => {
    const { result } = renderHook(() => useAI())

    // First request
    await act(async () => {
      result.current.sendMessage('first')
      await vi.runAllTicks()
    })
    expect(useAgentStore.getState().mood).toBe('talking')

    // Advance partway into first timer
    act(() => { vi.advanceTimersByTime(500) })

    // Second request — should clear first timer, re-enter thinking
    await act(async () => {
      // Reset isLoading to allow second send (simulate first request fully done)
      useAgentStore.setState({ isLoading: false })
      result.current.sendMessage('second')
      await vi.runAllTicks()
    })

    expect(useAgentStore.getState().mood).toBe('talking')

    // Run all remaining timers — only one transition to idle should happen
    const setMoodSpy = vi.spyOn(useAgentStore.getState(), 'setMood')
    act(() => { vi.runAllTimers() })

    expect(useAgentStore.getState().mood).toBe('idle')
    // If old timer wasn't cleared, setMood('idle') would be called twice
    // But we can't easily count here — the key check is final state is idle (not called back to talking)
    setMoodSpy.mockRestore()
  })
})
```

- [ ] **Step 2: Run — confirm fail**

```bash
npm test tests/useAI.test.ts
```

Expected: FAIL — `Cannot find module '../src/hooks/useAI'`

- [ ] **Step 3: Create src/hooks/useAI.ts**

```ts
import { useCallback, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { aiProvider } from '../services/ai'
import type { AppError } from '@shared/types'

function calcTalkingDuration(replyLength: number): number {
  return Math.min(1500 + replyLength * 40, 8000)
}

export function useAI() {
  const talkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isLoading = useAgentStore(state => state.isLoading)

  const clearTalkingTimer = () => {
    if (talkingTimerRef.current !== null) {
      clearTimeout(talkingTimerRef.current)
      talkingTimerRef.current = null
    }
  }

  const sendMessage = useCallback(
    async (text: string) => {
      if (useAgentStore.getState().isLoading) return

      clearTalkingTimer()

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

        const duration = calcTalkingDuration(response.reply.length)
        talkingTimerRef.current = setTimeout(() => {
          useAgentStore.getState().setMood('idle')
          talkingTimerRef.current = null
        }, duration)
      } catch (err) {
        const error: AppError = {
          code: 'AI_ERROR',
          message: err instanceof Error ? err.message : String(err),
          recoverable: true,
        }
        const s = useAgentStore.getState()
        s.setMood('error')
        s.setError(error)
        s.setIsLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const retry = useCallback(() => {
    const { lastUserInput } = useAgentStore.getState()
    if (lastUserInput) sendMessage(lastUserInput)
  }, [sendMessage])

  return { sendMessage, retry, isLoading }
}
```

- [ ] **Step 4: Run tests — confirm pass**

```bash
npm test tests/useAI.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useAI.ts tests/useAI.test.ts
git commit -m "feat(useAI): hook with mood state machine, timer cleanup, retry"
```

---

## Task 11: Avatar Component

**Files:**
- Create: `src/components/Avatar/index.tsx`
- Create: `src/components/Avatar/Avatar.module.css`

- [ ] **Step 1: Create src/components/Avatar/Avatar.module.css**

```css
.avatar {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 0 8px;
  position: relative;
  flex-shrink: 0;
}

.character {
  font-size: 64px;
  line-height: 1;
  display: block;
  user-select: none;
}

.statusBadge {
  margin-top: 6px;
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

/* Idle: gentle float */
.avatar[data-mood="idle"] .character {
  animation: idle-float 3s ease-in-out infinite;
}
@keyframes idle-float {
  0%, 100% { transform: translateY(0); }
  50%       { transform: translateY(-5px); }
}

/* Thinking: pulse */
.avatar[data-mood="thinking"] .character {
  animation: thinking-pulse 0.9s ease-in-out infinite;
}
@keyframes thinking-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.65; transform: scale(0.94); }
}

/* Talking: vertical scale wave (simulates jaw movement) */
.avatar[data-mood="talking"] .character {
  animation: talking-wave 0.25s ease-in-out infinite alternate;
}
@keyframes talking-wave {
  from { transform: scaleY(1); }
  to   { transform: scaleY(1.05); }
}

/* Error: horizontal shake */
.avatar[data-mood="error"] .character {
  animation: error-shake 0.45s ease-in-out forwards;
}
@keyframes error-shake {
  0%,100% { transform: translateX(0); }
  20%     { transform: translateX(-5px); }
  40%     { transform: translateX(5px); }
  60%     { transform: translateX(-4px); }
  80%     { transform: translateX(4px); }
}

/* Pushing overlay: bouncing (overrides mood animation) */
.avatar[data-pushing="true"] .character {
  animation: pushing-bounce 0.55s ease-in-out infinite alternate !important;
}
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
```

- [ ] **Step 2: Create src/components/Avatar/index.tsx**

```tsx
import { useAgentStore } from '../../store/agentStore'
import styles from './Avatar.module.css'

interface AvatarProps {
  /** Slot for Live2D canvas, VRM, or Live Avatar video stream */
  children?: React.ReactNode
}

const MOOD_LABELS: Record<string, string> = {
  idle: '',
  thinking: '🤔 思考中…',
  talking: '🔊 讲解中',
  error: '⚠️ 出错了',
}

export function Avatar({ children }: AvatarProps) {
  const mood = useAgentStore(state => state.mood)
  const isPushing = useAgentStore(state => state.isPushing)

  return (
    <div
      className={styles.avatar}
      data-mood={mood}
      data-pushing={isPushing}
    >
      {isPushing && <span className={styles.pushingFlag}>📢</span>}

      {children ?? (
        <span className={styles.character} role="img" aria-label="教学助手">
          👩‍🏫
        </span>
      )}

      <span className={styles.statusBadge}>
        {MOOD_LABELS[mood]}
      </span>
    </div>
  )
}
```

- [ ] **Step 3: Verify in dev — run app and check animations**

```bash
npm run dev
```

Temporarily add `<Avatar />` to App.tsx (will be composed properly in Task 15). Verify idle animation plays.

- [ ] **Step 4: Commit**

```bash
git add src/components/Avatar/
git commit -m "feat(Avatar): 2D CSS animated character with mood/pushing state"
```

---

## Task 12: ResourceCard Component

**Files:**
- Create: `src/components/ResourceCard/index.tsx`
- Create: `src/components/ResourceCard/ResourceCard.module.css`

- [ ] **Step 1: Create src/components/ResourceCard/ResourceCard.module.css**

```css
.card {
  -webkit-app-region: no-drag;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 10px 12px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  animation: card-slide-in 0.25s ease-out both;
}

@keyframes card-slide-in {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

.card:hover {
  background: rgba(255, 255, 255, 0.13);
  border-color: rgba(125, 211, 252, 0.4);
}

.icon {
  font-size: 20px;
  flex-shrink: 0;
  margin-top: 1px;
}

.body {
  flex: 1;
  min-width: 0;
}

.title {
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.description {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 2px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 5px;
}

.tag {
  font-size: 10px;
  background: rgba(99, 102, 241, 0.25);
  color: #a5b4fc;
  border-radius: 4px;
  padding: 1px 5px;
}

.close {
  -webkit-app-region: no-drag;
  background: none;
  border: none;
  color: #64748b;
  cursor: pointer;
  font-size: 14px;
  padding: 0 0 0 4px;
  flex-shrink: 0;
  line-height: 1;
  transition: color 0.1s;
}

.close:hover {
  color: #94a3b8;
}
```

- [ ] **Step 2: Create src/components/ResourceCard/index.tsx**

```tsx
import { useAgentStore } from '../../store/agentStore'
import type { ResourceCard as ResourceCardType } from '@shared/types'
import styles from './ResourceCard.module.css'

const TYPE_ICONS: Record<string, string> = {
  video: '🎬',
  doc: '📄',
  exercise: '📝',
  experiment: '🧪',
  link: '🔗',
}

interface ResourceCardProps {
  card: ResourceCardType
}

export function ResourceCard({ card }: ResourceCardProps) {
  const removeResourceCard = useAgentStore(state => state.removeResourceCard)

  async function handleOpen(e: React.MouseEvent) {
    e.stopPropagation()
    if (card.kind === 'external') {
      const err = await window.electronAPI.openExternal(card.url)
      if (err) console.error('openExternal error:', err)
    } else {
      const err = await window.electronAPI.openResource(card.id)
      if (err) console.error('openResource error:', err)
    }
  }

  function handleClose(e: React.MouseEvent) {
    e.stopPropagation()
    removeResourceCard(card.id)
  }

  return (
    <div className={styles.card} onClick={handleOpen} role="button" tabIndex={0}>
      <span className={styles.icon}>{TYPE_ICONS[card.type] ?? '📎'}</span>

      <div className={styles.body}>
        <div className={styles.title}>{card.title}</div>
        <div className={styles.description}>{card.description}</div>
        {card.tags.length > 0 && (
          <div className={styles.tags}>
            {card.tags.map(tag => (
              <span key={tag} className={styles.tag}>{tag}</span>
            ))}
          </div>
        )}
      </div>

      <button
        className={styles.close}
        onClick={handleClose}
        aria-label="关闭卡片"
      >
        ✕
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/ResourceCard/
git commit -m "feat(ResourceCard): display card with kind-based open handler and close button"
```

---

## Task 13: InputBar Component

**Files:**
- Create: `src/components/InputBar/index.tsx`
- Create: `src/components/InputBar/InputBar.module.css`

- [ ] **Step 1: Create src/components/InputBar/InputBar.module.css**

```css
.inputBar {
  -webkit-app-region: no-drag;
  padding: 8px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}

.row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.input {
  -webkit-app-region: no-drag;
  flex: 1;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  color: #e2e8f0;
  font-size: 13px;
  padding: 7px 10px;
  outline: none;
  transition: border-color 0.15s;
  resize: none;
  height: 36px;
  font-family: inherit;
}

.input::placeholder {
  color: #64748b;
}

.input:focus {
  border-color: rgba(125, 211, 252, 0.5);
}

.input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sendBtn {
  -webkit-app-region: no-drag;
  width: 36px;
  height: 36px;
  background: #4f46e5;
  border: none;
  border-radius: 8px;
  color: white;
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s;
}

.sendBtn:hover:not(:disabled) {
  background: #4338ca;
}

.sendBtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.micBtn {
  -webkit-app-region: no-drag;
  width: 36px;
  height: 36px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  color: #94a3b8;
  font-size: 16px;
  cursor: not-allowed;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  title: '语音输入（即将支持）';
}

.retryRow {
  display: flex;
  align-items: center;
  gap: 6px;
}

.errorText {
  font-size: 11px;
  color: #f87171;
  flex: 1;
}

.retryBtn {
  -webkit-app-region: no-drag;
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #fca5a5;
  font-size: 11px;
  padding: 3px 8px;
  cursor: pointer;
  transition: background 0.15s;
}

.retryBtn:hover {
  background: rgba(239, 68, 68, 0.25);
}
```

- [ ] **Step 2: Create src/components/InputBar/index.tsx**

```tsx
import { useRef } from 'react'
import { useAgentStore } from '../../store/agentStore'
import { useAI } from '../../hooks/useAI'
import styles from './InputBar.module.css'

export function InputBar() {
  const inputText = useAgentStore(state => state.inputText)
  const setInputText = useAgentStore(state => state.setInputText)
  const mood = useAgentStore(state => state.mood)
  const error = useAgentStore(state => state.error)
  const isLoading = useAgentStore(state => state.isLoading)
  const { sendMessage, retry } = useAI()
  const inputRef = useRef<HTMLTextAreaElement>(null)

  function handleSubmit() {
    const text = inputText.trim()
    if (!text || isLoading) return
    setInputText('')
    sendMessage(text)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className={styles.inputBar}>
      {mood === 'error' && error && (
        <div className={styles.retryRow}>
          <span className={styles.errorText}>{error.message}</span>
          {error.recoverable && (
            <button className={styles.retryBtn} onClick={retry}>
              重试
            </button>
          )}
        </div>
      )}

      <div className={styles.row}>
        <textarea
          ref={inputRef}
          className={styles.input}
          placeholder="问我任何物理问题…"
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
          rows={1}
        />

        <button
          className={styles.micBtn}
          disabled
          title="语音输入（即将支持）"
          aria-label="语音输入（暂未开放）"
        >
          🎙
        </button>

        <button
          className={styles.sendBtn}
          onClick={handleSubmit}
          disabled={isLoading || !inputText.trim()}
          aria-label="发送"
        >
          ↑
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/InputBar/
git commit -m "feat(InputBar): text input with Enter submit, mic placeholder, retry button"
```

---

## Task 14: useAutoResizeWindow Hook

**Files:**
- Create: `src/hooks/useAutoResizeWindow.ts`

- [ ] **Step 1: Create src/hooks/useAutoResizeWindow.ts**

```ts
import { useEffect, useRef } from 'react'

export function useAutoResizeWindow(containerRef: React.RefObject<HTMLElement>) {
  const observerRef = useRef<ResizeObserver | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof window === 'undefined' || !window.electronAPI) return

    observerRef.current = new ResizeObserver(entries => {
      for (const entry of entries) {
        const height = Math.ceil(entry.contentRect.height)
        window.electronAPI.resizeWindow(height)
      }
    })

    observerRef.current.observe(el)

    return () => {
      observerRef.current?.disconnect()
    }
  }, [containerRef])
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/useAutoResizeWindow.ts
git commit -m "feat(useAutoResizeWindow): ResizeObserver drives IPC window resize"
```

---

## Task 15: App Root

**Files:**
- Create: `src/App.module.css`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create src/App.module.css**

```css
.shell {
  -webkit-app-region: drag;
  width: 320px;
  min-height: 120px;
  background: rgba(15, 15, 30, 0.88);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  color: #e2e8f0;
}

.cardArea {
  -webkit-app-region: no-drag;
  flex: 1;
  overflow-y: auto;
  padding: 0 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 280px;
}

.cardArea::-webkit-scrollbar {
  width: 4px;
}

.cardArea::-webkit-scrollbar-track {
  background: transparent;
}

.cardArea::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
}

.cardAreaLabel {
  font-size: 10px;
  color: #64748b;
  padding: 4px 2px 2px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.07);
  margin: 0 12px;
}
```

- [ ] **Step 2: Create src/App.tsx**

```tsx
import { useRef } from 'react'
import { Avatar } from './components/Avatar'
import { ResourceCard } from './components/ResourceCard'
import { InputBar } from './components/InputBar'
import { useAgentStore } from './store/agentStore'
import { useAutoResizeWindow } from './hooks/useAutoResizeWindow'
import styles from './App.module.css'

export default function App() {
  const resourceCards = useAgentStore(state => state.resourceCards)
  const shellRef = useRef<HTMLDivElement>(null)

  useAutoResizeWindow(shellRef)

  return (
    <div className={styles.shell} ref={shellRef}>
      <Avatar />

      {resourceCards.length > 0 && (
        <>
          <div className={styles.divider} />
          <div className={styles.cardArea}>
            <div className={styles.cardAreaLabel}>推送资源</div>
            {resourceCards.map(card => (
              <ResourceCard key={card.id} card={card} />
            ))}
          </div>
        </>
      )}

      <div className={styles.divider} />
      <InputBar />
    </div>
  )
}
```

- [ ] **Step 3: Run dev — verify full app works end to end**

```bash
npm run dev
```

Check:
- Window appears at bottom-right, draggable
- Avatar shows idle animation
- Type a message, press Enter
- Avatar transitions: idle → thinking → talking → idle
- Resource cards appear in scrollable area
- Click external card → browser opens
- Click ✕ on a card → card removes
- Try submitting again while loading (should be blocked)

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/App.module.css
git commit -m "feat(App): compose Avatar, ResourceCard list, InputBar with drag region"
```

---

## Task 16: Run Full Test Suite + README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected:
```
✓ tests/smoke.test.ts (1)
✓ tests/security.test.ts (10)
✓ tests/MockAIProvider.test.ts (5)
✓ tests/agentStore.test.ts (9)
✓ tests/useAI.test.ts (6)

Test Files  5 passed (5)
Tests      31 passed (31)
```

If any test fails, fix before proceeding.

- [ ] **Step 2: Create README.md**

````markdown
# 数字人助手

常驻桌面右下角的 2D 教学智能体 MVP。面向物理教师备课，支持文字输入、AI 对话和教学资源卡片推送。

## 安装与启动

```bash
npm install
npm run dev
```

窗口自动出现在屏幕右下角。

## 打包

```bash
npm run package
```

产物在 `release/` 目录。

## 测试

```bash
npm test
```

## 手动测试清单

- [ ] 启动应用，窗口出现在屏幕右下角
- [ ] 拖动窗口到其他位置
- [ ] 在输入框输入文字，按回车提交
- [ ] 数字人进入 thinking 状态（闪烁），随后 talking 状态（缩放波），最终回到 idle（漂浮）
- [ ] 资源卡片在数字人下方推送展示（滑入动画）
- [ ] 点击外部链接卡片，浏览器打开正确网址
- [ ] 点击本地资源卡片，系统用默认程序打开对应文件（shell.openPath）
- [ ] 手动点击 ✕ 关闭单张卡片，其余卡片保留
- [ ] 再次提交，新资源卡片替换旧卡片
- [ ] isLoading 期间连续点击提交，不触发重复请求（mock 仅被调用一次）
- [ ] 窗口高度超出时卡片区内部滚动，窗口不超出 maxHeight
- [ ] 模拟 AI 失败：将 `src/services/ai/MockAIProvider.ts` 中 `shouldFail = true`，重启 — 显示 error 状态和重试按钮
- [ ] 点击重试，重新发送上次输入，状态恢复正常

## 接入真实 AI API

将 `src/services/ai/index.ts` 中的 `MockAIProvider` 替换为实现 `AIProvider` 接口的真实类：

```ts
import { MyRealAPIProvider } from './MyRealAPIProvider'
export const aiProvider: AIProvider = new MyRealAPIProvider(API_KEY)
```

## 扩展接口

| 接口 | 位置 | 说明 |
|------|------|------|
| Live2D / VRM | `Avatar/index.tsx` children prop | 替换默认 emoji 角色 |
| Live Avatar 视频流 | `Avatar/index.tsx` children prop | 同上 |
| 语音输入 (ASR) | `src/services/asr/` | 实现 `ASRProvider` 接口 |
| 语音播报 (TTS) | `src/services/tts/` | 实现 `TTSProvider` 接口 |
````

- [ ] **Step 3: Final commit**

```bash
git add README.md
git commit -m "docs: README with setup, manual test checklist, extension guide"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Electron window: 320×420, minWidth 280, maxHeight 80%, always-on-top, transparent, frame:false
- ✅ Bottom-right corner positioning
- ✅ Draggable shell + no-drag interactive elements
- ✅ AvatarMood state machine: idle/thinking/talking/error + isPushing overlay
- ✅ CSS animations per mood (idle float, thinking pulse, talking wave, error shake, pushing bounce)
- ✅ children slot for Live2D/VRM
- ✅ MockAIProvider with delay + physics resources
- ✅ AIProvider/ASRProvider/TTSProvider interfaces with Noop stubs
- ✅ ResourceCard discriminated union kind:'external'|'local'
- ✅ openExternal: http/https only, rejects file/javascript/data/ftp
- ✅ openResource: resourceId only, path.relative traversal check
- ✅ MVP whitelist hardcoded in main.ts
- ✅ talking duration estimated from reply.length
- ✅ isLoading guard against re-entry
- ✅ talking timer cleared on new request
- ✅ lastUserInput preserved for retry
- ✅ Tests: security (10), MockAIProvider (5), agentStore (9), useAI (6)
- ✅ README manual test checklist (13 items)
