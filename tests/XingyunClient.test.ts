import { describe, it, expect } from 'vitest'
import { XingyunClient } from '../src/services/xingyun/XingyunClient'
import type { XmovAvatarOptions, XmovAvatarInstance } from '../src/types/xingyun-sdk'
import type { XingyunConfig } from '@shared/types'

const cfg: XingyunConfig = { appId: 'a', appSecret: 's', gatewayServer: 'wss://gw' }

// 受测试驱动的假 SDK：记下回调，暴露触发器
class FakeSdk implements XmovAvatarInstance {
  opts: XmovAvatarOptions
  speakCalls: Array<[string, boolean, boolean]> = []
  interrupted = 0
  destroyed = 0
  constructor(opts: XmovAvatarOptions) { this.opts = opts }
  speak(ssml: string, s: boolean, e: boolean) { this.speakCalls.push([ssml, s, e]) }
  interactiveidle() { this.interrupted++ }
  idle() {}
  offlineMode() {}
  destroy() { this.destroyed++ }
  // 测试触发器
  emitState(st: string) { this.opts.onStateChange?.(st) }
  emitVoice(st: string) { this.opts.onVoiceStateChange?.(st) }
  emitMessage(m: unknown) { this.opts.onMessage?.(m) }
}

function make(): { client: XingyunClient; sdk: () => FakeSdk } {
  let sdk!: FakeSdk
  const client = new XingyunClient((opts) => { sdk = new FakeSdk(opts); return sdk })
  return { client, sdk: () => sdk }
}

describe('XingyunClient.open', () => {
  it('constructs SDK with #containerId + config, resolves on ready state', async () => {
    const { client, sdk } = make()
    const p = client.open(cfg, 'xingyun-stage')
    sdk().emitState('idle')              // 就绪态
    await expect(p).resolves.toBeUndefined()
    expect(sdk().opts.containerId).toBe('#xingyun-stage')
    expect(sdk().opts.appId).toBe('a')
    expect(sdk().opts.appSecret).toBe('s')
    expect(sdk().opts.gatewayServer).toBe('wss://gw')
    expect(client.isOpen()).toBe(true)
  })

  it('rejects XY_CONNECT on fatal onMessage before ready', async () => {
    const { client, sdk } = make()
    const p = client.open(cfg, 'xingyun-stage')
    sdk().emitMessage({ code: 40001, msg: 'auth fail' })
    await expect(p).rejects.toMatchObject({ code: 'XY_CONNECT' })
  })
})

describe('XingyunClient.speak', () => {
  async function opened() {
    const h = make()
    const p = h.client.open(cfg, 'xingyun-stage')
    h.sdk().emitState('idle')
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
    sdk().emitMessage({ code: 50002, msg: 'stream error' })
    await expect(sp).rejects.toMatchObject({ code: 'XY_SPEAK' })
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
