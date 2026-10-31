import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('../../../protocol/speech-session/client-v1.json', import.meta.url), 'utf8'));

test('optional speech entry executes generated Rust without WebAssembly or native recording bytes', async () => {
  const previous = globalThis.WebAssembly;
  globalThis.WebAssembly = undefined;
  let session;
  let capture = false;
  try {
    const { createNativeSpeechSession } = require('../lib/commonjs/speech.js');
    session = createNativeSpeechSession({
      configuration: fixture.configuration,
      grant: { ...fixture.grant, expires_at: new Date(Date.now() + 60_000).toISOString() },
      host: { renewGrant: async () => { throw Error('unused'); }, changeSubscription: async () => { throw Error('unused'); } },
      mediaFactory: () => ({ async connect() {}, silencePlayback() {}, muteMicrophone() { capture = false; },
        async clearPlayback() {}, async setPlayback() {}, async setMicrophone(enabled) { capture = enabled; }, async close() {} }),
    });
    await session.ready;
    await session.setMicrophone(true);
    assert.equal(capture, true);
    await session.setListening(false);
    assert.equal(capture, true);
    assert.equal(session.state.canCapture, true);
  } finally { await session?.close(); globalThis.WebAssembly = previous; }
  assert.equal(capture, false);
});
