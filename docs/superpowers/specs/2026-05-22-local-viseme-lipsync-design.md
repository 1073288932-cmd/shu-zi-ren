# 本地 viseme + PNG 嘴型动画 设计文档

**日期：** 2026-05-22
**背景：** `feature/realistic-lipsync` 分支把嘴形改为腾讯数智人云端视频驱动（`useAvatarVideoQueue` + `TencentDigitalHumanService`），并删除了旧的 CSS 覆盖层 lipsync。云端视频方案未跑通，头像只显示静态 `character.png`，嘴形不能动。
**目标：** 用纯本地方案替代云端视频——TTS 讲话时，由回复文本（中文→拼音→韵母→viseme）推导一组嘴型，在 `character.png` 嘴部叠加切换透明嘴型 PNG，模拟说话；语音结束后嘴形回到闭口。

---

## 非目标

- 不做真实音频振幅分析（WebSpeech `speechSynthesis` 不暴露可分析的音频流）。
- 不追求音素级精确对齐，目标是「说话期间嘴自然地动、停得干净」。
- 不重画整张角色图（见 Section 9 约束 3）。
- 不保留任何腾讯数智人 / COS 代码路径（彻底移除，见 Section 8）。

---

## Section 1：架构

**数据流：**

```
useAI: AI 回复
  → store.setMood('talking')
  → lipSyncController.start(reply, setCurrentViseme)
  → ttsProvider.speak(reply)              [并行]
        │
        ├─ LipSyncController: textToVisemes(reply) 得到 viseme 序列
        │   setInterval 每 STEP_INTERVAL 推进一个 viseme，序列走完循环重播
        │   每帧 → store.setCurrentViseme(v)
        │
        └─ Avatar: 订阅 store.currentViseme
            底图 character.png 不变，嘴部 overlay <img> 切换到对应 viseme PNG

ttsProvider.speak() resolve / reject
  → lipSyncController.stop()  （强制 emit 'closed'）
  → store.setMood('idle')
```

**职责边界：**

| 单元 | 职责 | 不负责 |
|------|------|--------|
| `viseme.ts` | 纯函数：文本 → viseme 序列 | 计时、状态 |
| `LipSyncController` | 计时步进、循环、生命周期 | 文本解析、渲染 |
| `agentStore` | 持有 `currentViseme` 单一状态 | 计时逻辑 |
| `Avatar` | 按 `currentViseme` 渲染 overlay | 计时、文本解析 |
| `useAI` | 串联 TTS 与 LipSyncController 生命周期 | viseme 计算 |

**LipSyncController 与 TTS 的同步方式（MVP 策略）：** 固定间隔步进。`speechSynthesis` 不提供音素/边界事件（中文环境 `boundary` 事件在 Electron/Chromium 不可靠）。

**本轮明确不扩展 `TTSProvider` 接口**（不新增 `onStart` 之类回调）。同步策略：AI 回复到达后**立即**调用 `lipSyncController.start()`，紧接着调用 `ttsProvider.speak()`——两者并行启动，不等待 TTS 真正出声。`speak()` 的 Promise **resolve / reject** 是唯一的收尾信号，触发 `lipSyncController.stop()`。

已知取舍：WebSpeech 真正出声前有微小延迟，嘴可能比声音早动几十毫秒——MVP 接受此偏差，不为消除它扩展接口。viseme 序列长度与语音时长也不会精确相等：序列短于语音时循环重播，长于语音时被 `stop()` 截断——两种情况都可接受。

---

## Section 2：viseme 素材

**viseme 集合（6 个）：**

| viseme | 口型 | 主元音 / 触发 |
|--------|------|--------------|
| `closed` | 闭口 | 辅音独立音、停顿、标点、空格、静音 |
| `a` | 大开口 | a 系韵母（a/ai/ao/an/ang/ia/ua…） |
| `o` | 圆唇中开 | o 系韵母（o/ou/uo/ong/iong…） |
| `e` | 扁中开 | e 系韵母（e/ei/en/eng/er/ie/üe…） |
| `i` | 咧嘴扁平 | i 系韵母（i/in/ing…） |
| `u` | 圆唇小开 | u/ü 系韵母（u/ü，ü 并入 u） |

