import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('recording is the only published React Native speech entry', () => {
  const recording = require('@bota.dev/react-native-app-sdk/speech/recording');
  assert.equal(typeof recording.createRecordingSpeechClient, 'function');
  for (const entry of ['speech', 'speech/native-media', 'speech/livekit']) {
    assert.throws(() => require(`@bota.dev/react-native-app-sdk/${entry}`), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
  }
});
