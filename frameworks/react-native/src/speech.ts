import { createGeneratedJsCore } from './jsHost/core';
import { createSpeechSession } from './speechHost';
import type { SpeechSession, SpeechSessionOptions, SpeechUpdate } from './speechHost';

export type { SpeechConfiguration, SpeechSubscription, SpeechSelection, SpeechGrant, SpeechTrack, SpeechUpdate,
  SpeechMediaCallbacks, SpeechMediaPort, SpeechHostCallbacks, SpeechSession } from './speechHost';
export { SpeechSessionError } from './speechHost';

export type NativeSpeechSessionOptions = Omit<SpeechSessionOptions, 'policyFactory' | 'clock'>;

/** Host-provided native media IO; shared Rust policy executes as ordinary JS. */
export function createNativeSpeechSession(options: NativeSpeechSessionOptions): SpeechSession {
  return createSpeechSession({ ...options, policyFactory(configurationJson, grantJson, now) {
    const core = createGeneratedJsCore();
    try {
      const { id } = core.codec('speechSession', { op: 'create', configurationJson, grantJson, nowMs: String(now) }) as { id: number };
      return {
        step: (commandJson, time) => core.codec('speechSession', { op: 'step', id, commandJson, nowMs: String(time) }) as unknown as SpeechUpdate,
        dispose: () => core.dispose(),
      };
    } catch (error) { core.dispose(); throw error; }
  } });
}
