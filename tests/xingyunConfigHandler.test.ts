// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getXingyunConfig, DEFAULT_GATEWAY } from '../electron/services/xingyunConfigHandler'

describe('getXingyunConfig', () => {
  it('returns not-configured when APP_ID missing', () => {
    const r = getXingyunConfig({ XINGYUN_APP_SECRET: 's' })
    expect(r.configured).toBe(false)
    if (!r.configured) {
      expect(r.missingKey).toBe(true)
      expect(r.errorReason).toContain('XINGYUN_APP_ID')
    }
  })

  it('returns not-configured when APP_SECRET missing', () => {
    const r = getXingyunConfig({ XINGYUN_APP_ID: 'a' })
    expect(r.configured).toBe(false)
  })

  it('returns configured with default gateway when GATEWAY unset', () => {
    const r = getXingyunConfig({ XINGYUN_APP_ID: 'a', XINGYUN_APP_SECRET: 's' })
    expect(r.configured).toBe(true)
    if (r.configured) {
      expect(r.appId).toBe('a')
      expect(r.appSecret).toBe('s')
      expect(r.gatewayServer).toBe(DEFAULT_GATEWAY)
    }
  })

  it('uses custom gateway when provided', () => {
    const r = getXingyunConfig({ XINGYUN_APP_ID: 'a', XINGYUN_APP_SECRET: 's', XINGYUN_GATEWAY_SERVER: 'https://gw.example/x' })
    expect(r.configured && r.gatewayServer).toBe('https://gw.example/x')
  })

  it('errorReason does not contain the secret', () => {
    const r = getXingyunConfig({ XINGYUN_APP_SECRET: 'super-secret' })
    expect(JSON.stringify(r)).not.toContain('super-secret')
  })
})
