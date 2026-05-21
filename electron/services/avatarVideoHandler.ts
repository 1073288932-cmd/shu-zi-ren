import type { AppError, AvatarSegmentProgressEvent, AvatarSegmentDoneEvent, AvatarSegmentErrorEvent } from '../../shared/types'

const MAX_SSML_CHARS = 300
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

export type ValidateResult<T> = { ok: true; value: T } | { ok: false; error: AppError }

export function validateSsml(input: unknown): ValidateResult<string> {
  if (typeof input !== 'string') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'ssml must be a string', recoverable: false } }
  }
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'ssml is empty', recoverable: false } }
  }
  if (trimmed.length > MAX_SSML_CHARS) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: `ssml exceeds ${MAX_SSML_CHARS} chars`, recoverable: false } }
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'ssml contains control characters', recoverable: false } }
  }
  return { ok: true, value: trimmed }
}

export interface JobDeps {
  getRefPhotoUrl: () => Promise<string>
  submitTask: (refPhotoUrl: string, ssml: string, signal: AbortSignal) => Promise<string>
  pollUntilDone: (taskId: string, signal: AbortSignal, onAttempt: (n: number) => void) => Promise<string>
  downloadVideo: (mediaUrl: string, signal: AbortSignal) => Promise<{ buffer: ArrayBuffer; mimeType: string }>
}

export interface JobEvents {
  progress: (e: AvatarSegmentProgressEvent) => void
  done: (e: AvatarSegmentDoneEvent) => void
  error: (e: AvatarSegmentErrorEvent) => void
}

function isAppError(value: unknown): value is AppError {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value
}

export async function runAvatarSegmentJob(
  input: { jobId: string; ssml: string },
  deps: JobDeps,
  events: JobEvents,
  controller: AbortController
): Promise<void> {
  const { jobId } = input
  const signal = controller.signal
  try {
    events.progress({ jobId, stage: 'submitting' })
    const refPhotoUrl = await deps.getRefPhotoUrl()
    if (signal.aborted) return
    const taskId = await deps.submitTask(refPhotoUrl, input.ssml, signal)
    if (signal.aborted) return

    const mediaUrl = await deps.pollUntilDone(taskId, signal, attempt =>
      events.progress({ jobId, stage: 'polling', pollAttempt: attempt })
    )
    if (signal.aborted) return

    events.progress({ jobId, stage: 'downloading' })
    const { buffer, mimeType } = await deps.downloadVideo(mediaUrl, signal)
    if (signal.aborted) return

    events.done({ jobId, buffer, mimeType })
  } catch (err: unknown) {
    if (signal.aborted) return  // user cancelled — don't emit error
    const error: AppError = isAppError(err)
      ? err
      : { code: 'TENCENT_API_FAIL', message: err instanceof Error ? err.message : String(err), recoverable: true }
    events.error({ jobId, error })
  }
}
