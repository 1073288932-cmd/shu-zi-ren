import type { Chunk } from './types'

export function buildKbContext(chunks: Chunk[]): string {
  if (chunks.length === 0) return ''
  const refs = chunks
    .map(c => `【${c.textbook} · ${c.heading}】${c.text}`)
    .join('\n')
  return `以下是与当前问题相关的教材参考资料（仅供你参考，按相关度排序）：
${refs}

作答要求：
1. 教材优先——优先依据上述教材的内容、定义、术语和讲法作答；
2. 可补充——教材未覆盖的点可用通识适度补充，但以教材为准，不编造教材中不存在的内容；
3. 不过度超纲——贴合教材所在学段的深度，不引入明显超出该学段的概念或推导；
4. 不暴露检索过程——绝不在回答里提及"教材参考资料/片段/相似度/检索/章节编号"等字样，也不要罗列出处；自然作答。`
}