**素材规格：**

- 路径：`src/assets/avatar/visemes/{closed,a,o,e,i,u}.png`，共 6 张。
- 画布：统一 **256×128** 透明 PNG。每张把对应嘴型画在画布内**固定位置**，6 张共用一个锚点，渲染时无需逐张校准。
- 256×128 仅为素材统一画布尺寸；屏幕显示尺寸由 CSS 变量控制，不在代码里写死（见 Section 9 约束 2）。
- overlay 与底图关系：`character.png` 嘴部仅要求「与 overlay 不冲突」。若原图已有嘴巴，6 张 viseme PNG（含 `closed`）必须能**完整遮盖**底图嘴部区域；不要求重画整张角色图（见 Section 9 约束 3）。

---

## Section 3：文件与接口

### 新增

| 文件 | 职责 |
|------|------|
| `src/assets/avatar/visemes/{closed,a,o,e,i,u}.png` | 6 张透明嘴型小图 |
| `src/services/lipsync/viseme.ts` | `textToVisemes()` 纯函数 + `Viseme` 相关常量 |
| `src/services/lipsync/LipSyncController.ts` | 计时步进控制器 |
| `src/services/lipsync/index.ts` | 单例导出 |
| `tests/viseme.test.ts` | `textToVisemes` 单元测试 |
| `tests/LipSyncController.test.ts` | 控制器单元测试（fake timers） |

### 修改

| 文件 | 改动 |
|------|------|
| `shared/types.ts` | 新增 `Viseme` 类型；删除腾讯视频相关类型（见 Section 8） |
| `src/store/agentStore.ts` | 新增 `currentViseme` / `setCurrentViseme`；删除 `videoUrl` / `videoQueueState` / `avatarVideoError` 及其 setter |
| `src/components/Avatar/index.tsx` | 删除 `<video>` 逻辑，改为底图 + viseme overlay |
| `src/components/Avatar/Avatar.module.css` | 新增 overlay 定位 CSS 变量与样式；删除 video 样式 |
| `src/hooks/useAI.ts` | 移除 `useAvatarVideoQueue`，接入 `lipSyncController` |
| `src/App.tsx` | 若向 `Avatar` 传 `onVideoEnded` / 使用 `handleVideoEnded`，一并清理 |
| `src/types/electron.d.ts` | 删除 avatar-video 相关 IPC 类型声明 |
| `electron/main.ts` | 删除 avatar-video IPC 注册 |
| `electron/preload.ts` | 删除 avatar-video API 暴露 |
| `.env.example` | 删除腾讯密钥配置项 |
| `package.json` | 删除 `cos-nodejs-sdk-v5` 依赖；新增 `pinyin-pro` 依赖 |
| `tests/agentStore.test.ts` | 更新断言（去 video 字段，加 currentViseme） |
| `tests/useAI.test.ts` | 更新断言（去 video queue，加 lipsync 生命周期） |

### 删除（腾讯数智人管线，见 Section 8）

`electron/services/TencentDigitalHumanService.ts`、`TencentSigner.ts`、`TencentCosClient.ts`、`avatarVideoHandler.ts`；`src/services/avatarVideo/`（整目录）；`src/hooks/useAvatarVideoQueue.ts`；`src/services/textSegmentation.ts`（确认无其它消费者后删）；对应测试 `AvatarVideoProvider.test.ts`、`TencentDigitalHumanService.test.ts`、`TencentSigner.test.ts`、`TencentCosClient.test.ts`、`avatarVideoHandler.test.ts`、`useAvatarVideoQueue.test.ts`、`textSegmentation.test.ts`。

### 核心类型

```ts
// shared/types.ts
export type Viseme = 'closed' | 'a' | 'o' | 'e' | 'i' | 'u'
```

