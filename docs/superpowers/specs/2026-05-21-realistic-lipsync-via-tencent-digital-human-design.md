# 真实人物口型同步（腾讯云数智人）— Design Doc

Date: 2026-05-21
Status: Draft (pending user review)

---

## 背景与动机

前序方案（`2026-05-20-lipsync-avatar.md`）在角色 PNG 上叠加 CSS 嘴型 overlay，模拟说话动画。实测发现：写实/卡通 3D 角色图上的纯色 CSS 元素永远显示为"外加椭圆"，无论调整位置、`mix-blend-mode` 或尺寸，都无法呈现"图中人物本身张嘴"的视觉效果。

本设计放弃 CSS overlay，改用云端数字人 API 真正驱动角色图中的面部像素，让用户提供的卡通男孩角色"亲自"做口型。

---

## 目标

- 用户提问后，AI 回复以**含口型同步的视频**形式播报（角色嘴部真实变化）
- 角色形象保持当前 character.png 不变（卡通 3D 物理教师男孩）
- 首段视频延迟 ≤ 12s，超时自动降级
- 视频生成失败时优雅降级到 Web Speech TTS + 静态 PNG，用户始终能获得回答

## 非目标 (YAGNI)

- 不做视频缓存（同问题二次问答不复用历史视频）
- 不做多角色 / 角色切换 UI
- 不做 SSML 高级标签（停顿、强调、语速控制）
- 不做视频质量参数选择（用服务商默认）
- 不做实时流式生成（一段一段同步生成即可）

---

## 技术选型

**服务商**：腾讯云智能数智人 — **照片免训练**接口
- API: `POST /v2/ivh/videomaker/broadcastservice/phototovideonotrain`
- 文档：https://cloud.tencent.com.cn/document/product/1240/118475
- 接受 JPG/PNG/BMP/WEBP，≤6MB，单边 192–4096px
- 输入：`RefPhotoUrl` (公网图片 URL) + `InputSsml` (≤300 字)
- 异步：返回 TaskId，需轮询「音视频制作进度查询接口」拿 `MediaUrl`（具体 action 名以 plan 阶段核对文档为准）
- 计费按生成视频秒数

**图片托管**：腾讯云 COS（同生态、低延迟）
- 私有桶 + 7 天签名 URL（过期前自动续签）
- 公网读权限作终极兜底（若数智人 API 拒绝签名 URL）

**TTS fallback**：保留现有 `WebSpeechTTSProvider`

---

## 架构总览

### 数据流（成功路径）

```
User 提问
  ↓
Deepseek → reply text (e.g., 600 字)
  ↓
textSegmentation → ["段 1 (240 字)", "段 2 (220 字)", "段 3 (140 字)"]
  ↓
useAvatarVideoQueue.enqueue
  ↓
[Renderer] avatarVideoProvider.generate(段 N)
  ↓ IPC: generateAvatarSegment(ssml) → { jobId }
[Main] TencentDigitalHumanService:
  ├─ submitTask({ RefPhotoUrl, InputSsml }) → TaskId
  │   └─ IPC event: progress(submitting)
  ├─ pollUntilDone(taskId, 1.5s 间隔, 60s 超时) → MediaUrl
  │   └─ IPC event: progress(polling, pollAttempt)
  ├─ fetch(MediaUrl) → ArrayBuffer
  │   └─ IPC event: progress(downloading)
  └─ IPC event: done({ jobId, buffer, mimeType: 'video/mp4' })
  ↓
[Renderer] new Blob([buffer]) → URL.createObjectURL → store.setVideoUrl
  ↓
<video src={videoUrl}> 播放
  ↓ (并发) 提前为段 N+1 调 IPC
  ↓ <video> onended → 切到段 N+1 → revoke 旧 URL
  ↓ 全部段播完 → store.setVideoUrl(null) → 显示静态 PNG → mood='idle'
```

### 段间衔接策略：双缓冲 + 定格

