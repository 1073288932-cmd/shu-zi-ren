import { create } from 'zustand'
import type {
  AvatarMood, AgentMessage, ResourceCard, AppError, Viseme,
  RenderMode, CloudConnectionState,
} from '@shared/types'

interface AgentStoreState {
  mood: AvatarMood
  isPushing: boolean
  inputText: string
  isLoading: boolean
  error: AppError | null
  lastUserInput: string
  messages: AgentMessage[]
  resourceCards: ResourceCard[]
  selectedResourceId: string | null
  currentViseme: Viseme
  // 魔珐 cloud-mode
  renderMode: RenderMode
  cloudConn: CloudConnectionState
  cloudLastError: string | null

  setMood: (mood: AvatarMood) => void
  setIsPushing: (isPushing: boolean) => void
  setInputText: (text: string) => void
  setIsLoading: (loading: boolean) => void
  setError: (error: AppError | null) => void
  setLastUserInput: (text: string) => void
  addMessage: (message: AgentMessage) => void
  setResourceCards: (cards: ResourceCard[]) => void
  removeResourceCard: (id: string) => void
  setSelectedResourceId: (id: string | null) => void
  setCurrentViseme: (viseme: Viseme) => void
  // 魔珐 cloud-mode
  setRenderMode: (mode: RenderMode) => void
  setCloudConn: (state: CloudConnectionState) => void
  setCloudError: (msg: string | null) => void
  reset: () => void
}

export const initialState = {
  mood: 'idle' as AvatarMood,
  isPushing: false,
  inputText: '',
  isLoading: false,
  error: null as AppError | null,
  lastUserInput: '',
  messages: [] as AgentMessage[],
  resourceCards: [] as ResourceCard[],
  selectedResourceId: null as string | null,
  currentViseme: 'closed' as Viseme,
  renderMode: 'cloud' as RenderMode,
  cloudConn: 'idle' as CloudConnectionState,
  cloudLastError: null as string | null,
}

export const useAgentStore = create<AgentStoreState>()(set => ({
  ...initialState,

  setMood: mood => set({ mood }),
  setIsPushing: isPushing => set({ isPushing }),
  setInputText: inputText => set({ inputText }),
  setIsLoading: isLoading => set({ isLoading }),
  setError: error => set({ error }),
  setLastUserInput: lastUserInput => set({ lastUserInput }),
  addMessage: message => set(state => ({ messages: [...state.messages, message] })),
  setResourceCards: resourceCards => set({ resourceCards }),
  removeResourceCard: id =>
    set(state => ({ resourceCards: state.resourceCards.filter(c => c.id !== id) })),
  setSelectedResourceId: selectedResourceId => set({ selectedResourceId }),
  setCurrentViseme: currentViseme => set({ currentViseme }),

  // setRenderMode('local') 必须同步重置 currentViseme（spec Section 1 强制不变量）
  setRenderMode: mode => set(mode === 'local'
    ? { renderMode: 'local', currentViseme: 'closed' as Viseme }
    : { renderMode: 'cloud' }),
  setCloudConn: cloudConn => set({ cloudConn }),
  setCloudError: cloudLastError => set({ cloudLastError }),
  reset: () => set(initialState),
}))
