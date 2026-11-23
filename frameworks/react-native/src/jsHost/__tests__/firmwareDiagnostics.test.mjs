import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';

const { reportFirmwareDiagnostic } = loadSource('firmwareDiagnostics.ts');
const context = { operation: 'UpdateFirmware', generation: '2', requestId: '3', cancellationId: 'ab'.repeat(16) };

test('firmware diagnostics retain original error codes and bounded cause evidence without private text', () => {
  const rows = [];
  const error = Object.assign(new Error('https://private.invalid?token=secret /private/ota.zip'), {
    code: 'ENOENT', platformCode: -1, cause: Object.assign(new Error('Bearer secret'), { code: 'EACCES' }),
  });
  reportFirmwareDiagnostic({ onFirmwareDiagnostic: row => rows.push(row) }, context,
    { stage: 'effect', phase: 'failed', effectFamily: 'FirmwareBlob', effectKind: 'ReadChunk' }, error);
  assert.equal(rows[0].errorCode, 'ENOENT');
  assert.equal(rows[0].platformCode, '-1');
  assert.equal(rows[0].causeCode, 'EACCES');
  assert.equal(rows[0].attemptId, `2:${context.cancellationId}`);
  assert(!JSON.stringify(rows).match(/private|secret|Bearer/));
  assert(Object.isFrozen(rows[0]));
});

test('diagnostics cannot change control flow through sync, async or hostile error getters', async () => {
  const error = Object.defineProperty({}, 'code', { get() { throw new Error('private'); } });
  for (const report of [() => { throw new Error('observer'); }, async () => { throw new Error('observer'); }]) {
    assert.doesNotThrow(() => reportFirmwareDiagnostic({ onFirmwareDiagnostic: report }, context,
      { stage: 'effect', phase: 'failed' }, error));
  }
  await new Promise(resolve => setImmediate(resolve));
  const rows = [];
  reportFirmwareDiagnostic({ onFirmwareDiagnostic: row => rows.push(row) }, { ...context, operation: 'TransferRecording' },
    { stage: 'effect', phase: 'failed' }, error);
  assert.equal(rows.length, 0);
});
