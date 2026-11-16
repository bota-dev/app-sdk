import { startRecording } from './recordingApp'
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const status = (value: string) => { element('status').textContent = value }
const captions = new Map<string, string>()
let owner: Awaited<ReturnType<typeof startRecording>> | undefined, busy = false
let lifetime: AbortController | undefined, departed = false
function buttons(active: boolean) {
  element<HTMLButtonElement>('start').disabled = active
  for (const id of ['change','route','finish','close']) element<HTMLButtonElement>(id).disabled = !active
}
async function action(work: () => Promise<void>) { if (busy) return; busy = true; try { await work() } catch { status('The operation could not complete. Retained originals remain available for recovery.') } finally { busy = false } }
element('start').onclick = () => { void action(async () => {
  buttons(true); captions.clear(); element('captions').textContent = ''; element('final').textContent = ''; status('Starting microphone…')
  try {
    lifetime = new AbortController(); departed = false
    owner = await startRecording({ code: element<HTMLInputElement>('code').value, target: element<HTMLSelectElement>('target').value,
      signal: lifetime.signal,
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
element('close').onclick = () => { void action(async () => { await owner?.close(); owner = undefined; buttons(false); status('Closed.') }) }
function depart() { departed = true; lifetime?.abort(); void owner?.close().catch(() => {}) }
window.addEventListener('pagehide', depart)
document.addEventListener('visibilitychange', () => { if (document.hidden) depart() })
