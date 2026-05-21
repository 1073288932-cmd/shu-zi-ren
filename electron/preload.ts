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

  generateAvatarSegment(ssml: string): Promise<{ ok: true; jobId: string } | { ok: false; error: AppError }> {
    return ipcRenderer.invoke('avatar-video:generate', ssml)
  },

  cancelAvatarSegment(jobId: string): void {
    ipcRenderer.send('avatar-video:cancel', jobId)
  },

  onAvatarSegmentProgress(cb: (e: import('../shared/types').AvatarSegmentProgressEvent) => void): () => void {
    const handler = (_: unknown, e: import('../shared/types').AvatarSegmentProgressEvent) => cb(e)
    ipcRenderer.on('avatar-video:progress', handler)
    return () => ipcRenderer.removeListener('avatar-video:progress', handler)
  },

  onAvatarSegmentDone(cb: (e: import('../shared/types').AvatarSegmentDoneEvent) => void): () => void {
    const handler = (_: unknown, e: import('../shared/types').AvatarSegmentDoneEvent) => cb(e)
    ipcRenderer.on('avatar-video:done', handler)
    return () => ipcRenderer.removeListener('avatar-video:done', handler)
  },

  onAvatarSegmentError(cb: (e: import('../shared/types').AvatarSegmentErrorEvent) => void): () => void {
    const handler = (_: unknown, e: import('../shared/types').AvatarSegmentErrorEvent) => cb(e)
    ipcRenderer.on('avatar-video:error', handler)
    return () => ipcRenderer.removeListener('avatar-video:error', handler)
  },
})
