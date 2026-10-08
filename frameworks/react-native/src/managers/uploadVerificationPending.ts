/** Internal completion-budget signal; it is never acknowledgement or repair. */
export class UploadVerificationPendingError extends Error {
  constructor() { super('Upload verification pending'); }
}

export function isUploadVerificationPending(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: unknown; data?: { error?: { code?: unknown } } };
  return value.status === 425 && value.data?.error?.code === 'upload_verification_pending';
}
