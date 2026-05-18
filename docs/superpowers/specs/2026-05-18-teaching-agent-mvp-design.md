# 教学智能体桌面 MVP — Design Doc

Date: 2026-05-18  
Status: Approved

---

## 概述

一个常驻桌面右下角的 2D 数字人教学助手，面向物理教师备课和课堂资源调用。用户通过文字输入与数字人交互，数字人语音播报回答（MVP 阶段为文字展示，TTS 接口预留），并根据 AI 回复推送教学资源卡片。点击卡片可打开本地文件或外部网页。

---

## 技术栈

- Electron 28 + Vite + React 18 + TypeScript
- Zustand（状态管理）
- CSS Modules（样式隔离）
- electron-builder（打包）

---

## 目录结构

```
shu-zi-ren/
├── shared/
│   └── types.ts                  # AvatarState、ResourceCard、AIResponse、AgentMessage、AppError
├── electron/
│   ├── main.ts                   # 窗口创建、IPC 注册、安全校验
│   └── preload.ts                # 白名单 API：resizeWindow、openExternal、openResource、onError
├── src/
│   ├── App.tsx                   # 根容器，-webkit-app-region:drag
│   ├── components/
│   │   ├── Avatar/               # 数字人组件
│   │   ├── InputBar/             # 文字输入 + 麦克风占位
│   │   └── ResourceCard/         # 资源卡片
│   ├── hooks/
│   │   ├── useAI.ts              # 调用 AIProvider，驱动 store 状态流转
│   │   └── useAutoResizeWindow.ts # ResizeObserver → preload.resizeWindow
│   ├── services/
│   │   ├── ai/
│   │   │   ├── AIProvider.ts     # interface AIProvider { chat(messages): Promise<AIResponse> }
│   │   │   ├── MockAIProvider.ts # Mock 实现
│   │   │   └── index.ts          # 导出当前激活 provider
│   │   ├── asr/
│   │   │   ├── ASRProvider.ts    # interface ASRProvider { start(); stop(); onResult(cb) }
│   │   │   └── NoopASRProvider.ts
│   │   └── tts/
│   │       ├── TTSProvider.ts    # interface TTSProvider { speak(text): Promise<void> }
│   │       └── NoopTTSProvider.ts
│   └── store/
│       └── agentStore.ts         # Zustand store
├── package.json
├── vite.config.ts
└── electron-builder.json
```

---

