export interface XmovAvatarOptions {
  containerId: string
  appId: string
  appSecret: string
  gatewayServer: string
  enableLogger?: boolean
  onStateChange?: (state: string) => void
  onVoiceStateChange?: (status: string) => void
  onMessage?: (msg: unknown) => void
  onNetworkInfo?: (info: unknown) => void
}

export interface XmovAvatarInstance {
  init(options?: { onDownloadProgress?: (progress: number) => void }): Promise<void> | void
  speak(ssml: string, isStart: boolean, isEnd: boolean): void
  interactiveidle(): void
  idle(): void
  offlineMode(): void
  destroy(): void
}

declare global {
  interface Window {
    XmovAvatar?: new (options: XmovAvatarOptions) => XmovAvatarInstance
  }
}

export {}
