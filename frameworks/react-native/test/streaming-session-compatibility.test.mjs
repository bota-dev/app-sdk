import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';

const require = createRequire(import.meta.url);
const { RecordingManager } = require(
  '../lib/commonjs/managers/RecordingManager.js'
);
const { StreamingSession } = require(
  '../lib/commonjs/managers/StreamingSession.js'
);
const { setCompatibilityClientForTesting } = require(
  '../lib/commonjs/compatibility/runtime.js'
);

afterEach(() => setCompatibilityClientForTesting(null));

test('StreamingSession creates the recording before native BLE streaming', async () => {
  const fake = createFakeStreamingClient();
  setCompatibilityClientForTesting(fake.client);
  const provider = createProvider(fake.calls);
  const session = new StreamingSession(
    null,
    null,
    connectedDevice,
    recordingUuid,
    provider,
    32,
    250
  );
  const states = [];
  session.on('chunk', (progress) => states.push(progress));

  await session.start();

  assert.deepEqual(fake.calls.slice(0, 2).map((call) => call[0]), [
    'createRecording',
    'startStreaming',
  ]);
  assert.deepEqual(fake.startRequest, {
    sessionId: fake.startRequest.sessionId,
    recordingUuid,
    recordingId: 'rec_stream',
    chunkSizeBytes: 64 * 1024,
    flushIntervalMs: 250,
  });
  assert.equal(session.state, 'completed');
  assert.equal(session.bytesReceived, 96);
  assert.equal(session.chunksUploaded, 2);
  assert.equal(session.recordingId, 'rec_stream');
  assert.equal(session.isActive, false);
  assert.deepEqual(states.map((value) => value.state), [
    'streaming',
    'paused',
    'streaming',
    'uploading',
    'completing',
  ]);
});

test('StreamingSession resolves direct and encrypted chunk destinations without bytes', async () => {
  const fake = createFakeStreamingClient();
  setCompatibilityClientForTesting(fake.client);
  const provider = createProvider(fake.calls);
  const session = new StreamingSession(
    null,
    null,
    connectedDevice,
    recordingUuid,
    provider
  );

  await session.start();

  assert.deepEqual(fake.destinations, [
    {
      request: { sequence: 1, encrypted: false },
      destination: {
        url: 'https://s3.example/rec_stream/1',
        method: 'PUT',
        contentType: 'audio/ogg',
      },
    },
    {
      request: { sequence: 0, encrypted: true },
      destination: {
        url: 'https://relay.example/chunk/0',
        method: 'POST',
        contentType: 'application/octet-stream',
        bearerToken: 'relay-token',
      },
    },
  ]);
  assert.deepEqual(fake.finalizations, [
    {
      totalChunks: 2,
      durationMs: 500,
      fileSizeBytes: 96,
      encrypted: false,
    },
  ]);
  assert.deepEqual(
    fake.calls.filter((call) => call[0] === 'finalizeRecording'),
    [['finalizeRecording', 'rec_stream', 2, 96]]
  );
});

test('RecordingManager owns only one stream and releases every terminal session', async () => {
  const fake = createFakeStreamingClient();
  fake.deferCompletion = true;
  setCompatibilityClientForTesting(fake.client);
  const manager = new RecordingManager();
  await manager.initialize();

  const first = manager.startStreamingSync(
    connectedDevice,
    recordingUuid,
    createProvider(fake.calls)
  );
  assert.equal(manager.getActiveStreamingSession(), first);
  assert.throws(
    () =>
      manager.startStreamingSync(
        connectedDevice,
        recordingUuid,
        createProvider(fake.calls)
      ),
    /already active/
  );

  await fake.started;
  fake.complete({ totalBytes: 12 });
  await fake.settled;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getActiveStreamingSession(), null);

  const second = manager.startStreamingSync(
    connectedDevice,
    recordingUuid,
    createProvider(fake.calls)
  );
  second.abort();
  second.abort();
  assert.equal(manager.getActiveStreamingSession(), null);
  assert.equal(fake.abortCount, 1);
});

const connectedDevice = {
  id: 'device-1',
  serialNumber: 'EVFXXW67KP',
  deviceType: 'bota_note',
  firmwareVersion: '1.0.17',
  isProvisioned: true,
  connectionState: 'connected',
  mtu: 247,
};

const recordingUuid = '00112233-4455-6677-8899-aabbccddeeff';

function createProvider(calls) {
  return {
    async createRecording() {
      calls.push(['createRecording']);
      return {
        recordingId: 'rec_stream',
        relay: {
          chunkUrl: (sequence) => `https://relay.example/chunk/${sequence}`,
          finalizeUrl: 'https://relay.example/finalize',
          bearerToken: 'relay-token',
        },
      };
    },
    async getChunkUrl(recordingId, sequence) {
      calls.push(['getChunkUrl', recordingId, sequence]);
      return `https://s3.example/${recordingId}/${sequence}`;
    },
    async finalizeRecording(recordingId, info) {
      calls.push([
        'finalizeRecording',
        recordingId,
        info.totalChunks,
        info.fileSizeBytes,
      ]);
    },
  };
}

function createFakeStreamingClient() {
  let resolveCompletion;
  let resolveStarted;
  const fake = {
    calls: [],
    destinations: [],
    finalizations: [],
    abortCount: 0,
    deferCompletion: false,
    startRequest: null,
    settled: Promise.resolve(),
    started: new Promise((resolve) => {
      resolveStarted = resolve;
    }),
    complete(value) {
      resolveCompletion?.(value);
    },
  };
  fake.client = {
    recordings: {
      async loadUploadQueue() {
        return [];
      },
      async saveUploadQueue() {},
      async destroyCompatibilityOperations() {},
    },
    streaming: {
      async startStreaming(_device, request, handlers) {
        fake.calls.push(['startStreaming']);
        fake.startRequest = request;
        handlers.onProgress({
          state: 'streaming',
          bytesReceived: 32,
          chunksUploaded: 0,
        });
        handlers.onProgress({
          state: 'paused',
          bytesReceived: 32,
          chunksUploaded: 0,
        });
        handlers.onProgress({
          state: 'streaming',
          bytesReceived: 64,
          chunksUploaded: 1,
        });
        fake.destinations.push({
          request: { sequence: 1, encrypted: false },
          destination: await handlers.resolveChunkDestination({
            sequence: 1,
            encrypted: false,
          }),
        });
        fake.destinations.push({
          request: { sequence: 0, encrypted: true },
          destination: await handlers.resolveChunkDestination({
            sequence: 0,
            encrypted: true,
          }),
        });
        handlers.onProgress({
          state: 'uploading',
          bytesReceived: 96,
          chunksUploaded: 2,
        });
        const finalize = {
          totalChunks: 2,
          durationMs: 500,
          fileSizeBytes: 96,
          encrypted: false,
        };
        fake.finalizations.push(finalize);
        await handlers.finalize(finalize);
        handlers.onProgress({
          state: 'completing',
          bytesReceived: 96,
          chunksUploaded: 2,
        });
        if (!fake.deferCompletion) return { totalBytes: 96 };
        const completion = new Promise((resolve) => {
          resolveCompletion = resolve;
          resolveStarted();
        });
        fake.settled = completion;
        return completion;
      },
      async abortStreaming() {
        fake.abortCount += 1;
      },
    },
  };
  return fake;
}
