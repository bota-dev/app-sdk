import React, { useEffect, useRef, useState } from 'react';
import { AppState, NativeModules, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createRecordingSpeechClient, type NativeRecordingSpeechIO, type RecordingSpeechSession } from '@bota.dev/react-native-app-sdk/speech/recording';

interface Host extends NativeRecordingSpeechIO {
  prepare(origin: string, code: string, target: string, retention: string): Promise<string>;
  original(): Promise<string>; leave(): Promise<void>;
}
const native = NativeModules.RecordingLabHost as Host;
const client = createRecordingSpeechClient(native);
const languages = ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de'];
function Button({ title, action, disabled = false }: { title: string; action(): void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} style={[styles.button, disabled && styles.disabled]} onPress={action}><Text style={styles.buttonText}>{title}</Text></Pressable>;
}
function Recording() {
  const [origin, setOrigin] = useState('http://127.0.0.1:4173'), [code, setCode] = useState(''), [target, setTarget] = useState('zh');
  const [retention, setRetention] = useState('original_audio_and_text'), [status, setStatus] = useState('Ready'), [captions, setCaptions] = useState<string[]>([]);
  const [finalText, setFinalText] = useState(''), [active, setActive] = useState(false), [busy, setBusy] = useState(false);
  const owner = useRef<RecordingSpeechSession | undefined>(undefined), generation = useRef(0), lines = useRef(new Map<string, string>()), lock = useRef(false);
  const leave = async () => {
    generation.current++; owner.current = undefined; setActive(false); setCode('');
    const results = await Promise.allSettled([client.close(), native.leave()]);
    setStatus(results.some(value => value.status === 'rejected') ? 'Cleanup failed. Reopen the App before starting another activity.' : 'Closed.');
  };
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => { if (state === 'background') void leave(); });
    return () => { listener.remove(); void leave(); };
  }, []);
  useEffect(() => {
    if (!active) return;
    let stopped = false, running = false;
    const timer = setInterval(() => {
      if (running) return; running = true;
      void native.original().then(payload => { if (stopped || payload.length > 524288) return; const value = JSON.parse(payload) as { status: string; passages: string[] };
        if (typeof value.status === 'string' && Array.isArray(value.passages)) setFinalText(value.status + '\n' + value.passages.slice(-64).join('\n\n'));
      }).catch(() => {}).finally(() => { running = false; });
    }, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [active]);
  const action = (work: () => Promise<void>) => { if (lock.current) return; lock.current = true; setBusy(true);
    void work().catch(() => setStatus('The operation could not complete. Original audio remains independent.')).finally(() => { lock.current = false; setBusy(false); }); };
  const start = async () => {
    const revision = ++generation.current, access = code; setCode(''); setStatus('Requesting microphone permission…'); lines.current.clear(); setCaptions([]); setFinalText('');
    if (!await NativeModules.MicrophonePermission.microphonePermission() || generation.current !== revision) { setStatus('Microphone permission was not granted.'); return; }
    const id = await native.prepare(origin, access, target, retention);
    if (generation.current !== revision) { await native.leave(); return; }
    setStatus('Connecting…'); setActive(true);
    const session = await client.start(id, { onStatus: value => { if (generation.current === revision) setStatus(value); }, onCaption: value => {
      if (generation.current !== revision) return;
      lines.current.set(`${value.unitId}:${value.targetLanguage ?? 'source'}`, `[${value.targetLanguage ?? value.sourceLanguage}; revision ${value.revision}${value.isFinal ? '' : '; interim'}] ${value.text}`);
      if (lines.current.size > 100) lines.current.delete(lines.current.keys().next().value!); setCaptions([...lines.current.values()]);
    } });
    if (generation.current !== revision) { await session.close(); return; }
    owner.current = session; setStatus(previous => previous === 'Connecting…' ? 'Microphone active. Live captions are provisional.' : previous);
  };
  return <SafeAreaProvider><SafeAreaView style={styles.page}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Text style={styles.title}>Recording translation</Text><Text>One microphone. One translation language. Original audio is optional.</Text>
    <TextInput accessibilityLabel="Local host" value={origin} onChangeText={setOrigin} editable={!active && !busy} style={styles.field} autoCapitalize="none" />
    <TextInput accessibilityLabel="Operator access code" value={code} onChangeText={setCode} editable={!active && !busy} style={styles.field} secureTextEntry autoCapitalize="none" autoComplete="off" importantForAutofill="no" placeholder="Operator access code" />
    <Text>Keep</Text><View style={styles.row}>{[['original_audio_and_text','Audio and text'],['text_only','Text only'],['live_only','Live only']].map(([value, label]) =>
      <Button key={value} title={`${retention === value ? '✓ ' : ''}${label}`} disabled={active || busy} action={() => setRetention(value)} />)}</View>
    <Text>Translate to</Text><View style={styles.row}>{languages.map(language => <Button key={language} title={`${target === language ? '✓ ' : ''}${language}`} disabled={busy} action={() => {
      setTarget(language); if (owner.current) action(async () => { setStatus('Changing language…'); await owner.current?.changeTarget(language, `change-${Date.now()}`); setStatus('Language change acknowledged.'); });
    }} />)}</View>
    <View style={styles.row}><Button title="Start microphone" disabled={active || busy} action={() => action(start)} /><Button title="Close" disabled={!active && !busy} action={() => { void leave(); }} /></View>
    <View style={styles.row}><Button title="Confirm headphones" disabled={!owner.current || busy} action={() => action(async () => setStatus(await owner.current?.qualifyHeadphones() ? 'Headphone playback enabled.' : 'Audio paused. Captions and original capture continue.'))} />
      <Button title="Stop capture" disabled={!owner.current || busy} action={() => action(async () => { await owner.current?.finish(); setStatus('Capture stopped. Original upload and final text continue.'); })} /></View>
    <Text>Speaker playback is unavailable. Reconfirm headphones after any route change.</Text><Text accessibilityLiveRegion="polite">{status}</Text>
    <Text style={styles.heading}>Live captions (provisional)</Text><Text selectable>{captions.join('\n')}</Text>
    <Text style={styles.heading}>Final original and translation</Text><Text selectable>{finalText}</Text>
  </ScrollView></SafeAreaView></SafeAreaProvider>;
}
const styles = StyleSheet.create({ page: { flex: 1, backgroundColor: '#f6f7f4' }, content: { padding: 20, gap: 14 }, title: { fontSize: 28, fontWeight: '600' }, heading: { fontSize: 20, fontWeight: '600' },
  field: { borderWidth: 1, borderColor: '#b8c4bb', borderRadius: 8, padding: 12 }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, button: { backgroundColor: '#164f3b', borderRadius: 8, padding: 12 }, buttonText: { color: 'white' }, disabled: { opacity: 0.45 } });
export default Recording;
