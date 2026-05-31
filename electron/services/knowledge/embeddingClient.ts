import { EMBEDDING_MODEL } from './types'

const EMBEDDINGS_URL = 'https://api.siliconflow.cn/v1/embeddings'

export class EmbeddingClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const res = await this.fetchImpl(EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`)
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> }
    return data.data.map(d => d.embedding)
  }
}