---

## Section 4：viseme 映射（textToVisemes）

`src/services/lipsync/viseme.ts` 导出纯函数：

```ts
export function textToVisemes(text: string): Viseme[]
```

**逐字符规则：**

| 字符类别 | 处理 |
|----------|------|
| 句末标点 `。！？` | push 3 × `closed` |
| 句中标点 `，、；：` | push 1 × `closed` |
| 省略号 `…` | push 4 × `closed` |
| 换行 `\n` | push 2 × `closed` |
| 其它空白 `\s` | push 1 × `closed` |
| 中文字符 `[一-鿿]` | `pinyin-pro` 取拼音 → 主元音 → viseme |
| ASCII 元音字母 `a/e/i/o/u`（不分大小写） | 直接映射到同名 viseme |
| ASCII 辅音字母 | 按出现序号轮换 `['e','i']`，保证有动作 |
| 数字 | `a` |
| 其它字符 | `closed` |

**主元音提取：** 用 `pinyin-pro` 的 `pinyin(char, { toneType: 'none' })` 得到无声调拼音串，按下列优先级扫描，命中第一个即为 viseme：

```
a → a    o → o    e → e    i → i    u → u    ü → u    v → u
```

优先级 `a > o > e > i > u`，覆盖绝大多数复韵母（如 `hao`→a、`xie`→e、`zhong`→o、`ni`→i、`shu`→u）。若拼音串不含任何元音字母（极少数情况），返回 `closed`。

**标点必须插入 closed 停顿**为硬性要求：句末标点产生明显停顿，句中标点产生短停顿，避免整段语音里嘴一刻不停。

空字符串返回 `[]`。

---

## Section 5：LipSyncController

`src/services/lipsync/LipSyncController.ts`：

```ts
export const STEP_INTERVAL = 180  // ms，导出常量，便于调节

export class LipSyncController {
  start(text: string, onViseme: (v: Viseme) => void): void
  stop(): void
}
```

**行为：**

- `start(text, onViseme)`：
  1. 先调用 `this.stop()`（幂等重置，保证不残留旧定时器）。
  2. `sequence = textToVisemes(text)`。若 `sequence` 为空 → `onViseme('closed')` 并返回。
  3. 立即 emit `sequence[0]`（避免开口前有一帧 ~180ms 的空档）。
  4. `setInterval` 每 `STEP_INTERVAL` 推进：emit `sequence[idx % sequence.length]`，`idx++`。
- **循环重播：** 通过 `idx % sequence.length` 实现。序列走完后回到开头继续，保证 TTS 播放期间嘴一直动。
- `stop()`：
  1. 清除 `setInterval`。
  2. **强制 emit `'closed'`**（无论当前处于什么 viseme）。
  3. 清空 `onViseme` 引用、序列、`idx`。
  4. 幂等：重复调用安全。
- 再次 `start()` 会先 `stop()` 旧循环（旧回调收到一次 `closed`），再开始新循环。

**单例：** `src/services/lipsync/index.ts` 导出 `lipSyncController = new LipSyncController()` 及 `LipSyncController` 类本身。

---

## Section 6：Avatar 渲染与 CSS

**组件（`src/components/Avatar/index.tsx`）：**

- 底图 `<img src={characterImg}>` 始终渲染，不切换。
- 嘴部 overlay `<img>` 始终渲染，`src` 按 `useAgentStore(s => s.currentViseme)` 从 6 张 viseme PNG 的 `Record<Viseme, string>` 中选取。idle 时 `currentViseme` 为 `closed`，overlay 显示闭口图。
- 删除原 `<video>` 分支、`videoUrl` / `videoQueueState` / `avatarVideoError` 订阅、`onVideoEnded` prop。
- 保留 mood/pushing 的 body 动画 class（作用于角色容器，与 viseme 无关）。
- **Avatar 不持有全局 controller 生命周期。** Avatar 是常驻组件，其 `useEffect` cleanup 仅作防御性处理：最多 `setCurrentViseme('closed')`，**不调用 `lipSyncController.stop()`**。controller 的 `stop()` 由 `useAI` 负责（见 Section 9 约束 1）。

