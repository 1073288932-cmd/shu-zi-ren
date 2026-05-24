import type { AIResponse, AgentMessage } from '../../shared/types'
import type { ResourceCatalogService } from './resourceCatalog'
import { DeepseekHTTPError } from './mapDeepseekError'

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'

function buildSystemPrompt(catalog: ResourceCatalogService): string {
  return `你是一位物理教学助手，帮助教师备课和课堂资源调用。
根据对话上下文给出简洁专业的回复，并从以下资源库中选出最相关的资源（最多3个）。

资源库：
${catalog.promptSnippet}

严格按以下 JSON 格式返回，不要包含任何其他文字：
{"reply":"你的回复","resourceIds":["id1"]}
如不需要推送资源，resourceIds 返回空数组。`
}

function parseAndMap(rawContent: string, catalog: ResourceCatalogService): AIResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    return { reply: rawContent, resourceCards: [] }
  }

  if (
    typeof parsed !== 'object' || parsed === null ||
    typeof (parsed as Record<string, unknown>).reply !== 'string' ||
    !Array.isArray((parsed as Record<string, unknown>).resourceIds)
  ) {
    return { reply: '我已收到问题，但资源推荐格式解析失败，请重试。', resourceCards: [] }
  }

  const { reply, resourceIds } = parsed as { reply: string; resourceIds: unknown[] }

  const resourceCards = (resourceIds as string[])
    .filter(id => typeof id === 'string' && catalog.cardMap.has(id))
    .slice(0, 3)
    .map(id => catalog.cardMap.get(id)!)

  return { reply, resourceCards }
}

export class DeepseekAIProvider {
  constructor(private readonly apiKey: string) {}

  async chat(messages: AgentMessage[], catalog: ResourceCatalogService): Promise<AIResponse> {
    const response = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: buildSystemPrompt(catalog) }, ...messages],
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) {
      throw new DeepseekHTTPError(response.status)
    }

    const data = await response.json()
    const rawContent: string = (data as { choices: Array<{ message: { content: string } }> })
      .choices?.[0]?.message?.content ?? ''

    return parseAndMap(rawContent, catalog)
  }
}
