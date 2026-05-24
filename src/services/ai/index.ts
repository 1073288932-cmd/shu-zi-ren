import type { AIProvider } from './AIProvider'
import { ElectronAIProvider } from './ElectronAIProvider'

export const aiProvider: AIProvider = new ElectronAIProvider()