**CSS（`src/components/Avatar/Avatar.module.css`）：**

overlay 定位由 3 个 CSS 变量控制，定义在容器上、校准一次：

```css
.characterWrap {
  --mouth-x: 50%;   /* overlay 锚点水平位置（相对底图） */
  --mouth-y: 62%;   /* overlay 锚点垂直位置 */
  --mouth-w: 22%;   /* overlay 显示宽度，相对底图宽度 */
}
.mouthOverlay {
  position: absolute;
  left: var(--mouth-x);
  top: var(--mouth-y);
  width: var(--mouth-w);          /* height 由 <img> 按 256:128 自动保持 */
  transform: translate(-50%, -50%);
  pointer-events: none;
}
```

**约束：** overlay 显示尺寸必须由 `--mouth-w` 控制，逻辑层（TS/React）不得写死像素宽高（见 Section 9 约束 2）。`--mouth-x/y/w` 的具体数值需在验收阶段手动校准（见 Section 11）。

---

## Section 7：store 与 useAI 集成

**store（`src/store/agentStore.ts`）：**

```ts
// 新增
currentViseme: Viseme            // initialState: 'closed'
setCurrentViseme: (v: Viseme) => void

// 删除
videoUrl / videoQueueState / avatarVideoError 及 setVideoUrl / setVideoQueueState / setAvatarVideoError
```

`reset()` 把 `currentViseme` 复位为 `'closed'`。

**useAI（`src/hooks/useAI.ts`）：**

- 移除 `useAvatarVideoQueue` 及 `handleVideoEnded` 返回值。
- `sendMessage` 开头：调用 `lipSyncController.stop()`（停掉上一条的口型，见约束 1）。
- AI 回复成功后：`setMood('talking')` → `lipSyncController.start(reply, useAgentStore.getState().setCurrentViseme)` → `ttsProvider.speak(reply)`。
- `speak()` 的 `.then()` 与 `.catch()` 都走同一收尾：`lipSyncController.stop()` + `setMood('idle')`；用 generation 计数防止过期回调覆盖新一轮状态（沿用现有 gen-guard 模式）。
- AI 调用失败（catch 分支）：`lipSyncController.stop()` + `setMood('error')`。

---

## Section 8：腾讯数智人管线移除

彻底移除，不留死代码、不留降级路径：

- **删文件：** `electron/services/TencentDigitalHumanService.ts`、`TencentSigner.ts`、`TencentCosClient.ts`、`avatarVideoHandler.ts`；`src/services/avatarVideo/`（`AvatarVideoProvider.ts`、`TencentAvatarVideoProvider.ts`、`index.ts`）；`src/hooks/useAvatarVideoQueue.ts`；`src/services/textSegmentation.ts`（先 grep 确认无其它消费者）。
- **删测试：** `AvatarVideoProvider.test.ts`、`TencentDigitalHumanService.test.ts`、`TencentSigner.test.ts`、`TencentCosClient.test.ts`、`avatarVideoHandler.test.ts`、`useAvatarVideoQueue.test.ts`、`textSegmentation.test.ts`。
- **改 `electron/main.ts`：** 删除 avatar-video IPC handler 注册及相关 import。
- **改 `electron/preload.ts`：** 删除 avatar-video 相关 `contextBridge` 暴露。
- **改 `src/types/electron.d.ts`：** 删除 avatar-video IPC 类型。
- **改 `shared/types.ts`：** 删除 `AvatarVideoErrorCode`、`VideoQueueState`、`AvatarSegmentProgressEvent`、`AvatarSegmentDoneEvent`、`AvatarSegmentErrorEvent`。
- **改 `.env.example`：** 删除腾讯 / COS 密钥项。
- **改 `package.json`：** 删除 `cos-nodejs-sdk-v5` 依赖。

