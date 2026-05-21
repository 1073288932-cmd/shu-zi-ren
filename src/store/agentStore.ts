import { create } from 'zustand'
import type { AvatarMood, MouthShape, MouthState, AgentMessage, ResourceCard, AppError, VideoQueueState } from '@shared/types'

interface AgentStoreState {
  mood: AvatarMood
  isPushing: boolean
  mouthShape: MouthShape
  speakingIntensity: number
  inputText: string
  isLoading: boolean
  error: AppError | null
  lastUserInput: string
  messages: AgentMessage[]
  resourceCards: ResourceCard[]
  selectedResourceId: string | null
  videoUrl: string | null
  videoQueueState: VideoQueueState
  avatarVideoError: AppError | null

  setMood: (mood: AvatarMood) => void
  setIsPushing: (isPushing: boolean) => void
  setMouthState: (state: MouthState) => void
  setInputText: (text: string) => void
  setIsLoading: (loading: boolean) => void
  setError: (error: AppError | null) => void
  setLastUserInput: (text: string) => void
  addMessage: (message: AgentMessage) => void
  setResourceCards: (cards: ResourceCard[]) => void
  removeResourceCard: (id: string) => void
  setSelectedResourceId: (id: string | null) => void
  setVideoUrl: (url: string | null) => void
  setVideoQueueState: (state: VideoQueueState) => void
  setAvatarVideoError: (error: AppError | null) => void
  reset: () => void
}

export const initialState = {
  mood: 'idle' as AvatarMood,
  isPushing: false,
  mouthShape: 'closed' as MouthShape,
  speakingIntensity: 0,
  inputText: '',
  isLoading: false,
  error: null as AppError | null,
  lastUserInput: '',
  messages: [] as AgentMessage[],
  resourceCards: [] as ResourceCard[],
  selectedResourceId: null as string | null,
  videoUrl: null as string | null,
  videoQueueState: 'idle' as VideoQueueState,
  avatarVideoError: null as AppError | null,
}

export const useAgentStore = create<AgentStoreState>()(set => ({
  ...initialState,

  setMood: mood => set({ mood }),
  setIsPushing: isPushing => set({ isPushing }),
  setMouthState: ({ shape, intensity }) =>
    set({ mouthShape: shape, speakingIntensity: Math.max(0, Math.min(1, intensity)) }),
  setInputText: inputText => set({ inputText }),
  setIsLoading: isLoading => set({ isLoading }),
  setError: error => set({ error }),
  setLastUserInput: lastUserInput => set({ lastUserInput }),
  addMessage: message => set(state => ({ messages: [...state.messages, message] })),
  setResourceCards: resourceCards => set({ resourceCards }),
  removeResourceCard: id =>
    set(state => ({ resourceCards: state.resourceCards.filter(c => c.id !== id) })),
  setSelectedResourceId: selectedResourceId => set({ selectedResourceId }),
  setVideoUrl: videoUrl => set({ videoUrl }),
  setVideoQueueState: videoQueueState => set({ videoQueueState }),
  setAvatarVideoError: avatarVideoError => set({ avatarVideoError }),
  reset: () => set(initialState),
}))
