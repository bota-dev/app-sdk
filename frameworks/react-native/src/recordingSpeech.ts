import { Buffer } from 'buffer'

export interface RecordingSpeechCaption {
  unitId: string; sourceId: string; sourceEpoch: number; revision: number
  startSample: number; endSample: number; sourceLanguage: string
  targetLanguage?: string; text: string; isFinal: boolean
}
export interface RecordingSpeechObserver {
  onCaption?(caption: RecordingSpeechCaption): void
  onStatus?(status: string): void
}
/** App-owned native bridge to RecordingSpeechConnection. Admission, grants,
 * PCM, encrypted capture, policy and playback stay native. close must immediately
 * retire callbacks, join pending admission/commands, and dispose any late owner.
 * events drains at most 32 messages and must settle when close retires the owner. */
export interface NativeRecordingSpeechIO {
  start(connectionId: string, activityId: string): Promise<void>
  changeTarget(connectionId: string, language: string, requestId: string): Promise<void>
  qualifyHeadphones(connectionId: string): Promise<boolean>
  finish(connectionId: string): Promise<void>
  events(connectionId: string): Promise<string>
  close(connectionId: string): Promise<void>
}
export interface RecordingSpeechSession {
  changeTarget(language: string, requestId: string): Promise<void>
  qualifyHeadphones(): Promise<boolean>
  finish(): Promise<void>
  close(): Promise<void>
}
export interface RecordingSpeechClient {
  start(activityId: string, observer?: RecordingSpeechObserver): Promise<RecordingSpeechSession>
  close(): Promise<void>
}
export class RecordingSpeechError extends Error {
  constructor(readonly code: 'closed' | 'busy' | 'invalid_input' | 'unavailable' | 'cleanup_failed') { super(code); this.name = 'RecordingSpeechError' }
}
let nextOwner = 0
const owners = new WeakSet<NativeRecordingSpeechIO>()
const statusCodes = new Set(['interrupted', 'output_skipped', 'archive_unavailable', 'capture_interrupted'])
const validText = (value: unknown, maximum: number): value is string => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maximum
function caption(value: unknown, final: unknown): RecordingSpeechCaption {
  if (!value || typeof value !== 'object' || typeof final !== 'boolean') throw new RecordingSpeechError('unavailable')
  const c = value as Record<string, unknown>
  if (!['unitId', 'sourceId'].every(key => validText(c[key], 256) && c[key] !== '') ||
    !validText(c.sourceLanguage, 32) || !validText(c.text, 16384) ||
    !(c.targetLanguage === undefined || validText(c.targetLanguage, 32)) ||
    !['sourceEpoch', 'revision', 'startSample', 'endSample'].every(key => Number.isSafeInteger(c[key]) && (c[key] as number) >= 0) ||
    (c.endSample as number) <= (c.startSample as number)) throw new RecordingSpeechError('unavailable')
  return { unitId: c.unitId as string, sourceId: c.sourceId as string, sourceEpoch: c.sourceEpoch as number,
    revision: c.revision as number, startSample: c.startSample as number, endSample: c.endSample as number,
    sourceLanguage: c.sourceLanguage as string, targetLanguage: c.targetLanguage as string | undefined,
    text: c.text as string, isFinal: final }
}
/** One foreground activity at a time. A UI close is observable immediately even
 * if native admission is still pending; cleanup failure prevents silent reuse. */