- 段 N 播放时，并发预生成段 N+1（**预生成窗口仅 1 段**，防限流和成本失控）
- 段 N 播完，段 N+1 已就绪 → 立即切换播放
- 段 N 播完，段 N+1 未就绪 → 进入 `stalled` 状态，`<video>` 停在最后一帧 + 头顶轻量 "..." 动画 → 段 N+1 就绪后切换
- 首段超过 **12s** 仍未生成完 → 立即放弃，整轮 fallback 到 Web Speech

### 启动一次性动作：COS 上传

```
app 启动 → 主进程后台执行（不阻塞 UI）：
  1. 读取 userData/config.json
  2. 计算本地 character.png 的 SHA-256
  3. 命中缓存条件：config.avatarImageHash === 当前 hash
       AND HEAD config.refPhotoUrl 返回 2xx
       AND 签名 URL 距过期 > 24h
     → 直接用缓存的 refPhotoUrl，结束
  4. 否则：上传到 COS，object key = `avatars/character-{hash}.png`，
     生成 7 天签名 URL，写入 config.json
  5. 上传失败 → 标记 cosReady=false，发 IPC 通知 renderer
     → 整个 app 永远走 Web Speech fallback（直到重启重试）
```

---

## 文件结构

### 新增

```
electron/services/
  TencentCosClient.ts           # 上传 + hash + HEAD 校验 + 签名 URL 续签
  TencentDigitalHumanService.ts # submitTask + pollUntilDone + fetch (含 AbortSignal)
  avatarVideoHandler.ts         # IPC handler，jobId 管理，progress/done/error 事件

src/services/
  textSegmentation.ts           # 按 。！？切，单段 ≤ MAX_SEGMENT_CHARS=240
  avatarVideo/
    AvatarVideoProvider.ts      # 接口
    TencentAvatarVideoProvider.ts # 调 window.electronAPI
    index.ts                    # 单例
src/hooks/
  useAvatarVideoQueue.ts        # 队列 + 双缓冲 + 状态机 + 熔断器 + revoke
```

### 修改

```
src/components/Avatar/index.tsx     # 渲染 <video> 或 <img>，监听 onended
src/components/Avatar/Avatar.module.css  # 删嘴部 overlay；保留 mood 动画
src/store/agentStore.ts             # 删 mouthShape/speakingIntensity；
                                    # 加 videoUrl/videoQueueState/avatarVideoError
src/hooks/useAI.ts                  # ttsProvider.speak / lipSyncController 替换为 queue.enqueue
electron/preload.ts                 # 暴露 generateAvatarSegment + 三个 on* 订阅
electron/main.ts                    # 注册 avatarVideoHandler + 启动时触发 COS 上传
.env.example                        # 加腾讯云密钥与 COS 配置
shared/types.ts                     # 加 AvatarVideoErrorCode + 相关事件类型
```

### 删除

```
src/services/lipsync/                  # CSS overlay 方案整个废弃
tests/LipSyncController.test.ts        # 对应实现已删
（Avatar.module.css 中嘴部 overlay 样式）
```

### 保留

```
src/services/tts/                      # Web Speech 是 fallback 主体
```

---

## IPC 契约

```ts
// electronAPI (preload 暴露)

generateAvatarSegment(ssml: string):
  Promise<{ ok: true; jobId: string } | { ok: false; error: AppError }>
// 同步返回 jobId 后异步推进度。jobId 用于关联后续事件和 cancel。

cancelAvatarSegment(jobId: string): void
// 立即 abort 主进程中的 in-flight 操作（fetch/poll）

onAvatarSegmentProgress(cb: (e: AvatarSegmentProgressEvent) => void): () => void
onAvatarSegmentDone(cb: (e: AvatarSegmentDoneEvent) => void): () => void
onAvatarSegmentError(cb: (e: AvatarSegmentErrorEvent) => void): () => void
// 全部返回 unsubscribe 函数

// 事件类型
type AvatarSegmentProgressEvent = {
  jobId: string
  stage: 'submitting' | 'polling' | 'downloading'
  pollAttempt?: number  // polling 阶段才有
}

type AvatarSegmentDoneEvent = {
  jobId: string
  buffer: ArrayBuffer
  mimeType: string   // 'video/mp4'
}

type AvatarSegmentErrorEvent = {
  jobId: string
  error: AppError   // 含 code
}
```

