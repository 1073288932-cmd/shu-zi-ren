import type {
  AvatarSegmentProgressEvent,
  AvatarSegmentDoneEvent,
  AvatarSegmentErrorEvent,
  AppError,
} from '@shared/types'

export interface AvatarVideoProvider {
  generate(ssml: string): Promise<{ ok: true; jobId: string } | { ok: false; error: AppError }>
  cancel(jobId: string): void
  onProgress(cb: (e: AvatarSegmentProgressEvent) => void): () => void
  onDone(cb: (e: AvatarSegmentDoneEvent) => void): () => void
  onError(cb: (e: AvatarSegmentErrorEvent) => void): () => void
}
