import type { AIProvider } from './AIProvider'
import { MockAIProvider } from './MockAIProvider'

// Swap MockAIProvider for a real implementation when ready
export const aiProvider: AIProvider = new MockAIProvider()
