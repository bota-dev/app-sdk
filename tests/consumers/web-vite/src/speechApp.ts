import { createWebSpeechSession, SpeechSessionError, type SpeechCaptionUpdate, type SpeechSession,
  type WebSpeechSessionOptions } from '@bota.dev/web-app-sdk/speech'
import { HostError, speechHost, type SpeechJoin } from './speechHost'

/** The same view/controller is exercised with synthetic IO in speech-check.html.
 * The normal page always supplies the real public LiveKit factories. */
export function mountSpeechApp(root: HTMLElement, mediaFactory: WebSpeechSessionOptions['mediaFactory']) {
  root.innerHTML = `
    <header><p class="eyebrow">BOTA · CONVERSATION LAB</p><h1>Listen in your language.</h1>
      <p>Two speakers. Independent microphones, captions and listening.</p></header>
    <section class="panel" aria-labelledby="join-title"><div class="heading"><h2 id="join-title">Your conversation</h2>
      <span data-testid="connection" role="status">Not connected</span></div>
      <form id="join-form"><label>Your role<select id="role"><option value="a">Speaker A</option><option value="b">Speaker B</option></select></label>
        <label>Role access code<input id="code" type="password" autocomplete="off" required /></label>
        <button id="join" type="submit">Join conversation</button><button id="leave" type="button" class="secondary" disabled>Leave</button></form>
      <p id="policy" class="muted">Your host determines the recording policy before you join.</p>
      <p class="muted">Use headphones. Each tab represents one speaker; a shared microphone cannot separate overlapping voices.</p>
    </section>
    <section class="panel" aria-labelledby="controls-title"><h2 id="controls-title">Speak and listen</h2>
      <div class="controls"><button id="input" disabled>Start microphone</button><button id="listen" disabled>Start listening</button>
        <button id="finish" class="secondary" disabled>Finish speaking</button><button id="resume" class="secondary" disabled>Enable audio</button></div>
      <p data-testid="source-finish" role="status">Microphone is off</p>
      <div class="preferences"><label>Receive in<select id="language" disabled><option value="zh">Chinese</option></select></label>
        <label>Listening mode<select id="mode" disabled><option value="translated">Translation</option><option value="original">Original audio</option>
          <option value="captions_only">Captions only</option></select></label>
        <button id="apply" class="secondary" disabled>Apply listening preference</button></div>
      <p id="recovery" class="muted"></p><p id="error" role="alert"></p>
    </section>
    <section class="panel" aria-labelledby="captions-title"><div class="heading"><h2 id="captions-title">Conversation</h2>
      <span class="muted">Most recent 100 passages</span></div><p id="empty" class="muted">Captions will appear here when the other speaker talks.</p>
      <div id="captions" aria-live="polite"></div></section>`
  function element<T extends HTMLElement>(id: string): T { return root.querySelector<T>(id)! }
  const connection = element('[data-testid=connection]'), input = element<HTMLButtonElement>('#input'), listen = element<HTMLButtonElement>('#listen')
  const language = element<HTMLSelectElement>('#language'), mode = element<HTMLSelectElement>('#mode'), role = element<HTMLSelectElement>('#role')
  const code = element<HTMLInputElement>('#code'), error = element('#error'), finish = element('[data-testid=source-finish]')
  const captions = element('#captions')
  type Pair = { original?: SpeechCaptionUpdate; translations: Map<string, SpeechCaptionUpdate> }
  const pairs = new Map<string, Pair>()
  let phase: 'idle' | 'joining' | 'connected' | 'closing' | 'failed' = 'idle'
  let owner: SpeechSession | undefined, joined: SpeechJoin | undefined, abort: AbortController | undefined
  let startup: Promise<void> | undefined, retiring: Promise<void> | undefined
  let generation = 0, busy = false, listening = false, selectedLanguage = 'zh'
  const languageName = (tag: string) => new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag
  function message(value: unknown) {
    if (value instanceof HostError) {
      if (value.status === 403) return 'Authorization failed. Check your role and access code.'
      if (value.code === 'unsupported_session') return 'This session is not supported by this microphone demo. Ask your host to check its capture and recording policy.'
      if (value.code === 'not_ready') return 'The conversation is not ready yet. Try joining again when your host is ready.'
      if (value.code === 'conflict') return 'The preference changed elsewhere. Leave and rejoin before trying again.'
    }
    if (value instanceof SpeechSessionError) {
      if (value.code === 'cleanup_failed') return 'Audio cleanup could not be confirmed. Close this tab before joining again.'
      if (value.code === 'source_finish_unavailable') return 'Input is held. Retry Finish speaking to check the final result, or leave.'
      if (value.code === 'playback_blocked') return 'Select Enable audio to allow playback.'
      if (value.code === 'subscription_unavailable') return 'The preference could not be confirmed. Leave and rejoin to read its current state.'
      if (value.code === 'authorization_unavailable') return 'Authorization is no longer available. Leave and rejoin with current access.'
    }
    return 'The operation could not be completed. Check your connection and try again.'
  }
  function render() {
    const active = phase === 'connected', state = owner?.state
    connection.textContent = { idle: 'Not connected', joining: 'Joining…', connected: 'Connected', closing: 'Leaving…', failed: 'Cleanup required' }[phase]
    element<HTMLButtonElement>('#join').disabled = phase !== 'idle'
    role.disabled = code.disabled = phase !== 'idle'
    element<HTMLButtonElement>('#leave').disabled = phase === 'idle' || phase === 'closing' || phase === 'failed'
    for (const id of ['#input', '#listen', '#finish', '#resume', '#language', '#mode', '#apply']) element<HTMLButtonElement>(id).disabled = !active || busy
    input.textContent = state?.canCapture ? 'Mute microphone' : 'Start microphone'
    listen.textContent = listening ? 'Stop listening' : 'Start listening'
    if (state?.sourceFinish.holdPublication) input.disabled = true
    const status = state?.sourceFinish.status
    finish.textContent = status === 'completed' ? 'Input processing completed' : status === 'interrupted' ? 'Input processing was interrupted' :
      status === 'no_source' ? 'No input was published' : state?.sourceFinish.holdPublication ? 'Finishing accepted input…' :
        state?.canCapture ? 'Microphone is on' : 'Microphone is off'
    element('#recovery').textContent = !active ? '' : state?.gap ? 'A gap was detected in live updates.' :
      state?.recovery.status === 'unavailable' ? 'Live-only session: earlier captions are unavailable.' :
        state?.recovery.status === 'retrying' ? 'Caption history is temporarily unavailable; live input continues.' : ''
  }
  function drawCaptions() {
    captions.replaceChildren()
    element('#empty').hidden = pairs.size > 0
    for (const pair of pairs.values()) {
      const translated = pair.translations.get(selectedLanguage), reference = pair.original ?? translated
      if (!reference) continue
      const row = document.createElement('article'); row.dataset.testid = 'caption-pair'; row.className = 'caption-pair'
      const label = document.createElement('p'); label.className = 'caption-label'
      label.textContent = `Speaker ${joined?.peer.role.toUpperCase() ?? ''} · ${(Number(reference.record.startMs) / 1000).toFixed(1)} s`
      const original = document.createElement('p'), translation = document.createElement('p')
      original.textContent = String(pair.original?.record.text ?? 'Waiting for original text…')
      translation.textContent = translated ? String(translated.record.text) : 'Waiting for translation…'
      translation.className = 'translation'
      const status = document.createElement('small')
      status.textContent = `${languageName(selectedLanguage)} · ${reference.final && (!translated || translated.final) ? 'Confirmed' : 'Interim'}`
      row.append(label, original, translation, status); captions.append(row)
    }
  }
  function caption(value: Readonly<SpeechCaptionUpdate>) {
    const key = JSON.stringify([value.record.sourceId, value.record.sourceEpoch, value.record.unitId])
    const pair = pairs.get(key) ?? { translations: new Map<string, SpeechCaptionUpdate>() }
    const target = value.record.targetLanguage
    const previous = typeof target === 'string' ? pair.translations.get(target) : pair.original
    if (previous?.final && !value.final) return
    if (typeof target === 'string') pair.translations.set(target, value)
    else pair.original = value
    pairs.set(key, pair)
    if (pairs.size > 100) pairs.delete(pairs.keys().next().value!)
    drawCaptions()
  }
  async function leave() {
    if (retiring) return retiring
    if (phase === 'idle' || phase === 'failed') return
    generation++; phase = 'closing'; abort?.abort(); render()
    retiring = (async () => {
      try {
        await startup
        await owner?.close()
        owner = undefined; joined = undefined; phase = 'idle'
      } catch (value) { phase = 'failed'; error.textContent = message(value) }
      finally {
        code.value = ''; listening = false; busy = false; pairs.clear(); drawCaptions(); render()
        element('#policy').textContent = 'Your host determines the recording policy before you join.'
      }
    })()
    try { await retiring } finally { retiring = undefined }
  }
  element<HTMLFormElement>('#join-form').addEventListener('submit', event => {
    event.preventDefault()
    if (phase !== 'idle') return
    const current = ++generation, controller = new AbortController(), host = speechHost(role.value, code.value)
    abort = controller; phase = 'joining'; error.textContent = ''; code.value = ''; render()
    startup = (async () => {
      let created: SpeechSession | undefined
      try {
        const initial = await host.join(controller.signal)
        if (current !== generation) return
        if (!['live_only', 'text_only'].includes(initial.configuration.context.retention)) throw new HostError(409, 'unsupported_session')
        joined = initial
        selectedLanguage = initial.configuration.subscription.targetLanguage
        language.replaceChildren(...initial.allowedLanguages.map(tag => new Option(languageName(tag), tag)))
        language.value = selectedLanguage; mode.value = initial.configuration.subscription.mode
        element('#policy').textContent = initial.configuration.context.retention === 'live_only' ?
          'Live only. No original audio archive or saved caption history. This view clears when you leave.' :
          'Text is retained under your host’s policy. No original audio archive. This view clears when you leave.'
        created = await createWebSpeechSession({ configuration: initial.configuration, grant: initial.grant,
          host: host.callbacks(initial), mediaFactory, signal: controller.signal,
          onState: state => { if (current === generation) { render(); if (state.disconnect) void leave() } },
          onCaption: value => { if (current === generation) caption(value) },
          onError: value => { if (current === generation) error.textContent = message(value) },
        })
        owner = created
        await created.ready
        if (current !== generation) { await created.close(); return }
        phase = 'connected'; render()
      } catch (value) {
        if (created) {
          try { await created.close() }
          catch (cleanup) { phase = 'failed'; error.textContent = message(cleanup); throw cleanup }
        }
        if (current === generation) { owner = undefined; phase = 'idle'; error.textContent = message(value); render() }
      }
    })()
    void startup.catch(() => { render() })
  })
  async function command(operation: (session: SpeechSession) => Promise<unknown>) {
    if (phase !== 'connected' || !owner || busy) return
    const current = generation
    busy = true; error.textContent = ''; render()
    try { await operation(owner) }
    catch (value) { if (current === generation) error.textContent = message(value) }
    finally { if (current === generation) { busy = false; render() } }
  }
  input.addEventListener('click', () => void command(session => session.setInput(!session.state.canCapture)))
  listen.addEventListener('click', () => void command(async session => { await session.setListening(!listening); listening = !listening }))
  element('#finish').addEventListener('click', () => void command(session => session.finishInput()))
  element('#resume').addEventListener('click', () => void command(session => session.resumeAudio()))
  element('#apply').addEventListener('click', () => void command(async session => {
    await session.changeSubscription({ targetLanguage: language.value, mode: mode.value as SpeechJoin['configuration']['subscription']['mode'],
      sourceParticipantIds: [joined!.peer.participantId] })
    selectedLanguage = language.value; drawCaptions()
  }))
  element('#leave').addEventListener('click', () => { void leave() })
  window.addEventListener('pagehide', () => { void leave() }, { once: true })
  render()
}