**主进程实现要点**：
- 维护 `Map<jobId, AbortController>`，`cancel` 立即 abort 当前 step
- progress 事件节流：每次 stage 切换、polling 每轮一次
- 失败统一转 `AppError`，过 IPC 时序列化为普通 JSON

---

## 状态机（useAvatarVideoQueue）

```
┌──────────┐  enqueue(text)   ┌─────────────┐
│   idle   │ ──────────────▶  │ generating  │
└──────────┘                  └──────┬──────┘
     ▲                               │ 首段 done 事件
     │ 全部段播完                     ▼
     │                          ┌─────────┐
     │              ┌─────────▶ │ playing │
     │              │           └────┬────┘
     │              │                │ ended & next ready
     │              └────────────────┤
     │                               │ ended & next NOT ready
     │                          ┌────▼────┐
     │                          │ stalled │
     │                          └────┬────┘
     │                               │ next ready
     │                          ┌────▼────┐
     │                          │ playing │
     │                          └────┬────┘
     │                               │ 首段 12s 超时 / 任一段技术失败
     │                          ┌────▼─────┐
     │                          │ fallback │ Web Speech 念剩余文本
     │                          └────┬─────┘
     │ Web Speech 念完                │
     └───────────────────────────────┘

  任一阶段收到 POLICY_VIOLATION：
  当前状态 ────────▶ blocked  → UI 显示审核提示，不读原文
                       └─ 下轮 enqueue 自动清除
```

`videoQueueState` 取值：`idle | generating | playing | stalled | fallback | blocked`

---

## 错误分类

```ts
type AvatarVideoErrorCode =
  | 'TENCENT_API_FAIL'   // 通用 API 错误（5xx 等）  → fallback 本轮
  | 'TENCENT_TIMEOUT'    // 60s 轮询超时 / 首段 12s → fallback 本轮
  | 'NETWORK'            // fetch/网络失败           → fallback 本轮
  | 'COS_NOT_READY'      // 启动时 COS 上传失败      → fallback 本轮
  | 'POLICY_VIOLATION'   // 内容审核拒绝             → blocked，不 fallback
```

**`POLICY_VIOLATION` 的 UX**：
- Avatar 区显示静态 PNG（不动）
- 输入栏下方红色提示行："此回答未通过数字人内容审核，请调整提问后重试"
- **不朗读** Deepseek 回复文本
- 输入栏正常可用，下一轮 `enqueue` 自动清除 blocked 并重新尝试视频

---

## 熔断器

`useAvatarVideoQueue` 内 refs：

```ts
const consecutiveFailureCountRef = useRef(0)
const circuitBreakerUntilRef = useRef<number | null>(null)
const CIRCUIT_BREAK_THRESHOLD = 3
const CIRCUIT_BREAK_DURATION_MS = 10 * 60 * 1000  // 10 分钟
```

| 事件 | 计数器 | 熔断器 |
|------|--------|--------|
| 段技术失败（`TENCENT_API_FAIL` / `TIMEOUT` / `NETWORK` / `COS_NOT_READY`） | +1 | 计数 ≥ 3 触发，`now + 10min` |
| `POLICY_VIOLATION` | 不变 | 不触发 |
| 用户主动 cancel（新一轮 / 组件 unmount） | 不变 | 不触发 |
| 首段成功开播 | 归零 | 清空 |
| `enqueue` 入口检查 | — | 在熔断期内直接 Web Speech，不调腾讯 API |

