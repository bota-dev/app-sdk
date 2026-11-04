import React, { useEffect, useState } from 'react';
import { AppState, NativeModules, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createNativeSpeechMedia, type NativeSpeechMediaIO } from '@bota.dev/react-native-app-sdk/speech/native-media';
import { Companion } from './controller';
import type { NativeHost } from './host';

const native = NativeModules.SpeechLabHost as (NativeHost & NativeSpeechMediaIO) | undefined;
if (!native || ['request', 'cancel', 'microphonePermission'].some(name => typeof native[name as keyof NativeHost] !== 'function')) {
  throw new Error('Internal speech host is unavailable');
}
const companion = new Companion({ native,
  mediaFactory: callbacks => createNativeSpeechMedia(callbacks, native) });
const modes = ['translated', 'original', 'captions_only'] as const;
const names: Record<string, string> = { zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', es: 'Spanish', fr: 'French', de: 'German' };
function Button({ title, onPress, disabled = false, selected = false }: {
  title: string; onPress(): void; disabled?: boolean; selected?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled, selected }} disabled={disabled}
    onPress={onPress} style={[styles.button, selected && styles.selected, disabled && styles.disabled]}>
    <Text style={styles.buttonText}>{title}</Text></Pressable>;
}
function Conversation() {
  const [, render] = useState(0), [origin, setOrigin] = useState('http://127.0.0.1:4173');
  const [code, setCode] = useState(''), [role, setRole] = useState<'a' | 'b'>('a');
  const app = companion, active = app.phase === 'connected', locked = !active || app.busy;
  useEffect(() => {
    const update = () => render(value => value + 1); app.observers.add(update);
    const listener = AppState.addEventListener('change', state => {
      if (state === 'background') { setCode(''); void app.leave(); }
    });
    return () => { app.observers.delete(update); listener.remove(); void app.leave(); };
  }, [app]);
  const finish = app.state?.sourceFinish;
  return <SafeAreaView style={styles.page}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Text style={styles.eyebrow}>BOTA · CONVERSATION LAB</Text>
    <Text style={styles.title}>Listen in your language.</Text>
    <Text style={styles.muted}>Two speakers. Independent microphones, captions and listening. Use headphones.</Text>
    <View style={styles.card}>
      <Text style={styles.heading}>Your conversation</Text><Text accessibilityLiveRegion="polite" style={styles.status}>{app.phase}</Text>
      <Text style={styles.label}>Local host</Text><TextInput accessibilityLabel="Local host" style={styles.field} value={origin}
        onChangeText={setOrigin} editable={app.phase === 'idle'} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <View style={styles.row}>{(['a', 'b'] as const).map(value => <Button key={value} title={`Speaker ${value.toUpperCase()}`}
        onPress={() => setRole(value)} selected={role === value} disabled={app.phase !== 'idle'} />)}</View>
      <Text style={styles.label}>Role access code</Text><TextInput accessibilityLabel="Role access code" style={styles.field} value={code}
        onChangeText={setCode} editable={app.phase === 'idle'} secureTextEntry autoCapitalize="none" autoCorrect={false}
        autoComplete="off" textContentType="none" importantForAutofill="no" maxLength={128} />
      <View style={styles.row}><Button title="Join conversation" disabled={app.phase !== 'idle'} onPress={() => {
        const accessCode = code; setCode(''); void app.join(origin.trim(), role, accessCode);
      }} /><Button title="Leave" disabled={!['joining', 'connected', 'original'].includes(app.phase)} onPress={() => { setCode(''); void app.leave(); }} /></View>
      <Text style={styles.muted}>{app.joined ? app.joined.configuration.context.retention === 'original_audio_and_text' ?
        'Original audio is encrypted on this phone and retained until verified publication. Live captions remain provisional.' : app.joined.configuration.context.retention === 'text_only' ?
        'Text is retained under your host’s policy. No original audio archive. This view clears when you leave.' :
        'Live only. No original audio archive or saved caption history. This view clears when you leave.' :
        'Your host determines the recording policy before you join. Leaving the foreground closes this conversation.'}</Text>
    </View>
    <View style={styles.card}><Text style={styles.heading}>Speak and listen</Text>
      <View style={styles.row}><Button title={app.state?.canCapture ? 'Mute microphone' : 'Start microphone'} disabled={locked || finish?.holdPublication || app.original?.finished}
        onPress={() => { void app.microphone(); }} /><Button title={app.listening ? 'Stop listening' : 'Start listening'} disabled={locked}
        onPress={() => { void app.listen(); }} /><Button title="Finish speaking" disabled={locked} onPress={() => { void app.finish(); }} /></View>
      <Text style={styles.muted}>{finish?.holdPublication ? `Input processing: ${finish.status}` : app.state?.canCapture ? 'Microphone is on' : 'Microphone is off'}</Text>
      <Text style={styles.label}>Receive in</Text><View style={styles.row}>{(app.joined?.allowedLanguages ?? ['zh', 'en', 'ja']).map(language =>
        <Button key={language} title={names[language] ?? language} disabled={locked} selected={app.language === language}
          onPress={() => { void app.select(language, app.mode); }} />)}</View>
      <Text style={styles.label}>Listening mode</Text><View style={styles.row}>{modes.map(mode =>
        <Button key={mode} title={{ translated: 'Translation', original: 'Original audio', captions_only: 'Captions only' }[mode]}
          disabled={locked} selected={app.mode === mode} onPress={() => { void app.select(app.language, mode); }} />)}</View>
      <View style={styles.row}><Button title="Enable audio" disabled={locked} onPress={() => { void app.resume(); }} />
        <Button title="Recover captions" disabled={locked} onPress={() => { void app.recover(); }} /></View>
      <Text style={styles.muted}>{active ? app.state?.gap ? 'A gap was detected in live updates.' : `Caption history: ${app.state?.recovery.status}` : ''}</Text>
      {!!app.error && <Text accessibilityRole="alert" style={styles.error}>{app.error}</Text>}
    </View>
    {app.original?.enabled && <View style={styles.card}>
      <Text style={styles.heading}>Original recording</Text><Text style={styles.muted}>{app.original.status}</Text>
      <Button title="Stop and save original" disabled={app.busy || app.original.finished || !['connected', 'original'].includes(app.phase)}
        onPress={() => { void app.finishOriginal(); }} />
      {app.original.passages.map((text, index) => <Text selectable key={index} style={styles.passage}>{text}</Text>)}
    </View>}
    <View style={styles.card}><Text style={styles.heading}>Conversation</Text><Text style={styles.muted}>Most recent 100 passages</Text>
      {app.pairs.length === 0 && <Text style={styles.muted}>Captions will appear here when the other speaker talks.</Text>}
      {app.pairs.map(pair => <View key={pair.key} style={styles.passage}>
        <Text style={styles.label}>Speaker {app.joined?.peer.role.toUpperCase()} · {Number((pair.original ?? pair.translation)?.record.startMs ?? 0) / 1000} s</Text>
        <Text style={styles.original}>{String(pair.original?.record.text ?? 'Waiting for original text…')}</Text>
        <Text style={styles.translation}>{String(pair.translation?.record.text ?? 'Waiting for translation…')}</Text>
        <Text style={styles.muted}>{(pair.original ?? pair.translation)?.final && (!pair.translation || pair.translation.final) ? 'Confirmed' : 'Interim'}</Text>
      </View>)}
    </View>
  </ScrollView></SafeAreaView>;
}
export default function App() { return <SafeAreaProvider><Conversation /></SafeAreaProvider>; }
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f3f5ee' }, content: { padding: 20, gap: 16, width: '100%', maxWidth: 840, alignSelf: 'center' },
  eyebrow: { color: '#2b6146', fontSize: 12, fontWeight: '700', letterSpacing: 2 }, title: { color: '#153c2c', fontSize: 34, fontWeight: '700' },
  card: { backgroundColor: '#fff', padding: 20, borderRadius: 20, gap: 14 }, heading: { fontSize: 22, fontWeight: '600', color: '#153c2c' },
  status: { color: '#2b6146', fontWeight: '600' }, label: { color: '#254c37', fontSize: 14, fontWeight: '600' },
  muted: { color: '#56645b', fontSize: 14, lineHeight: 21 }, field: { borderWidth: 1, borderColor: '#bccbbd', borderRadius: 10, padding: 12, minHeight: 48, color: '#153c2c' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, button: { backgroundColor: '#2b6146', minHeight: 48, paddingHorizontal: 16, paddingVertical: 13, borderRadius: 12, justifyContent: 'center' },
  selected: { backgroundColor: '#153c2c', borderWidth: 2, borderColor: '#a7cb70' }, disabled: { opacity: 0.4 }, buttonText: { color: '#fff', fontWeight: '600' },
  error: { color: '#9a302e', lineHeight: 22 }, passage: { borderTopWidth: 1, borderTopColor: '#e1e8db', paddingTop: 16, gap: 9 },
  original: { color: '#233d2f', fontSize: 17, lineHeight: 25 }, translation: { color: '#2b6146', fontSize: 20, lineHeight: 29 },
});
