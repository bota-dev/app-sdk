import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const require = createRequire(import.meta.url);
const vector = JSON.parse(readFileSync(new URL('../../../protocol/speech-session/capture-v1.json', import.meta.url), 'utf8'));

test('generated JS capture policy matches native/backend AAD and crash-tail vector without WebAssembly', () => {
  const previous = globalThis.WebAssembly;
  let core;
  try {
    globalThis.WebAssembly = undefined;
    core = require('../lib/commonjs/jsHost/core.js').createGeneratedJsCore();
    const call = input => core.codec('speechCapture', input);
    let state = call({ op: 'create', captureId: vector.captureId, recordingId: vector.recordingId, retention: 'original_audio_and_text' });
    for (const [index, chunk] of vector.chunks.entries()) {
      state = call({ op: 'begin_clock', state, clockId: chunk.packet.header.clockId });
      const plan = call({ op: 'plan', state, firstSample: chunk.packet.header.firstSample, samples: chunk.packet.header.samples });
      assert.deepEqual(plan.header, chunk.packet.header); assert.equal(plan.aad, chunk.aad);
      state = call({ op: 'commit', state, header: plan.header, sha256: chunk.sha256 });
      state = index === 0 ? call({ op: 'end_clock', state, samples: 1000 }) : call({ op: 'recover', state });
    }
    const finished = call({ op: 'finish', state });
    assert.deepEqual(finished.manifest, vector.manifest.value); assert.equal(finished.aad, vector.manifest.aad);
    assert.throws(() => call({ op: 'create', captureId: vector.captureId, recordingId: vector.recordingId, retention: 'live_only' }));
    assert.ok(!JSON.stringify(state).includes(vector.key));
  } finally { core?.dispose(); globalThis.WebAssembly = previous; }
});
