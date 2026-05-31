import type { XingyunErrorCode, XingyunError } from '@shared/types'

export const XINGYUN_CONTAINER_ID = 'xingyun-stage'

export function xyError(code: XingyunErrorCode, message: string): XingyunError {
  return { code, message, recoverable: code !== 'XY_NOT_CONFIGURED' }
}
