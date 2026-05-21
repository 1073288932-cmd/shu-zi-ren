import crypto from 'crypto'

/**
 * TC3-HMAC-SHA256 signing for Tencent Cloud APIs.
 *
 * @electron-main-process-only
 * The returned headers include `Host`, which is a forbidden header in browser
 * fetch() calls. This module must only be used in the Electron main process.
 * Importing it in a renderer would silently drop `Host` and cause a signature
 * mismatch at the Tencent API server.
 */
export interface SignTencentRequestInput {
  secretId: string
  secretKey: string
  service: string         // e.g., 'ivh'
  host: string            // e.g., 'ivh.tencentcloudapi.com'
  action: string          // e.g., 'SubmitTask'
  version: string         // e.g., '2021-03-30'
  region: string          // e.g., 'ap-shanghai'
  timestamp: number       // Unix seconds
  payload: string         // JSON-stringified body
}

export interface SignTencentRequestResult {
  authorization: string
  headers: Record<string, string>
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex')
}

function hmac(key: Buffer | string, msg: string): Buffer {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest()
}

export function signTencentRequest(input: SignTencentRequestInput): SignTencentRequestResult {
  const { secretId, secretKey, service, host, action, version, region, timestamp, payload } = input
  if (timestamp > 1e12) throw new Error('timestamp must be Unix seconds, not milliseconds')
  const date = new Date(timestamp * 1000).toISOString().substring(0, 10)  // YYYY-MM-DD UTC

  // Step 1: Canonical request
  const httpRequestMethod = 'POST'
  const canonicalUri = '/'
  const canonicalQueryString = ''
  const canonicalHeaders =
    `content-type:application/json; charset=utf-8\n` +
    `host:${host}\n`
  const signedHeaders = 'content-type;host'
  const hashedRequestPayload = sha256Hex(payload)
  const canonicalRequest =
    `${httpRequestMethod}\n${canonicalUri}\n${canonicalQueryString}\n` +
    `${canonicalHeaders}\n${signedHeaders}\n${hashedRequestPayload}`

  // Step 2: String to sign
  const algorithm = 'TC3-HMAC-SHA256'
  const credentialScope = `${date}/${service}/tc3_request`
  const hashedCanonicalRequest = sha256Hex(canonicalRequest)
  const stringToSign =
    `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`

  // Step 3: Signature
  const secretDate = hmac(`TC3${secretKey}`, date)
  const secretService = hmac(secretDate, service)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex')

  // Step 4: Authorization
  const authorization =
    `${algorithm} Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    authorization,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      Host: host,
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Region': region,
      'X-TC-Timestamp': String(timestamp),
    },
  }
}