export function createRecordingSpeechClient(io: NativeRecordingSpeechIO): RecordingSpeechClient {
  if (!io || ['start', 'changeTarget', 'qualifyHeadphones', 'finish', 'events', 'close'].some(key =>
    typeof io[key as keyof NativeRecordingSpeechIO] !== 'function')) throw new RecordingSpeechError('invalid_input')
  type Owner = { id: string; stopped: boolean; ready: boolean; start?: Promise<void>; closing?: Promise<void>
    timer?: ReturnType<typeof setTimeout>; polling?: Promise<void>; operations: Set<Promise<unknown>> }
  let current: Owner | undefined, lastClose: Promise<void> | undefined, cleanupFailed = false
  const active = (owner: Owner) => { if (owner.stopped || current !== owner) throw new RecordingSpeechError('closed') }
  const close = (owner: Owner): Promise<void> => {
    if (owner.closing) return owner.closing
    owner.stopped = true; clearTimeout(owner.timer)
    const nativeClose = Promise.resolve().then(() => io.close(owner.id))
    owner.closing = (async () => {
      let failure = false
      try { await nativeClose } catch { failure = true }
      await Promise.allSettled([...(owner.start ? [owner.start] : []), ...owner.operations, ...(owner.polling ? [owner.polling] : [])])
      if (failure) { cleanupFailed = true; throw new RecordingSpeechError('cleanup_failed') }
    })().finally(() => { if (current === owner) current = undefined; if (!cleanupFailed) owners.delete(io) })
    lastClose = owner.closing; return owner.closing
  }
  const call = async <T>(owner: Owner, body: () => Promise<T>): Promise<T> => {
    active(owner)
    if (!owner.ready || owner.operations.size >= 32) throw new RecordingSpeechError('busy')
    const task = Promise.resolve().then(body); owner.operations.add(task)
    try { const result = await task; active(owner); return result }
    catch (error) { throw error instanceof RecordingSpeechError ? error : new RecordingSpeechError('unavailable') }
    finally { owner.operations.delete(task) }
  }
  return {
    async start(activityId, observer = {}) {
      if (cleanupFailed) throw new RecordingSpeechError('cleanup_failed')
      if (current || owners.has(io)) throw new RecordingSpeechError('busy')
      if (!validText(activityId, 256) || !activityId) throw new RecordingSpeechError('invalid_input')
      // Correlation only; native authorization never trusts this identifier.
      const id = Date.now().toString(16).padStart(16, '0') + (++nextOwner).toString(16).padStart(16, '0')
      const owner: Owner = { id, stopped: false, ready: false, operations: new Set() }; current = owner; owners.add(io)
      const fail = () => {
        if (owner.stopped) return
        void close(owner).catch(() => {})
        try { observer.onStatus?.('bridge_unavailable') } catch { /* Native disposal remains joined. */ }
      }
      const poll = () => {
        if (owner.stopped) return
        owner.polling = (async () => {
          const payload = await io.events(id)
          if (owner.stopped) return
          if (!validText(payload, 524288)) throw new RecordingSpeechError('unavailable')
          const events: unknown = JSON.parse(payload)
          if (!Array.isArray(events) || events.length > 32) throw new RecordingSpeechError('unavailable')
          for (const event of events) {
            if (owner.stopped) return
            if (event?.type === 'caption') observer.onCaption?.(caption(event.caption, event.final))
            else if (event?.type === 'status' && statusCodes.has(event.status)) observer.onStatus?.(event.status)
            else throw new RecordingSpeechError('unavailable')
          }
        })().catch(fail).finally(() => { owner.polling = undefined; if (!owner.stopped) owner.timer = setTimeout(poll, 25) })
      }
      try {
        owner.start = io.start(id, activityId)
        await owner.start; active(owner); owner.ready = true; poll()
        return {
          changeTarget: (language, requestId) => call(owner, () => io.changeTarget(id, language, requestId)),
          qualifyHeadphones: () => call(owner, async () => { const value = await io.qualifyHeadphones(id); if (typeof value !== 'boolean') throw new RecordingSpeechError('unavailable'); return value }),
          finish: () => call(owner, () => io.finish(id)), close: () => close(owner),
        }
      } catch (error) {
        await close(owner)
        throw error instanceof RecordingSpeechError ? error : new RecordingSpeechError('unavailable')
      }
    },
    close: () => current ? close(current) : lastClose ?? Promise.resolve(),
  }
}
