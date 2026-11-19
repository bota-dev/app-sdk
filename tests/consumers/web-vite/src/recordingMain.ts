import { recordingHost } from './recordingHost'
import { startRecording } from './recordingApp'
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const status = (value: string) => { element('status').textContent = value }
const captions = new Map<string, string>()
let owner: Awaited<ReturnType<typeof startRecording>> | undefined, busy = false
let modelCatalogRevision: string | undefined
let catalogCode: string | undefined
let modelStages: Record<string, boolean> = {}
let lifetime: AbortController | undefined, departed = false
const live = element<HTMLInputElement>('live')
live.checked = false
function buttons(active: boolean) {
  live.disabled = active || modelStages.asr !== true
  element<HTMLInputElement>('code').disabled = active
  element<HTMLSelectElement>('retention').disabled = active || !live.checked
  element<HTMLSelectElement>('target').disabled = !live.checked
  if (!live.checked) element<HTMLSelectElement>('retention').value = 'original_audio_and_text'
  element<HTMLButtonElement>('start').disabled = active
  element<HTMLButtonElement>('load-models').disabled = active
  for (const stage of ['asr', 'translation', 'tts']) element<HTMLSelectElement>(`${stage}-model`).disabled = active || !live.checked || !modelCatalogRevision || modelStages[stage] !== true
  for (const id of ['change','route']) element<HTMLButtonElement>(id).disabled = !active || !live.checked
  for (const id of ['finish','close']) element<HTMLButtonElement>(id).disabled = !active
}
live.onchange = () => buttons(false)
buttons(false)
async function action(work: () => Promise<void>) { if (busy) return; busy = true; try { await work() } catch { status('The operation could not complete. Retained originals remain available for recovery.') } finally { busy = false } }
element('load-models').onclick = () => { void action(async () => {
  const code = element<HTMLInputElement>('code').value
  const catalog = await recordingHost(code).models(new AbortController().signal)
  if (code !== element<HTMLInputElement>('code').value) return
  for (const stage of ['asr', 'translation', 'tts']) {
    const select = element<HTMLSelectElement>(`${stage}-model`)
    const inherited = catalog.models.find(model => model.id === catalog.defaults[stage])
    select.replaceChildren(new Option(`Default${inherited ? ` · ${inherited.label}` : ''}`, ''))
    for (const model of catalog.models.filter(model => model.stage === stage)) {
      const option = new Option(model.label + (model.available ? '' : ' · Unavailable'), model.id)
      option.disabled = !model.available; select.add(option)
    }
    select.disabled = catalog.stages?.[stage] === false
  }
  modelStages = catalog.stages ?? {}; modelCatalogRevision = catalog.revision; catalogCode = code; live.checked = false; buttons(false); status(modelStages.asr ? 'Project options loaded. Live transcription is available.' : 'Project options loaded. Live transcription is unavailable.')
}) }
element('code').oninput = () => {
  modelCatalogRevision = undefined; catalogCode = undefined; modelStages = {}; live.checked = false; buttons(false)
  for (const stage of ['asr', 'translation', 'tts']) { const select = element<HTMLSelectElement>(`${stage}-model`); select.replaceChildren(new Option('Default', '')); select.disabled = true }
}
element('start').onclick = () => { void action(async () => {
  buttons(true); captions.clear(); element('captions').textContent = ''; element('final').textContent = ''; status('Starting microphone…')
  try {
    lifetime = new AbortController(); departed = false
    owner = await startRecording({ realtimeTranscription: live.checked, code: element<HTMLInputElement>('code').value, target: element<HTMLSelectElement>('target').value,
      signal: lifetime.signal,
      models: Object.fromEntries(['asr', 'translation', 'tts'].flatMap(stage => { const value = element<HTMLSelectElement>(`${stage}-model`).value; return value ? [[stage, value]] : [] })),
      ...(catalogCode === element<HTMLInputElement>('code').value && modelCatalogRevision ? { modelCatalogRevision } : {}),
      retention: element<HTMLSelectElement>('retention').value, headphones: () => element<HTMLInputElement>('headphones').checked,
      status: value => { if (value.startsWith('Headphone route changed')) element<HTMLInputElement>('headphones').checked = false; status(value) },
      caption: (value, final) => { captions.set(`${value.unitId}:${value.targetLanguage ?? 'source'}`, `[${value.targetLanguage ?? value.sourceLanguage}; target revision ${value.revision}${final ? '' : '; interim'}] ${value.text}`)
        if (captions.size > 100) captions.delete(captions.keys().next().value!); element('captions').textContent = [...captions.values()].join('\n') },
      final: (_id, version, segments, state) => { element('final').textContent = `Source version ${version.slice(0,12)} · translation ${state}\n` + segments.map(segment =>
        segment.text + '\n' + (segment.translation_units ?? []).map((unit: Record<string, any>) => `[${unit.targetLanguage}; revision ${unit.revision}] ${unit.targetText ?? unit.state}`).join('\n')).join('\n\n') } })
    if (departed) { await owner.close(); owner = undefined; buttons(false) }
  } catch (error) { buttons(false); throw error }
}) }
element('change').onclick = () => { void action(async () => { status('Changing language…'); await owner?.changeTarget(element<HTMLSelectElement>('target').value); status('Language change acknowledged.') }) }
element('route').onclick = () => { void action(async () => status(await owner?.qualifyHeadphones() ? 'Headphone playback enabled.' : 'Translation audio paused. Captions and original capture continue.')) }
element('finish').onclick = () => { void action(async () => { await owner?.finish(); element<HTMLButtonElement>('finish').disabled = true }) }
element('close').onclick = () => { void action(async () => { await owner?.close(); owner = undefined; live.checked = false; buttons(false); status('Closed.') }) }
function depart() { departed = true; lifetime?.abort(); void owner?.close().catch(() => {}) }
window.addEventListener('pagehide', depart)
document.addEventListener('visibilitychange', () => { if (document.hidden) depart() })
