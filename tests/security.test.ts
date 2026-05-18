// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { validateExternalUrl, checkResourcePath } from '../electron/security'

const BASE_DIR = '/safe/resources'

const whitelist = new Map<string, string>([
  ['res-001', '/safe/resources/video.mp4'],
  ['res-002', '/safe/resources/slides.pdf'],
])

describe('validateExternalUrl', () => {
  it('allows http URLs', () => {
    expect(validateExternalUrl('http://example.com')).toBeNull()
  })

  it('allows https URLs', () => {
    expect(validateExternalUrl('https://example.com/path?q=1')).toBeNull()
  })

  it('rejects file:// protocol', () => {
    const err = validateExternalUrl('file:///etc/passwd')
    expect(err).not.toBeNull()
    expect(err!.code).toBe('PROTOCOL_NOT_ALLOWED')
    expect(err!.recoverable).toBe(false)
  })

  it('rejects javascript: protocol', () => {
    const err = validateExternalUrl('javascript:alert(1)')
    expect(err).not.toBeNull()
    expect(err!.code).toBe('PROTOCOL_NOT_ALLOWED')
  })

  it('rejects data: protocol', () => {
    const err = validateExternalUrl('data:text/html,<h1>x</h1>')
    expect(err).not.toBeNull()
    expect(err!.code).toBe('PROTOCOL_NOT_ALLOWED')
  })

  it('rejects ftp: protocol', () => {
    const err = validateExternalUrl('ftp://files.example.com')
    expect(err).not.toBeNull()
    expect(err!.code).toBe('PROTOCOL_NOT_ALLOWED')
  })

  it('rejects malformed URLs', () => {
    const err = validateExternalUrl('not a url')
    expect(err).not.toBeNull()
    expect(err!.code).toBe('INVALID_URL')
  })
})

describe('checkResourcePath', () => {
  it('returns targetPath for valid resource id', () => {
    const result = checkResourcePath('res-001', whitelist, BASE_DIR)
    expect('targetPath' in result).toBe(true)
    if ('targetPath' in result) {
      expect(result.targetPath).toBe('/safe/resources/video.mp4')
    }
  })

  it('rejects unknown resource id', () => {
    const result = checkResourcePath('unknown-id', whitelist, BASE_DIR)
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error.code).toBe('RESOURCE_NOT_ALLOWED')
    }
  })

  it('rejects path traversal via relative segments', () => {
    const traversalWhitelist = new Map([
      ['bad', '/safe/resources/../../etc/passwd'],
    ])
    const result = checkResourcePath('bad', traversalWhitelist, BASE_DIR)
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error.code).toBe('RESOURCE_NOT_ALLOWED')
    }
  })

  it('rejects path that escapes base dir even after normalize', () => {
    const traversalWhitelist = new Map([
      ['escape', '/safe/other/file.pdf'],
    ])
    const result = checkResourcePath('escape', traversalWhitelist, BASE_DIR)
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error.code).toBe('RESOURCE_NOT_ALLOWED')
    }
  })
})
