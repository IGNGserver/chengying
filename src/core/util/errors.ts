/** Error vocabulary shared by every Chengying layer. Codes are stable; messages are for humans. */
export type ChengyingErrorCode =
  | 'not-found'
  | 'invalid-argument'
  | 'permission-denied'
  | 'engine-unavailable'
  | 'engine-failed'
  | 'unsupported'
  | 'conflict'
  | 'authorization-required'
  | 'cancelled'
  | 'verification-failed'
  | 'internal'

export class ChengyingError extends Error {
  readonly code: ChengyingErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: ChengyingErrorCode, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ChengyingError'
    this.code = code
    this.details = details
  }
}

export function isChengyingError(error: unknown, code?: ChengyingErrorCode): error is ChengyingError {
  return error instanceof ChengyingError && (code === undefined || error.code === code)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function assertArg(condition: unknown, message: string, details?: Record<string, unknown>): asserts condition {
  if (!condition) throw new ChengyingError('invalid-argument', message, details)
}
