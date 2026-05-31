// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { DeepseekAIProvider } from '../electron/services/DeepseekAIProvider'
import type { Chunk } from '../electron/services/knowledge/types'
import type { ResourceCatalogService } from '../electron/services/resourceCatalog'

const catalog = {
  promptSnippet: '（资源库快照）',
  cardMap: new Map(),
} as unknown as ResourceCatalogService

function captureFetch() {
  const calls: RequestInit[] = []
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(init)
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"reply":"ok","resourceIds":[]}' } }] }),
    } as unknown as Response
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

const hitChunks: Chunk[] = [
  { id: 'c1', text: '摩擦力是阻碍相对运动的力。', textbook: '人教版 八年级下', heading: '8.3 摩擦力' },
]

describe('DeepseekAIProvider with KB retriever', () => {
  it('injects 教材参考资料 into system prompt when retriever hits', async () => {
    const { fetchImpl, calls } = captureFetch()
    const retriever = { retrieve: vi.fn(async () => hitChunks) }
    const provider = new DeepseekAIProvider('sk', retriever, fetchImpl)
    await provider.chat([{ role: 'user', content: '摩擦力是什么' }], catalog)
    expect(retriever.retrieve).toHaveBeenCalledWith('摩擦力是什么')
    const body = JSON.parse(calls[0].body as string)
    expect(body.messages[0].content).toContain('教材参考资料')
    expect(body.messages[0].content).toContain('摩擦力是阻碍相对运动的力。')
  })

  it('falls back to plain prompt when retriever returns []', async () => {
    const { fetchImpl, calls } = captureFetch()
    const retriever = { retrieve: vi.fn(async () => []) }
    const provider = new DeepseekAIProvider('sk', retriever, fetchImpl)
    await provider.chat([{ role: 'user', content: '你好' }], catalog)
    const body = JSON.parse(calls[0].body as string)
    expect(body.messages[0].content).not.toContain('教材参考资料')
  })

  it('works without a retriever (unchanged behavior)', async () => {
    const { fetchImpl, calls } = captureFetch()
    const provider = new DeepseekAIProvider('sk', undefined, fetchImpl)
    const res = await provider.chat([{ role: 'user', content: '你好' }], catalog)
    expect(res.reply).toBe('ok')
    const body = JSON.parse(calls[0].body as string)
    expect(body.messages[0].content).not.toContain('教材参考资料')
  })
})
