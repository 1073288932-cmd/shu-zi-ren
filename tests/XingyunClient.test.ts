import { afterEach, describe, it, expect, vi } from 'vitest'
import { XingyunClient } from '../src/services/xingyun/XingyunClient'
import type { XmovAvatarOptions, XmovAvatarInstance } from '../src/types/xingyun-sdk'
import type { XingyunConfig } from '@shared/types'

const cfg: XingyunConfig = { appId: 'a', appSecret: 's', gatewayServer: 'wss://gw' }

// 受测试驱动的假 SDK：记下回调，暴露触发器
class FakeSdk implements XmovAvatarInstance {
  opts: XmovAvatarOptions
  speakCalls: Array<[string, boolean, boolean]> = []
  initCalls = 0
  initOptions: Array<{ onDownloadProgress?: (progress: number) => void } | undefined> = []
  interrupted = 0
  idled = 0
  destroyed = 0
  constructor(opts: XmovAvatarOptions) { this.opts = opts }
  init(options?: { onDownloadProgress?: (progress: number) => void }) {
    this.initCalls++
    this.initOptions.push(options)
  }
  speak(ssml: string, s: boolean, e: boolean) { this.speakCalls.push([ssml, s, e]) }
  interactiveidle() { this.interrupted++ }
  idle() { this.idled++ }
  offlineMode() {}
  destroy() { this.destroyed++ }
  // 测试触发器
  emitState(st: string) { this.opts.onStateChange?.(st) }
  emitDownloadProgress(progress: number) { this.initOptions[0]?.onDownloadProgress?.(progress) }
  emitVoice(st: string) { this.opts.onVoiceStateChange?.(st) }
  emitMessage(m: unknown) { this.opts.onMessage?.(m) }
}

function make(): { client: XingyunClient; sdk: () => FakeSdk } {
  let sdk!: FakeSdk
  const client = new XingyunClient((opts) => { sdk = new FakeSdk(opts); return sdk })
  return { client, sdk: () => sdk }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('XingyunClient.open', () => {
  it('constructs SDK with #containerId + config, calls init, resolves on ready state', async () => {
    const { client, sdk } = make()
    const p = client.open(cfg, 'xingyun-stage')
    sdk().emitState('idle')              // 就绪态
    sdk().emitDownloadProgress(100)      // 资源/首屏完成
    await expect(p).resolves.toBeUndefined()
    expect(sdk().opts.containerId).toBe('#xingyun-stage')
    expect(sdk().opts.appId).toBe('a')
    expect(sdk().opts.appSecret).toBe('s')
    expect(sdk().opts.gatewayServer).toBe('wss://gw')
    expect(sdk().initCalls).toBe(1)
    expect(typeof sdk().initOptions[0]?.onDownloadProgress).toBe('function')
    expect(client.isOpen()).toBe(true)
  })

  it('resolves on real Xingyun ready state interactive_idle', async () => {
    const { client, sdk } = make()
    const p = client.open(cfg, 'xingyun-stage')
    sdk().emitState('interactive_idle')
    sdk().emitDownloadProgress(100)
    await expect(p).resolves.toBeUndefined()
    expect(client.isOpen()).toBe(true)
  })

  it('does not resolve on ready state until SDK download/render progress reaches 100', async () => {
    const { client, sdk } = make()
    const p = client.open(cfg, 'xingyun-stage')
    let settled = false
    void p.then(() => { settled = true }, () => { settled = true })
    sdk().emitState('interactive_idle')
    await Promise.resolve()
    expect(settled).toBe(false)
    sdk().emitDownloadProgress(100)
    await expect(p).resolves.toBeUndefined()
  })

  it('rejects XY_CONNECT on fatal onMessage before ready', async () => {
    const { client, sdk } = make()
    const p = client.open(cfg, 'xingyun-stage')
    sdk().emitMessage({ code: 40001, msg: 'auth fail' })
    await expect(p).rejects.toMatchObject({ code: 'XY_CONNECT' })
  })

  it('destroys SDK when connect times out', async () => {
    vi.useFakeTimers()
    const { client, sdk } = make()
    const p = client.open(cfg, 'xingyun-stage')
    const expectation = expect(p).rejects.toMatchObject({ code: 'XY_CONNECT' })
    await vi.advanceTimersByTimeAsync(180_000)
    await expectation
    expect(sdk().destroyed).toBe(1)
    expect(client.isOpen()).toBe(false)
  })
})

describe('XingyunClient.speak', () => {
  async function opened() {
    const h = make()
    const p = h.client.open(cfg, 'xingyun-stage')
    h.sdk().emitState('idle')
    h.sdk().emitDownloadProgress(100)
    await p
    return h
  }

  it('calls SDK.speak with built SSML and resolves "completed" on voice end', async () => {
    const { client, sdk } = await opened()
    const sp = client.speak('你好 < 世界')
    expect(sdk().speakCalls[0]).toEqual(['<speak>你好 &lt; 世界</speak>', true, true])
    sdk().emitVoice('end')
    await expect(sp).resolves.toBe('completed')
  })

  it('interrupt() resolves pending speak "interrupted" BEFORE calling interactiveidle', async () => {
    const { client, sdk } = await opened()
    const sp = client.speak('讲一段话')
    client.interrupt()
    await expect(sp).resolves.toBe('interrupted')
    expect(sdk().interrupted).toBe(1)
  })

  it('idle() asks SDK to stay idle without destroying the avatar', async () => {
    const { client, sdk } = await opened()
    client.idle()
    expect(sdk().idled).toBe(1)
    expect(sdk().destroyed).toBe(0)
  })

  it('destroy() resolves pending speak "interrupted" (never rejects) then destroys', async () => {
    const { client, sdk } = await opened()
    const sp = client.speak('讲一段话')
    client.destroy()
    await expect(sp).resolves.toBe('interrupted')
    expect(sdk().destroyed).toBe(1)
    expect(client.isOpen()).toBe(false)
  })

  it('rejects XY_SPEAK on fatal onMessage during speak', async () => {
    const { client, sdk } = await opened()
    const sp = client.speak('讲一段话')
    sdk().emitMessage({ code: 50004, msg: 'stream error' })
    await expect(sp).rejects.toMatchObject({ code: 'XY_SPEAK' })
  })

  it('ignores non-fatal AUDIO_DATA_EXPIRED (40007) during speak', async () => {
    const { client, sdk } = await opened()
    const sp = client.speak('讲一段话')
    sdk().emitMessage({ code: 40007, message: '音频数据过期' })
    let settled = false
    void sp.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    sdk().emitVoice('end')
    await expect(sp).resolves.toBe('completed')
  })

  it('benign onMessage (no error code) does not settle pending speak', async () => {
    const { client, sdk } = await opened()
    const sp = client.speak('讲一段话')
    sdk().emitMessage({ type: 'subtitle_on' })
    let settled = false
    void sp.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    sdk().emitVoice('end')
    await expect(sp).resolves.toBe('completed')
  })
})
