import { createNativeSpeechSession, type NativeSpeechSessionOptions, type SpeechSession, type SpeechCaptionUpdate,
  type SpeechSelection } from '@bota.dev/react-native-app-sdk/speech';
import { labHost, type NativeHost, type Joined } from './host';
import type { NativeSpeechOriginalView } from '@bota.dev/react-native-app-sdk/speech/native-media';
import { Buffer } from 'buffer';

export type Pair = { key: string; original?: SpeechCaptionUpdate; translation?: SpeechCaptionUpdate };
/** One foreground conversation. This view owns no protocol or audio buffers. */
export class Companion {
  phase: 'idle' | 'joining' | 'connected' | 'original' | 'closing' | 'failed' = 'idle';
  error = ''; busy = false; listening = false; language = 'zh'; mode: SpeechSelection['mode'] = 'translated';
  joined?: Joined;
  private session?: SpeechSession;
  private host?: ReturnType<typeof labHost>;
  private lifetime?: AbortController;
  private generation = 0;
  private startup?: Promise<void>;
  private retiring?: Promise<void>;
  private captionRevision?: number;
  private passages = new Map<string, Pair>();
  original?: NativeSpeechOriginalView;
  private originalTimer?: ReturnType<typeof setTimeout>;
  private originalPoll?: Promise<void>;
  readonly observers = new Set<() => void>();
  constructor(private readonly dependencies: { native: NativeHost; mediaFactory: NativeSpeechSessionOptions['mediaFactory'] }) {}
  get state() { return this.session?.state; }
  get pairs(): Pair[] { return [...this.passages.values()]; }
  private changed() { for (const observer of this.observers) observer(); }
  async join(origin: string, role: string, code: string) {
    if (this.phase !== 'idle') return;
    const generation = ++this.generation;
    const lifetime = this.lifetime = new AbortController();
    this.phase = 'joining'; this.error = ''; this.changed();
    this.startup = (async () => {
      let session: SpeechSession | undefined, host: ReturnType<typeof labHost> | undefined;
      try {
        host = this.host = labHost(this.dependencies.native, origin, role, code);
        const joined = await host.join(lifetime.signal);
        if (generation !== this.generation) return;
        this.joined = joined; this.language = joined.configuration.subscription.targetLanguage;
        this.mode = joined.configuration.subscription.mode; this.captionRevision = joined.configuration.subscription.revision;
        session = this.session = createNativeSpeechSession({ configuration: joined.configuration, grant: joined.grant,
          host: host.callbacks(joined, () => { if (generation === this.generation) void this.leave(); }),
          mediaFactory: this.dependencies.mediaFactory, signal: lifetime.signal,
          onState: state => {
            if (generation !== this.generation) return;
            this.changed();
            if (state.disconnect) void this.disconnected(generation);
          },
          onCaption: value => { if (generation === this.generation) this.caption(value); },
          onError: () => { if (generation === this.generation) { this.error = 'The operation could not be confirmed. Check the connection or leave and rejoin.'; this.changed(); } },
        });
        await session.ready;
        if (generation !== this.generation) return;
        this.phase = 'connected'; await this.refreshOriginal(generation);
        if (generation !== this.generation) return;
        if (session.state.disconnect) void this.disconnected(generation);
        this.scheduleOriginal(generation); this.changed();
      } catch {
        const cleanup = await Promise.allSettled([session?.close(), host?.close()]);
        if (cleanup.some(result => result.status === 'rejected')) {
          this.phase = 'failed'; this.error = 'Audio cleanup could not be confirmed. Restart the App before joining again.';
          this.changed(); throw Error('cleanup_failed');
        }
        if (generation === this.generation) {
          this.session = undefined; this.host = undefined; this.joined = undefined;
          this.phase = 'idle'; this.error = 'Could not join. Check the host, role, access code and recording policy.'; this.changed();
        }
      }
    })();
    await this.startup.catch(() => {});
  }
  leave(): Promise<void> {
    if (this.retiring) return this.retiring;
    if (this.phase === 'idle' || this.phase === 'failed') return Promise.resolve();
    ++this.generation; this.phase = 'closing'; this.captionRevision = undefined;
    clearTimeout(this.originalTimer); this.original = undefined;
    this.passages.clear(); this.joined = undefined; this.lifetime?.abort(); this.changed();
    // Close starts synchronously, before waiting for pending bootstrap or permission.
    const sessionClose = this.session?.close(), hostClose = this.host?.close();
    this.retiring = (async () => {
      const results = await Promise.allSettled([this.startup, sessionClose, hostClose]);
      await this.originalPoll?.catch(() => {});
      this.phase = results.some(result => result.status === 'rejected') ? 'failed' : 'idle';
      this.error = this.phase === 'failed' ? 'Audio cleanup could not be confirmed. Restart the App before joining again.' : '';
      this.session = undefined; this.host = undefined; this.listening = false; this.busy = false;
      this.changed();
    })();
    void this.retiring.finally(() => { this.retiring = undefined; });
    return this.retiring;
  }
  private async command(action: (session: SpeechSession, active: () => boolean) => Promise<unknown>) {
    if (this.phase !== 'connected' || !this.session || this.busy) return;
    const generation = this.generation, session = this.session;
    const active = () => this.generation === generation && this.phase === 'connected';
    this.busy = true; this.error = ''; this.changed();
    try { await action(session, active); }
    catch { if (active()) this.error = 'The operation could not be confirmed. Check the connection or leave and rejoin.'; }
    finally { if (generation === this.generation) { this.busy = false; this.changed(); } }
  }
  microphone() {
    return this.command(async (session, active) => {
      const enable = !session.state.canCapture;
      if (enable && !await this.dependencies.native.microphonePermission()) throw Error('permission_denied');
      if (active()) {
        if (!enable) await this.dependencies.native.finishOriginal?.();
        await session.setMicrophone(enable);
        if (enable && active()) await this.dependencies.native.startOriginal?.();
        if (active()) await this.refreshOriginal(this.generation);
      }
    });
  }
  listen() { return this.command(async (session, active) => {
    const enabled = !this.listening; await session.setListening(enabled); if (active()) this.listening = enabled;
  }); }
  finish() { return this.command(async session => { await this.dependencies.native.finishOriginal?.(); return session.finishInput(); }); }
  async finishOriginal() {
    if (!['connected', 'original'].includes(this.phase) || this.busy) return;
    const generation = this.generation; this.busy = true; this.changed();
    try { await this.dependencies.native.finishOriginal?.(); await this.refreshOriginal(generation); }
    catch { if (generation === this.generation) this.error = 'Original capture needs recovery and remains on this phone.'; }
    finally { if (generation === this.generation) { this.busy = false; this.changed(); } }
  }
  private refreshOriginal(generation: number): Promise<void> {
    if (this.originalPoll) return this.originalPoll;
    if (!this.dependencies.native.originalView) return Promise.resolve();
    const task = (async () => {
      const response = await this.dependencies.native.originalView!();
      if (generation !== this.generation) return;
      if (Buffer.byteLength(response, 'utf8') > 524288) throw Error('unavailable');
      const value = JSON.parse(response);
      if (!value || ['enabled', 'capturing', 'finished', 'rtcAvailable'].some(key => typeof value[key] !== 'boolean') ||
          typeof value.status !== 'string' || Buffer.byteLength(value.status, 'utf8') > 1024 || !Array.isArray(value.passages) ||
          value.passages.length > 64 || value.passages.some((text: unknown) => typeof text !== 'string') ||
          value.passages.reduce((bytes: number, text: string) => bytes + Buffer.byteLength(text, 'utf8'), 0) > 327680) throw Error('unavailable');
      this.original = value; this.changed();
    })();
    this.originalPoll = task;
    return task.finally(() => { if (this.originalPoll === task) this.originalPoll = undefined; });
  }
  private scheduleOriginal(generation: number) {
    if (generation !== this.generation || !this.original?.enabled) return;
    clearTimeout(this.originalTimer);
    this.originalTimer = setTimeout(() => {
      void this.refreshOriginal(generation).catch(() => {
        if (generation === this.generation) { this.error = 'Original status is unavailable. You can still stop or leave.'; this.changed(); }
      }).finally(() => this.scheduleOriginal(generation));
    }, 2000);
  }
  private async disconnected(generation: number) {
    try { await this.refreshOriginal(generation); } catch { /* Authorization loss is handled below. */ }
    if (generation !== this.generation) return;
    if (this.original?.enabled && !this.original.rtcAvailable) {
      this.phase = 'original'; this.listening = false;
      this.error = 'Realtime audio disconnected. Stop and save your original when ready.'; this.changed();
    } else { await this.leave(); }
  }
  resume() { return this.command(session => session.resumeAudio()); }
  recover() { return this.command(session => session.recoverCaptions()); }
  select(language: string, mode: SpeechSelection['mode']) {
    return this.command(async (session, active) => {
      this.captionRevision = undefined; this.passages.clear(); this.changed();
      await session.changeSubscription({ targetLanguage: language, mode, sourceParticipantIds: [this.joined!.peer.participantId] });
      if (active()) { this.language = language; this.mode = mode; this.captionRevision = session.state.subscriptionRevision; }
    });
  }
  private caption(value: SpeechCaptionUpdate) {
    if (value.subscriptionRevision !== this.captionRevision) return;
    const target = value.record.targetLanguage;
    if (target != null && target !== this.language) return;
    const key = JSON.stringify([value.record.sourceId, value.record.sourceEpoch, value.record.unitId]);
    const pair = this.passages.get(key) ?? { key };
    const previous = target == null ? pair.original : pair.translation;
    if (previous?.final && !value.final) return;
    if (target == null) pair.original = value; else pair.translation = value;
    this.passages.set(key, pair);
    if (this.passages.size > 100) this.passages.delete(this.passages.keys().next().value!);
    this.changed();
  }
}
