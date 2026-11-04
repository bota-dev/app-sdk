import initWasm, { WebSpeechClient } from './generated/bota_device_sdk_core.js'
import { createSpeechSession, SpeechSessionError } from './speechHost.ts'
import type { SpeechSession, SpeechSessionOptions, SpeechUpdate } from './speechHost.ts'

export type { SpeechConfiguration, SpeechSubscription, SpeechSelection, SpeechGrant, SpeechTrack, SpeechUpdate,
  SpeechMediaCallbacks, SpeechMediaPort, SpeechHostCallbacks, SpeechSession,
  SpeechCaptionRequest, SpeechCaptionRecovery, SpeechCaptionUpdate, SpeechFinishRequest, SpeechFinishedSource, SpeechSourceFinish } from './speechHost.ts'
export { SpeechSessionError, SpeechCaptionReadError, SpeechSourceFinishError } from './speechHost.ts'

export type WebSpeechSessionOptions = Omit<SpeechSessionOptions, 'policyFactory' | 'clock'> & {
  /** Supply bytes/module when the host owns WASM loading; otherwise use the bundled URL. */
  wasm?: ArrayBuffer | Uint8Array | WebAssembly.Module
}

/** Optional speech surface, independent of Web Bluetooth and its workflow owner. */
export async function createWebSpeechSession(options: WebSpeechSessionOptions): Promise<SpeechSession> {
  if (options.signal?.aborted) throw new SpeechSessionError('closed')
  try {
    const wasm = options.wasm instanceof Uint8Array ? new Uint8Array(options.wasm).buffer : options.wasm
    await initWasm(wasm === undefined ? undefined : { module_or_path: wasm })
  } catch { throw new SpeechSessionError('invalid_input') }
  if (options.signal?.aborted) throw new SpeechSessionError('closed')
  return createSpeechSession({ ...options, policyFactory(configuration, grant, now) {
    const client = new WebSpeechClient(configuration, grant, now)
    return {
      step: (command, time) => JSON.parse(client.step(command, time)) as SpeechUpdate,
      dispose: () => client.free(),
    }
  } })
}