---

## 轮次清理语义

`enqueue(text)` 入口第一步：

```ts
function enqueue(text: string) {
  // 1. 清理上一轮残留（无论是 fallback 还是 blocked）
  setAvatarVideoError(null)
  setVideoQueueState('idle')

  // 2. 检查熔断器
  if (circuitBreakerUntilRef.current && Date.now() < circuitBreakerUntilRef.current) {
    speakViaWebSpeech(text)
    return
  }

  // 3. 正常视频路径
  segmentsRef.current = textSegmentation(text)
  generateSegment(0)
}
```

**关键不变量**：`fallback` 和 `blocked` 都只影响当前轮；熔断器是唯一跨轮持久化的失败状态。

---

## Store 形状（agentStore）

新增：

```ts
videoUrl: string | null            // blob URL；null → 显示静态 PNG
videoQueueState: 'idle' | 'generating' | 'playing' | 'stalled' | 'fallback' | 'blocked'
avatarVideoError: AppError | null  // 仅 blocked / fallback 时有值
```

删除：

```ts
mouthShape, speakingIntensity     // 不再需要
```

**ArrayBuffer 不进 store**——生命周期完全留在 `useAvatarVideoQueue` 内：

```ts
// hook 内部 refs
const segmentsRef = useRef<string[]>([])
const playedCountRef = useRef(0)
const currentJobIdRef = useRef<string | null>(null)
const nextJobIdRef = useRef<string | null>(null)
const nextBufferRef = useRef<ArrayBuffer | null>(null)  // 预生成的 buffer
const currentUrlRef = useRef<string | null>(null)       // 当前 blob URL（用于 revoke）
const firstSegmentTimerRef = useRef<number | null>(null)
const genRef = useRef(0)                                // 取消旧轮的 guard
```

---

## ArrayBuffer / Blob / URL 生命周期

```ts
// 段 N+1 done 事件到达时
const blob = new Blob([event.buffer], { type: event.mimeType })
const newUrl = URL.createObjectURL(blob)
nextBufferRef.current = null   // 不再需要原 buffer

// 段 N 播放 ended 时
const oldUrl = currentUrlRef.current
useAgentStore.setState({ videoUrl: newUrl })
currentUrlRef.current = newUrl
if (oldUrl) URL.revokeObjectURL(oldUrl)
```

**revoke 触发时机**：
1. 切到下一段时（旧 URL）
2. 队列正常结束（最后一段 URL）
3. `cancel()` 调用（所有现存 URL）
4. 组件卸载（useEffect cleanup）

---

## 文本分段（textSegmentation）

```ts
export const MAX_SEGMENT_CHARS = 240
// 240 而非 290/300：给 SSML 标签、标点、腾讯侧计数误差留余量

export function textSegmentation(text: string): string[]
```

规则：
- 按 `。！？` 切分（不切 `，、；`）
- 累计字符数 ≤ MAX_SEGMENT_CHARS 时合并相邻短句
- 单句 > MAX_SEGMENT_CHARS 时按 `，、；` 二次切分
- 仍超长时按字符硬切（极少触发，作兜底）
- 最短保护：合并后段长 < 4 字时与下段合并

---

## 环境变量（.env.example）

```
# 腾讯云数智人 API
TENCENT_SECRET_ID=
TENCENT_SECRET_KEY=
TENCENT_DIGITAL_HUMAN_REGION=ap-shanghai     # 视频服务区域

# 腾讯云 COS（图片托管）
TENCENT_COS_REGION=ap-shanghai
TENCENT_COS_BUCKET=                          # 用户创建的桶名
TENCENT_COS_USE_SIGNED_URL=true              # false → 用公网读 URL
```

密钥仅主进程读取，不通过 IPC 传给 renderer，与现有 Deepseek/SiliconFlow 密钥模式一致。

---

## 测试策略

