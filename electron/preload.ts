import { contextBridge, ipcRenderer } from 'electron'
import type { AppError } from '../shared/types'

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
})
