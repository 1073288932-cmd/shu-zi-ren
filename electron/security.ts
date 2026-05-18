import path from 'path'
import type { AppError } from '../shared/types'

export function validateExternalUrl(url: string): AppError | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { code: 'INVALID_URL', message: `Invalid URL: ${url}`, recoverable: false }
  }

  const allowed = ['http:', 'https:']
  if (!allowed.includes(parsed.protocol)) {
    return {
      code: 'PROTOCOL_NOT_ALLOWED',
      message: `Protocol "${parsed.protocol}" is not allowed`,
      recoverable: false,
    }
  }

  return null
}

type ResourceResult =
  | { targetPath: string }
  | { error: AppError }

export function checkResourcePath(
  resourceId: string,
  whitelist: Map<string, string>,
  baseDir: string
): ResourceResult {
  const absolutePath = whitelist.get(resourceId)
  if (!absolutePath) {
    return {
      error: {
        code: 'RESOURCE_NOT_ALLOWED',
        message: `Resource "${resourceId}" is not in the whitelist`,
        recoverable: false,
      },
    }
  }

  const targetPath = path.normalize(path.resolve(absolutePath))
  const normalizedBase = path.normalize(path.resolve(baseDir))
  const relative = path.relative(normalizedBase, targetPath)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      error: {
        code: 'RESOURCE_NOT_ALLOWED',
        message: `Path traversal detected for resource "${resourceId}"`,
        recoverable: false,
      },
    }
  }

  return { targetPath }
}
