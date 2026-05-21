import type { AvatarVideoProvider } from './AvatarVideoProvider'

export class TencentAvatarVideoProvider implements AvatarVideoProvider {
  generate = (ssml: string) => window.electronAPI.generateAvatarSegment(ssml)
  cancel = (jobId: string) => window.electronAPI.cancelAvatarSegment(jobId)
  onProgress = (cb: Parameters<AvatarVideoProvider['onProgress']>[0]) =>
    window.electronAPI.onAvatarSegmentProgress(cb)
  onDone = (cb: Parameters<AvatarVideoProvider['onDone']>[0]) =>
    window.electronAPI.onAvatarSegmentDone(cb)
  onError = (cb: Parameters<AvatarVideoProvider['onError']>[0]) =>
    window.electronAPI.onAvatarSegmentError(cb)
}
