// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createCatalog } from '../electron/services/resourceCatalog'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true })
})

function writeCatalog(content: object): string {
  const p = path.join(tmpDir, 'catalog.json')
  fs.writeFileSync(p, JSON.stringify(content))
  return p
}

const validCatalog = {
  version: '1.0.0',
  resources: [
    { id: 'res-ext-001', kind: 'external', title: 'PhET', type: 'video', description: 'desc', url: 'https://example.com', tags: ['tag1'] },
    { id: 'res-local-001', kind: 'local', title: 'Book', type: 'doc', description: 'local desc', tags: [] },
  ],
}

describe('createCatalog', () => {
  it('loads a valid catalog and returns cardMap with correct size', () => {
    const p = writeCatalog(validCatalog)
    const catalog = createCatalog(p)
    expect(catalog.cardMap.size).toBe(2)
    expect(catalog.cardMap.get('res-ext-001')?.title).toBe('PhET')
    expect(catalog.cardMap.get('res-local-001')?.kind).toBe('local')
  })

  it('promptSnippet contains id, title, description but NOT url or file path', () => {
    const p = writeCatalog({
      version: '1.0.0',
      resources: [
        { id: 'res-ext-001', kind: 'external', title: 'PhET Test', type: 'video', description: 'great demo', url: 'https://secret-url.com/resource', tags: ['tag'] },
      ],
    })
    const catalog = createCatalog(p)
    expect(catalog.promptSnippet).toContain('[res-ext-001]')
    expect(catalog.promptSnippet).toContain('PhET Test')
    expect(catalog.promptSnippet).toContain('great demo')
    expect(catalog.promptSnippet).not.toContain('https://secret-url.com')
    expect(catalog.promptSnippet).not.toContain('/Users/')
  })

  it('validateLocalIds returns empty array when all local ids in whitelist', () => {
    const p = writeCatalog(validCatalog)
    const catalog = createCatalog(p)
    const whitelist = new Map([['res-local-001', '/path/to/file.pdf']])
    expect(catalog.validateLocalIds(whitelist)).toEqual([])
  })

  it('validateLocalIds returns missing local ids', () => {
    const p = writeCatalog({
      version: '1.0.0',
      resources: [
        { id: 'res-local-001', kind: 'local', title: 'A', type: 'doc', description: 'a', tags: [] },
        { id: 'res-local-002', kind: 'local', title: 'B', type: 'doc', description: 'b', tags: [] },
      ],
    })
    const catalog = createCatalog(p)
    const whitelist = new Map([['res-local-001', '/path/to/file.pdf']])
    expect(catalog.validateLocalIds(whitelist)).toEqual(['res-local-002'])
  })

  it('validateLocalIds ignores external resources', () => {
    const p = writeCatalog({
      version: '1.0.0',
      resources: [
        { id: 'res-ext-001', kind: 'external', title: 'X', type: 'link', description: 'd', url: 'https://x.com', tags: [] },
      ],
    })
    const catalog = createCatalog(p)
    expect(catalog.validateLocalIds(new Map())).toEqual([])
  })

  it('throws on duplicate id', () => {
    const p = writeCatalog({
      version: '1.0.0',
      resources: [
        { id: 'dup', kind: 'external', title: 'A', type: 'video', description: 'd', url: 'https://a.com', tags: [] },
        { id: 'dup', kind: 'external', title: 'B', type: 'video', description: 'd', url: 'https://b.com', tags: [] },
      ],
    })
    expect(() => createCatalog(p)).toThrow('Duplicate id')
  })

  it('throws when external resource is missing url', () => {
    const p = writeCatalog({
      version: '1.0.0',
      resources: [
        { id: 'res-ext-001', kind: 'external', title: 'T', type: 'video', description: 'd', tags: [] },
      ],
    })
    expect(() => createCatalog(p)).toThrow('missing url')
  })

  it('throws when local resource has url field', () => {
    const p = writeCatalog({
      version: '1.0.0',
      resources: [
        { id: 'res-local-001', kind: 'local', title: 'T', type: 'doc', description: 'd', url: 'https://x.com', tags: [] },
      ],
    })
    expect(() => createCatalog(p)).toThrow('must not have url')
  })

  it('throws on invalid kind', () => {
    const p = writeCatalog({
      version: '1.0.0',
      resources: [
        { id: 'res-001', kind: 'cloud', title: 'T', type: 'video', description: 'd', tags: [] },
      ],
    })
    expect(() => createCatalog(p)).toThrow('Invalid kind')
  })

  it('throws on invalid type', () => {
    const p = writeCatalog({
      version: '1.0.0',
      resources: [
        { id: 'res-001', kind: 'external', title: 'T', type: 'quiz', description: 'd', url: 'https://x.com', tags: [] },
      ],
    })
    expect(() => createCatalog(p)).toThrow('Invalid type')
  })
})
