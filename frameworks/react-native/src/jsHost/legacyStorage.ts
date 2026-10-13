import { createGeneratedJsCore } from './core';

/** Recognize only the successful-clear encoding left by the legacy Android SDK.
 * Unknown, partial and nonempty storage remains protected migration evidence.
 * The host must supply the complete file or a 13-byte prefix for longer files.
 */
export function isEmptyLegacyAndroidV2CheckpointCatalog(bytes: Uint8Array | readonly number[]): boolean {
  const core = createGeneratedJsCore();
  try {
    return core.codec('isEmptyLegacyAndroidV2CheckpointCatalog', { bytes: Array.from(bytes) }) === true;
  } finally { core.dispose(); }
}