| 模块 | 测试类型 | 关键 case |
|------|----------|-----------|
| `textSegmentation` | 纯函数单测 | 标点拆分、240 字裕度、英文混杂、最短保护、无标点超长兜底 |
| `TencentCosClient` | fetch mock | 首传成功、hash 命中跳过、HEAD 404 重传、签名 URL 续签 |
| `TencentDigitalHumanService` | fetch mock | submit → taskId、polling 在 progress=100 停止、60s 超时、`POLICY_VIOLATION` 错误码识别、AbortSignal 中断 |
| `avatarVideoHandler` | IPC 集成测 | 完整流程发出 submitting/polling/downloading/done、cancel 中断 in-flight、错误事件携带 AppError |
| `useAvatarVideoQueue` | RTL + fake timer | 双缓冲串播、12s 首段超时 → fallback、ended 后 next 未就绪 → stalled、blocked 不调 Web Speech、熔断 3 次后入口直接 Web Speech、cancel 清理所有 URL、用户 cancel 不计入熔断 |
| `Avatar` 组件 | RTL 渲染 | state 切换 PNG ↔ video、blocked 文案、onended 触发 hook |
| 端到端 | 真 API | 一次问答全流程、长回复多段、用户中断、断网恢复、审核失败 |

---

## 风险与未决事项

1. **视频文件大小**：240 字 SSML ≈ 20–30s mp4 ≈ 3–5 MB。一轮 3 段 ≈ 10–15 MB 内存峰值。**MVP 实测**。
2. **物理公式 SSML 念法**：`F=ma`、`m/s²`、`牛顿·秒` 等符号腾讯 TTS 处理未知。可能需要 SSML 规整层（`=` → "等于"、`²` → "平方"）。**记为 follow-up**。
3. **段间停顿听感**：按句切会在段间产生 0.5–2s 沉默。如果听感断裂明显，改为按段落切。**MVP 用句切**。
4. **用户中断成本**：cancel 不退还已付费的 API 调用。**记入文档提醒**。
5. **首启动延迟**：COS 上传不阻塞 UI，未就绪时入口直接走 Web Speech fallback。
6. **签名 URL vs 公网读**：MVP 默认签名 URL；若实测腾讯 API 拒绝签名 URL，切公网读（配置可切）。
7. **腾讯云 SDK 选型**：COS 用 `cos-nodejs-sdk-v5`；数智人 API 用 `tencentcloud-sdk-nodejs` 或直调 HTTP（待 plan 阶段决定）。

---

## 与现有代码的关系

| 现有产物 | 处置 |
|----------|------|
| `feature/mvp-implementation` 分支（含 CSS overlay 方案） | 用户已声明"保持现状"，作为历史保留；不合并入 main |
| 本设计实现 | 在新分支 `feature/realistic-lipsync` 上从 main 起步，将本设计的所有删除项与新增项一并落地 |
| `src/services/tts/WebSpeechTTSProvider.ts` | 保留并复用为 fallback 主体 |
| 现有 `agentStore` 中 mood/error/resourceCards 字段 | 保留不变 |

---

## 验收标准

1. 启动 app，COS 上传完成（首次需 1–3s），后台日志确认 refPhotoUrl 持久化
2. 提问一条简短问题（< 240 字回复），≤ 12s 内角色开始视频播报，嘴部真实变化
3. 提问一条长问题（> 600 字回复），首段开播后段间衔接平滑（最多 1 次定格 < 2s）
4. 拔网模拟：腾讯 API 不可达 → 12s 后回退 Web Speech，角色显示静态 PNG
5. 连续制造 3 轮失败：第 4 轮直接走 Web Speech 不调腾讯 API；10 分钟后恢复尝试
6. 触发审核失败（输入显然违规内容）：显示红色审核提示，不朗读
7. 视频播放中提下一题：上一段视频立即停止，blob URL revoke，开始新一轮
8. 单元测试 + IPC 集成测全部通过
