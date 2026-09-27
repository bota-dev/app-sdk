import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collectMaintenanceRuntimeTestFiles, readWorkflowSuites, validateWorkflowBaseline } from './compare-workflows.mjs';
import { validateMaintenanceSelection } from './react-native-api-contract.mjs';

const contractPath = 'protocol/baseline/react-native-maintenance-additions-0.0.67.json';
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('the frozen 80-export contract remains byte-for-byte unchanged', () => {
  const bytes = readFileSync('protocol/baseline/react-native-public-api-0.0.65.json');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    'c50025b25396b228dccbe7300aaf638f562826a3c15adb9c60c2889fe58431ba');
  assert.equal(JSON.parse(bytes).surface.exports.length, 80);
});

test('executes every referenced maintenance test file, excluding implementation-only anchors', () => {
  const suites = readWorkflowSuites('protocol/workflows');
  assert.deepEqual(collectMaintenanceRuntimeTestFiles(suites), [
    '__tests__/DeviceManager.test.ts', '__tests__/OTAManager.test.ts',
    '__tests__/ProtocolHandlerFirmwareUpload.test.ts', '__tests__/deviceUploadHandoff.test.ts',
    '__tests__/encryptedUploadV2RecordingManager.test.ts', '__tests__/errors.test.ts',
  ].sort());
});

test('maintenance additions have a separate current pin and explicit native-owned exclusions', () => {
  assert.ok(existsSync(contractPath), 'capture the separate maintenance additions contract');
  const contract = readJson(contractPath);
  const compatibility = readJson('protocol/compatibility/firmware-compatibility.json');
  assert.deepEqual(validateMaintenanceSelection({ contract, compatibility,
    expectedRevision: '318974f925a573cf04b0d624978bee04784af09b' }), []);
  assert.equal(compatibility.reactNativeMaintenanceBaseline.contract, contractPath);
  assert.equal(contract.sourceExportCount, 109);
  assert.equal(contract.additions.exports.length, 11);
  assert.equal(contract.excludedExports.length, 18);
  assert.equal(compatibility.encryptedUploadV2.status, 'contract_only');
  assert.equal(compatibility.encryptedUploadV2.runtimeWorkflow, false);
  assert.equal(compatibility.encryptedUploadV2.firmwareAdvertised, false);
  const suites = readWorkflowSuites('protocol/workflows');
  assert.equal(suites.reduce((n, suite) => n + suite.scenarios.length, 0), 33);
  assert.deepEqual(validateWorkflowBaseline(suites, compatibility), []);
});

for (const name of ['ci', 'release']) {
  test(`${name} checkout is bound to selected workflow metadata, not an obsolete literal`, () => {
    const workflow = readFileSync(`.github/workflows/${name}.yml`, 'utf8');
    const selected = readJson('protocol/compatibility/firmware-compatibility.json')
      .reactNativeWorkflowBaseline;
    // Inspect the bounded checkout block so a SHA elsewhere cannot satisfy this gate.
    const checkout = workflow.match(/repository: bota-dev\/react-native-sdk\r?\n([\s\S]*?)(?=\n\s*- name:|$)/)?.[1];
    assert.ok(checkout, 'maintenance checkout block missing');
    assert.match(checkout, new RegExp(`ref: ${selected.revision}(?:\\s|$)`));
    assert.match(checkout, /path: \.ci\/react-native-workflow-baseline(?:\s|$)/);
  });
}
