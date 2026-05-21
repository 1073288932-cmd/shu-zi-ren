import { describe, it, expect } from 'vitest'
import { signTencentRequest } from '../electron/services/TencentSigner'

describe('TencentSigner', () => {
  it('produces a known good Authorization for a fixed input', () => {
    // Fixture from Tencent docs (官方示例 cvm.tencentcloudapi.com / DescribeInstances)
    const result = signTencentRequest({
      secretId: 'AKIDz8krbsJ5yKBZQpn74WFkmLPx3*******',  // literal fixture strings from Tencent docs
      secretKey: 'Gu5t9xGARNpq86cd98joQYCN3*******',
      service: 'cvm',
      host: 'cvm.tencentcloudapi.com',
      action: 'DescribeInstances',
      version: '2017-03-12',
      region: 'ap-guangzhou',
      timestamp: 1551113065,
      payload: '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}',
    })
    expect(result.authorization).toBe(
      'TC3-HMAC-SHA256 Credential=AKIDz8krbsJ5yKBZQpn74WFkmLPx3*******/2019-02-25/cvm/tc3_request, ' +
      'SignedHeaders=content-type;host, Signature=2230eefd229f582d8b1b891af7107b91597240707d778ab3738f756258d7652c'
    )
  })

  it('uses POST + content-type application/json + host header only', () => {
    const r = signTencentRequest({
      secretId: 'id', secretKey: 'key',
      service: 'ivh', host: 'ivh.tencentcloudapi.com',
      action: 'SubmitTask', version: '2021-03-30', region: 'ap-shanghai',
      timestamp: 1700000000, payload: '{}',
    })
    expect(r.authorization).toMatch(/^TC3-HMAC-SHA256 /)
    expect(r.authorization).toContain('SignedHeaders=content-type;host')
    expect(r.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(r.headers.Host).toBe('ivh.tencentcloudapi.com')
    expect(r.headers['X-TC-Action']).toBe('SubmitTask')
    expect(r.headers['X-TC-Version']).toBe('2021-03-30')
    expect(r.headers['X-TC-Region']).toBe('ap-shanghai')
    expect(r.headers['X-TC-Timestamp']).toBe('1700000000')
  })
})