移除后 `npx tsc --noEmit` 与全量测试必须通过，确认无悬空引用。

---

## Section 9：生命周期与边界约束（强制）

**约束 1 — stop() 时机与强制闭口。** `LipSyncController` 可以循环重播 viseme 序列，但 `useAI` 必须在以下每个时机调用 `lipSyncController.stop()`，且 `stop()` 必须强制 emit `closed`，避免语音结束后嘴还在动：

- `ttsProvider.speak()` 的 Promise **resolve** 时；
- `ttsProvider.speak()` 的 Promise **reject** 时；
- 新问题提交（`sendMessage` 开头）时；
- AI 调用失败（`sendMessage` catch 分支）时。

**controller 生命周期归属：** `stop()` 由 `useAI`（renderer 根级 lifecycle）统一负责。`Avatar` 组件**不**调用 `controller.stop()`——Avatar 常驻，其 `useEffect` cleanup 仅作防御性处理（最多 `setCurrentViseme('closed')`），用于热重载/应用退出等极端情况。

**约束 2 — 显示尺寸由 CSS 变量控制。** 256×128 仅为素材统一画布尺寸；overlay 在屏幕上的显示尺寸必须由 CSS 变量 `--mouth-w` 控制，逻辑层（TS/React）不得写死像素尺寸。

**约束 3 — 不重画整张角色图。** `character.png` 嘴部只要求「与 overlay 不冲突」：若原图已有嘴巴，6 张 viseme overlay 必须能完整遮盖底图嘴部区域；不要求重画整张角色图。

---

## Section 10：测试策略

| 测试文件 | 覆盖点 |
|----------|--------|
| `tests/viseme.test.ts` | 中文字符映射到正确 viseme（`你好`→`['i','a']`）；句末/句中标点插入对应数量 `closed`；空格→`closed`；ASCII 元音直接映射；空串→`[]` |
| `tests/LipSyncController.test.ts` | fake timers：`start()` 立即 emit 首帧；间隔推进；序列走完循环重播；`stop()` 清定时器并强制 emit `closed`；`start()` 后立即 `stop()`（无 interval tick）末帧仍为 `closed`；二次 `start()` 重置 |
| `tests/agentStore.test.ts` | `currentViseme` 初值 `closed`；`setCurrentViseme` 更新；`reset()` 复位；不再有 video 字段 |
| `tests/useAI.test.ts` | `lipSyncController.start` 以 reply 调用；TTS resolve → `stop` 被调用、`currentViseme==='closed'`、mood `idle`；TTS reject 同样收尾；新 `sendMessage` 停掉上一轮；AI 失败 → `stop` + mood `error` |

每完成一个任务即运行该任务相关测试；任务全部完成后跑全量 `npx vitest run` + `npx tsc --noEmit`。

---

## Section 11：分支与验收

**分支：** 从 `feature/realistic-lipsync` 新建 `feature/local-viseme-lipsync`，worktree 置于 `.worktrees/feature-local-viseme-lipsync`。

**自动验收：** 全量 `npx vitest run` 通过；`npx tsc --noEmit` 无错误；`npm run build` 通过。

**手动验收（需运行 app，不可由测试替代）：**

1. `npm run dev`，确认头像正常显示，嘴部 overlay 不偏移、不超出脸部。
2. 校准 `Avatar.module.css` 的 `--mouth-x` / `--mouth-y` / `--mouth-w`，直到 6 张 viseme overlay 都对齐底图嘴部、完整遮盖原嘴巴。
3. 发送消息 → AI 回复后嘴在整段 TTS 期间持续开合 → 语音结束后嘴**立即闭合**、mood 回 `idle`。
4. 回复含标点时，标点处能看到短暂闭口停顿。
5. 快速连发两条消息 → 第二条开始时第一条口型立即停止，不残留。
6. 断网触发 AI error → 嘴闭合、mood `error`。
