import { createNativeSpeechSession, type NativeSpeechSessionOptions, type SpeechSession, type SpeechCaptionUpdate,
  type SpeechSelection } from '@bota.dev/react-native-app-sdk/speech';
import { labHost, type NativeHost, type Joined } from './host';

export type Pair = { key: string; original?: SpeechCaptionUpdate; translation?: SpeechCaptionUpdate };
/** One foreground conversation. This view owns no protocol or audio buffers. */
export class Companion {
  phase: 'idle' | 'joining' | 'connected' | 'closing' | 'failed' = 'idle';
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
            if (state.disconnect) void Promise.resolve().then(() => this.leave());
          },
          onCaption: value => { if (generation === this.generation) this.caption(value); },
          onError: () => { if (generation === this.generation) { this.error = 'The operation could not be confirmed. Check the connection or leave and rejoin.'; this.changed(); } },
        });
        await session.ready;
        if (generation !== this.generation) return;
        this.phase = 'connected'; this.changed();
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
    this.passages.clear(); this.joined = undefined; this.lifetime?.abort(); this.changed();
    // Close starts synchronously, before waiting for pending bootstrap or permission.
    const sessionClose = this.session?.close(), hostClose = this.host?.close();
    this.retiring = (async () => {
      const results = await Promise.allSettled([this.startup, sessionClose, hostClose]);
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
    finally { if (active()) { this.busy = false; this.changed(); } }
  }
  microphone() {
    return this.command(async (session, active) => {
      const enable = !session.state.canCapture;
      if (enable && !await this.dependencies.native.microphonePermission()) throw Error('permission_denied');
      if (active()) await session.setMicrophone(enable);
    });
  }
  listen() { return this.command(async (session, active) => {
    const enabled = !this.listening; await session.setListening(enabled); if (active()) this.listening = enabled;
  }); }
  finish() { return this.command(session => session.finishInput()); }
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
