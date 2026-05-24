# 数字人教学助手 — 桌面 MVP

一个常驻桌面右下角的 2D 数字人教学助手，面向物理教师备课和课堂资源调用。

## 技术栈

- Electron 28 + Vite 5 + React 18 + TypeScript 5
- Zustand 4（状态管理）
- Vitest（测试）
- electron-builder（打包）

## 快速开始

```bash
npm install
npm run dev        # 开发模式（Vite + Electron 热重载）
npm test           # 运行单元测试
npm run build      # 构建生产包
```

## 项目结构

```
shared/           # 跨进程共享类型（ResourceCard、AIResponse 等）
electron/         # 主进程（main.ts、preload.ts、security.ts）
src/
  components/     # Avatar、ResourceCard、InputBar
  hooks/          # useAI、useAutoResizeWindow
  services/       # AI / ASR / TTS provider 接口 + Mock 实现
  store/          # Zustand agentStore
tests/            # 单元测试（security、MockAI、store、hooks）
```

## 安全设计

- 渲染层不接触文件路径或 Node API
- `openExternal`：仅放行 `http://` / `https://`
- `openResource`：渲染层只传 resourceId，主进程查白名单并做路径遍历检查
- contextIsolation: true，nodeIntegration: false，sandbox: true

## 手动测试清单

- [ ] 启动应用，窗口出现在屏幕右下角
- [ ] 拖动窗口到其他位置
- [ ] 在输入框输入文字，回车提交
- [ ] 数字人进入 thinking 状态，随后 talking 状态，最终回到 idle
- [ ] 资源卡片在数字人下方推送展示
- [ ] 点击外部链接卡片，浏览器打开正确网址
- [ ] 点击本地资源卡片，系统用默认程序打开对应文件
- [ ] 手动关闭单张卡片，其余卡片保留
- [ ] 再次提交，新资源卡片替换旧卡片
- [ ] 模拟 AI 失败（MockAIProvider 抛错），显示 error 状态和重试按钮
- [ ] 点击重试，重新发送上次输入
- [ ] isLoading 期间连续点击提交，不触发重复请求
- [ ] 窗口高度超出时卡片区内部滚动，窗口不超出 maxHeight

## 扩展接口

| 接口 | 位置 | 说明 |
|------|------|------|
| Live2D / VRM | `Avatar/index.tsx` children slot | 替换 CSS 角色渲染 |
| 真实 AI API | `services/ai/index.ts` | 替换 MockAIProvider |
| ASR 语音输入 | `services/asr/` | 实现 ASRProvider 接口 |
| TTS 语音播报 | `services/tts/` | 实现 TTSProvider 接口 |
