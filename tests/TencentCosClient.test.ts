import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TencentCosClient, type CosConfig, type ConfigStore } from '../electron/services/TencentCosClient'

const mockPutObject = vi.fn()
const mockGetObjectUrl = vi.fn()
const mockHeadObject = vi.fn()

vi.mock('cos-nodejs-sdk-v5', () => ({
  default: class MockCOS {
    putObject = (...args: unknown[]) => mockPutObject(...args)
    getObjectUrl = (...args: unknown[]) => mockGetObjectUrl(...args)
    headObject = (...args: unknown[]) => mockHeadObject(...args)
  },
}))

const RENEW_THRESHOLD_MS = 24 * 60 * 60 * 1000

function makeStore(initial: Record<string, unknown> = {}): ConfigStore {
  let data = { ...initial }
  return {
    read: vi.fn(() => ({ ...data })),
    write: vi.fn((next: Record<string, unknown>) => { data = { ...next } }),
  }
}

const config: CosConfig = {
  secretId: 'id', secretKey: 'key',
  region: 'ap-shanghai', bucket: 'bkt-12345',
  useSignedUrl: true,
}

const buffer = Buffer.from([0xAA, 0xBB, 0xCC])

import crypto from 'crypto'
function sha256(b: Buffer) { return crypto.createHash('sha256').update(b).digest('hex') }

describe('TencentCosClient.ensureRefPhotoUrl', () => {
  beforeEach(() => {
    mockPutObject.mockReset()
    mockGetObjectUrl.mockReset()
    mockHeadObject.mockReset()
  })

  it('uploads on first call and persists hash + signedUrl', async () => {
    mockPutObject.mockImplementation((_p, cb) => cb(null, { ETag: 'tag' }))
    mockGetObjectUrl.mockImplementation((_p, cb) => cb(null, { Url: 'https://signed-url' }))
    const store = makeStore({})
    const client = new TencentCosClient(config, store)

    const url = await client.ensureRefPhotoUrl(buffer, () => 1700000000_000)

    expect(url).toBe('https://signed-url')
    const expectedKey = `avatars/character-${sha256(buffer)}.png`
    expect(mockPutObject).toHaveBeenCalledWith(
      expect.objectContaining({ Bucket: 'bkt-12345', Key: expectedKey, Body: buffer }),
      expect.any(Function)
    )
    expect(store.write).toHaveBeenCalledWith(expect.objectContaining({
      avatarRefPhotoUrl: 'https://signed-url',
      avatarImageHash: sha256(buffer),
      avatarUploadedAt: 1700000000_000,
    }))
  })

  it('reuses cached URL when hash matches, HEAD succeeds, and URL not near expiry', async () => {
    mockHeadObject.mockImplementation((_p, cb) => cb(null, { statusCode: 200 }))
    const store = makeStore({
      avatarRefPhotoUrl: 'https://cached',
      avatarImageHash: sha256(buffer),
      avatarUploadedAt: Date.now() - 1 * 60 * 60 * 1000,  // 1h ago, far from 7d expiry
    })
    const client = new TencentCosClient(config, store)

    const url = await client.ensureRefPhotoUrl(buffer, () => Date.now())

    expect(url).toBe('https://cached')
    expect(mockPutObject).not.toHaveBeenCalled()
  })

  it('re-uploads when image hash changed', async () => {
    mockPutObject.mockImplementation((_p, cb) => cb(null, { ETag: 'tag' }))
    mockGetObjectUrl.mockImplementation((_p, cb) => cb(null, { Url: 'https://new-url' }))
    const store = makeStore({
      avatarRefPhotoUrl: 'https://old',
      avatarImageHash: 'differenthash',
      avatarUploadedAt: Date.now(),
    })
    const client = new TencentCosClient(config, store)

    const url = await client.ensureRefPhotoUrl(buffer, () => Date.now())
    expect(url).toBe('https://new-url')
    expect(mockPutObject).toHaveBeenCalled()
  })

  it('renews signed URL when within 24h of 7-day expiry', async () => {
    mockHeadObject.mockImplementation((_p, cb) => cb(null, { statusCode: 200 }))
    mockGetObjectUrl.mockImplementation((_p, cb) => cb(null, { Url: 'https://renewed' }))
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    const now = Date.now()
    const store = makeStore({
      avatarRefPhotoUrl: 'https://stale',
      avatarImageHash: sha256(buffer),
      avatarUploadedAt: now - (sevenDays - RENEW_THRESHOLD_MS / 2),  // < 24h to expiry
    })
    const client = new TencentCosClient(config, store)

    const url = await client.ensureRefPhotoUrl(buffer, () => now)
    expect(url).toBe('https://renewed')
    expect(mockPutObject).not.toHaveBeenCalled()  // hash matched, no re-upload
    expect(mockGetObjectUrl).toHaveBeenCalled()   // renew called
  })

  it('re-uploads when HEAD returns 404 even if hash matches', async () => {
    mockHeadObject.mockImplementation((_p, cb) => cb({ statusCode: 404 }, null))
    mockPutObject.mockImplementation((_p, cb) => cb(null, { ETag: 'tag' }))
    mockGetObjectUrl.mockImplementation((_p, cb) => cb(null, { Url: 'https://recovered' }))
    const store = makeStore({
      avatarRefPhotoUrl: 'https://gone',
      avatarImageHash: sha256(buffer),
      avatarUploadedAt: Date.now(),
    })
    const client = new TencentCosClient(config, store)

    const url = await client.ensureRefPhotoUrl(buffer, () => Date.now())
    expect(url).toBe('https://recovered')
    expect(mockPutObject).toHaveBeenCalled()
  })

  it('throws on putObject failure', async () => {
    mockPutObject.mockImplementation((_p, cb) => cb(new Error('cos down'), null))
    const store = makeStore({})
    const client = new TencentCosClient(config, store)

    await expect(client.ensureRefPhotoUrl(buffer, () => Date.now())).rejects.toThrow('cos down')
  })
})
