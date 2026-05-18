import type { AIProvider } from './AIProvider'
import type { AIResponse, AgentMessage } from '@shared/types'

export class MockAIProvider implements AIProvider {
  shouldFail = false

  async chat(messages: AgentMessage[]): Promise<AIResponse> {
    if (this.shouldFail) throw new Error('Mock AI failure')

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 800))

    const lastContent = messages[messages.length - 1]?.content ?? '您的问题'

    return {
      reply: `关于「${lastContent}」：摩擦力是两个接触面之间的相互作用力，方向与运动趋势相反。生活中常见例子有刹车、握手机等。`,
      resourceCards: [
        {
          id: 'res-ext-001',
          kind: 'external',
          title: '摩擦力演示实验',
          type: 'video',
          description: '直观展示静摩擦力与滑动摩擦力的差异',
          url: 'https://phet.colorado.edu/sims/html/friction/latest/friction_zh_CN.html',
          tags: ['摩擦力', '实验', '演示'],
        },
        {
          id: 'res-ext-002',
          kind: 'external',
          title: '课堂导入案例',
          type: 'link',
          description: '滑动摩擦力的生活化引入设计',
          url: 'https://example.com/friction-intro',
          tags: ['备课', '导入', '摩擦力'],
        },
        {
          id: 'res-local-001',
          kind: 'local',
          title: '滑动摩擦力课件',
          type: 'doc',
          description: '含易错点分析与课堂追问设计',
          tags: ['课件', '易错点', '摩擦力'],
        },
      ],
    }
  }
}