## 共享类型（shared/types.ts）

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
      url: string        // http:// 或 https://，渲染层可见
      tags: string[]
    }
  | {
      id: string
      kind: 'local'
      title: string
      type: 'video' | 'doc' | 'exercise' | 'experiment' | 'link'
      description: string
      tags: string[]
      // 无 url 字段：渲染层只知道 id，路径由主进程白名单管理
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

---

## Electron 窗口参数

| 参数 | 值 |
|------|----|
| 初始尺寸 | 320 × 420 |
| minWidth | 280 |
| maxHeight | `workAreaSize.height × 0.8`（启动时计算） |
| alwaysOnTop | true |
| transparent | true |
| frame | false |
| resizable | false |
| nodeIntegration | false |
| contextIsolation | true |

窗口定位：右下角，距屏幕边缘 16px。

---

## Electron 安全规则

### preload 白名单 API
```ts
window.electronAPI = {
  resizeWindow(height: number): void
  openExternal(url: string): Promise<void | AppError>
  openResource(resourceId: string): Promise<void | AppError>
  onError(cb: (err: AppError) => void): void
}
```
不暴露 `fs`、`path`、`shell`、`ipcRenderer` 原对象。

### openExternal 协议白名单
只放行 `http://`、`https://`。拒绝 `file://`、`javascript:`、`data:`、`ftp:` 及其他协议，返回 `AppError { code: 'PROTOCOL_NOT_ALLOWED' }`。

### openResource 路径安全
1. 渲染层只传 `resourceId`，不传路径
2. 主进程查白名单资源表（`Map<id, absolutePath>`）；MVP 阶段该表在 `main.ts` 中硬编码初始化，后续可从配置文件加载
3. `path.resolve` + `path.normalize` 规范化路径得到 `targetPath`
4. 路径遍历检查：`path.relative(baseDir, targetPath)` 的结果不得以 `..` 开头，也不得是绝对路径（即结果不得包含 `path.sep` 为首的部分）；如需防 symlink，对 `targetPath` 额外调用 `fs.realpathSync` 后重新校验
5. `fs.existsSync` 验证文件存在后调用 `shell.openPath`（用默认程序打开资源文件）
6. 非法路径 → `RESOURCE_NOT_ALLOWED`；文件不存在 → `RESOURCE_NOT_FOUND`

### ResourceCard 打开方式判断（渲染层）
组件根据 `kind` 字段决定调用哪个 preload API，不读取路径：
- `kind === 'external'` → `openExternal(card.url)`
- `kind === 'local'` → `openResource(card.id)`

---

## 拖动区设置

- `App` 外层 `div`：`-webkit-app-region: drag`
- `input`、`button`、`textarea`、`ResourceCard` 容器：`-webkit-app-region: no-drag`

---

## Avatar 状态机

```
idle ──[用户提交]──→ thinking ──[AI返回]──→ talking ──[估算时长结束]──→ idle
                                                                ↑
                                          isPushing = resourceCards.length > 0
                     [任意阶段失败] ──→ error
```

- `mood`：`idle` / `thinking` / `talking` / `error`
- `isPushing`：叠加状态，true 时显示举牌动画
- `data-mood` + `data-pushing` 属性驱动 CSS keyframe
- 预留 `children` slot 供后续替换为 Live2D canvas / VRM / Live Avatar 视频流

### talking 时长估算
```ts
const duration = Math.min(1500 + reply.length * 40, 8000) // ms
```

---

## agentStore（Zustand）

```ts
{
  mood: AvatarMood
  isPushing: boolean
  inputText: string
  isLoading: boolean
  error: AppError | null
  lastUserInput: string
  messages: AgentMessage[]
  resourceCards: ResourceCard[]
  selectedResourceId: string | null
}
```

---

## 数据流

```
用户输入
→ useAI.sendMessage()
→ store: mood=thinking, isLoading=true, 清理旧 talking timer
→ MockAIProvider.chat(messages)
  ├─ 成功 → store 追加 AI message，更新 resourceCards
  │         store: mood=talking, isPushing=(resourceCards.length>0)
  │         按 reply.length 估算 talking 时长
  │         时间到 → mood=idle，resourceCards 继续展示
  └─ 失败 → store: mood=error, error=AppError, 保留 lastUserInput

重试
→ 点击重试按钮 → useAI.sendMessage(lastUserInput) → 同上
```

资源卡片保留展示，直到用户手动关闭或下一次 AI 推送替换。

---

## useAutoResizeWindow

ResizeObserver 监听内容根节点高度，变化时调用 `preload.resizeWindow(height)`，主进程限制上限为 `maxHeight`。

---

## 测试覆盖点

1. MockAIProvider 返回结构符合 `AIResponse` 类型
2. agentStore 状态流转：thinking → talking → idle
3. AI 失败 → error 写入 store + 重试触发 lastUserInput
4. `openExternal` 协议白名单（合法/非法各场景）
5. `openResource` 路径白名单（含路径遍历攻击场景）
6. 连续快速提交防重入（isLoading=true 时禁止提交）
7. talking timer 清理（新请求覆盖旧 timer）

---

## 扩展接口预留

| 接口 | 位置 | 说明 |
|------|------|------|
| Live2D / VRM | `Avatar/index.tsx` children slot | 替换 CSS 角色渲染 |
| Live Avatar 云端视频流 | `Avatar/index.tsx` children slot | 同上 |
| 真实 AI API | `services/ai/index.ts` | 替换 MockAIProvider |
| ASR 语音输入 | `services/asr/` | 实现 ASRProvider 接口 |
| TTS 语音播报 | `services/tts/` | 实现 TTSProvider 接口 |

---

## README 手动测试清单

- [ ] 启动应用，窗口出现在屏幕右下角
- [ ] 拖动窗口到其他位置
- [ ] 在输入框输入文字，回车提交
- [ ] 数字人进入 thinking 状态，随后 talking 状态，最终回到 idle
- [ ] 资源卡片在数字人下方推送展示
- [ ] 点击外部链接卡片，浏览器打开正确网址
- [ ] 点击本地资源卡片，系统用默认程序打开对应文件（shell.openPath）
- [ ] 手动关闭单张卡片，其余卡片保留
- [ ] 再次提交，新资源卡片替换旧卡片
- [ ] 模拟 AI 失败（MockAIProvider 抛错），显示 error 状态和重试按钮
- [ ] 点击重试，重新发送上次输入
- [ ] isLoading 期间连续点击提交，不触发重复请求
- [ ] 窗口高度超出时卡片区内部滚动，窗口不超出 maxHeight
