import fs from 'fs'
import type { ResourceCard } from '../../shared/types'

export interface ResourceCatalogService {
  readonly cardMap: ReadonlyMap<string, ResourceCard>
  readonly promptSnippet: string
  validateLocalIds(whitelist: Map<string, string>): string[]
}

const VALID_KINDS = new Set(['external', 'local'])
const VALID_TYPES = new Set(['video', 'doc', 'exercise', 'experiment', 'link'])

export function createCatalog(catalogPath: string): ResourceCatalogService {
  const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  const resources: Array<Record<string, unknown>> = raw.resources

  const seenIds = new Set<string>()
  const cardMap = new Map<string, ResourceCard>()
  const snippetLines: string[] = []

  for (const entry of resources) {
    const { id, kind, title, type, description, url, tags } = entry as {
      id: string; kind: string; title: string; type: string;
      description: string; url?: string; tags: string[]
    }

    if (seenIds.has(id)) throw new Error(`Duplicate id: ${id}`)
    if (!VALID_KINDS.has(kind)) throw new Error(`Invalid kind: ${kind}`)
    if (!VALID_TYPES.has(type)) throw new Error(`Invalid type: ${type}`)
    if (kind === 'external' && !url) throw new Error(`External resource ${id} missing url`)
    if (kind === 'local' && url !== undefined) throw new Error(`Local resource ${id} must not have url`)

    seenIds.add(id)

    const card: ResourceCard = kind === 'external'
      ? { id, kind: 'external', title, type: type as ResourceCard['type'], description, url: url!, tags }
      : { id, kind: 'local', title, type: type as ResourceCard['type'], description, tags }

    cardMap.set(id, card)

    const tagStr = tags.map(t => `#${t}`).join(' ')
    snippetLines.push(`[${id}] ${title} — ${description} ${tagStr}`)
  }

  return {
    cardMap,
    promptSnippet: snippetLines.join('\n'),
    validateLocalIds(whitelist: Map<string, string>): string[] {
      const missing: string[] = []
      for (const [id, card] of cardMap) {
        if (card.kind === 'local' && !whitelist.has(id)) missing.push(id)
      }
      return missing
    },
  }
}
