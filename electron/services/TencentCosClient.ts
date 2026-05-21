import crypto from 'crypto'
import COS from 'cos-nodejs-sdk-v5'

export interface CosConfig {
  secretId: string
  secretKey: string
  region: string
  bucket: string
  useSignedUrl: boolean
}

export interface ConfigStore {
  read(): Record<string, unknown>
  write(next: Record<string, unknown>): void
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const RENEW_THRESHOLD_MS = 24 * 60 * 60 * 1000

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export class TencentCosClient {
  private cos: COS

  constructor(private config: CosConfig, private store: ConfigStore) {
    this.cos = new COS({ SecretId: config.secretId, SecretKey: config.secretKey })
  }

  async ensureRefPhotoUrl(imageBuffer: Buffer, now: () => number = () => Date.now()): Promise<string> {
    const currentHash = sha256Hex(imageBuffer)
    const persisted = this.store.read()
    const cachedHash = typeof persisted.avatarImageHash === 'string' ? persisted.avatarImageHash : ''
    const cachedUrl = typeof persisted.avatarRefPhotoUrl === 'string' ? persisted.avatarRefPhotoUrl : ''
    const cachedAt = typeof persisted.avatarUploadedAt === 'number' ? persisted.avatarUploadedAt : 0

    const key = `avatars/character-${currentHash}.png`
    const hashMatched = cachedHash === currentHash && cachedUrl
    const nearExpiry = hashMatched && (now() - cachedAt) >= (SEVEN_DAYS_MS - RENEW_THRESHOLD_MS)

    if (hashMatched && !nearExpiry) {
      const exists = await this.headObject(key)
      if (exists) return cachedUrl
    }

    if (hashMatched && nearExpiry) {
      // Object still there; just renew signed URL without re-upload.
      const exists = await this.headObject(key)
      if (exists) {
        const url = await this.signObjectUrl(key)
        this.store.write({ ...persisted, avatarRefPhotoUrl: url, avatarUploadedAt: now() })
        return url
      }
    }

    // Upload (first time or hash changed or HEAD 404)
    await this.putObject(key, imageBuffer)
    const url = this.config.useSignedUrl
      ? await this.signObjectUrl(key)
      : `https://${this.config.bucket}.cos.${this.config.region}.myqcloud.com/${key}`
    this.store.write({
      ...persisted,
      avatarImageHash: currentHash,
      avatarRefPhotoUrl: url,
      avatarUploadedAt: now(),
    })
    return url
  }

  private putObject(key: string, body: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.cos.putObject(
        { Bucket: this.config.bucket, Region: this.config.region, Key: key, Body: body },
        (err: unknown) => (err ? reject(err) : resolve())
      )
    })
  }

  private headObject(key: string): Promise<boolean> {
    return new Promise(resolve => {
      this.cos.headObject(
        { Bucket: this.config.bucket, Region: this.config.region, Key: key },
        (err: unknown) => resolve(!err)
      )
    })
  }

  private signObjectUrl(key: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.cos.getObjectUrl(
        {
          Bucket: this.config.bucket, Region: this.config.region, Key: key,
          Sign: true,
          Expires: SEVEN_DAYS_MS / 1000,
        },
        (err: unknown, data: { Url: string } | undefined) =>
          err || !data ? reject(err) : resolve(data.Url)
      )
    })
  }
}
