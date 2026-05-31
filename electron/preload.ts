import { contextBridge, ipcRenderer } from 'electron'
import type { AppError, AIResponse } from '../shared/types'

contextBridge.exposeInMainWorld('electronAPI', {
  resizeWindow(height: number): void {
    ipcRenderer.send('resize-window', height)
  },

  openExternal(url: string): Promise<AppError | undefined> {
    return ipcRenderer.invoke('open-external', url)
  },

  openResource(resourceId: string): Promise<AppError | undefined> {
    return ipcRenderer.invoke('open-resource', resourceId)
  },

  onError(cb: (err: AppError) => void): () => void {
    const handler = (_: unknown, err: AppError) => cb(err)
    ipcRenderer.on('app-error', handler)
    return () => ipcRenderer.removeListener('app-error', handler)
  },

  chat(messages: unknown): Promise<AIResponse | AppError> {
    if (!Array.isArray(messages)) {
      return Promise.resolve({ code: 'INVALID_CHAT_MESSAGES', message: 'Messages must be an array', recoverable: false })
    }
    if (messages.length > 20) {
      return Promise.resolve({ code: 'INVALID_CHAT_MESSAGES', message: 'Too many messages (max 20)', recoverable: false })
    }
    return ipcRenderer.invoke('chat', messages)
  },

  setApiKey(key: string): Promise<AppError | undefined> {
    return ipcRenderer.invoke('set-api-key', key)
  },

  transcribeAudio(buffer: ArrayBuffer): Promise<import('../shared/types').AppError | string> {
    return ipcRenderer.invoke('transcribe-audio', buffer)
  },

  xingyunGetConfig(): Promise<import('../shared/types').XingyunConfigStatus> {
    return ipcRenderer.invoke('xingyun-get-config')
  },
})
