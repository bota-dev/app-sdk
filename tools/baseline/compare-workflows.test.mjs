import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  compareWorkflowTraces,
  validateWorkflowCompatibility,
  validateWorkflowDirectory,
  validateWorkflowReferences,
  validateWorkflowSuite,
} from './compare-workflows.mjs';

const schema = JSON.parse(
  readFileSync('protocol/workflows/schema.json', 'utf8')
);

const validSuite = () => ({
  schemaVersion: 1,
  workflow: 'connection',
  baseline: {
    package: '@bota.dev/react-native-sdk',
    version: '0.0.65',
    revision: '44ac1221cb71eb01cafcdbfdf7a370847d3a10b4',
  },
  scenarios: [
    {
      name: 'manual-connect',
      classification: 'positive',
      sourceTest: 'src/managers/__tests__/DeviceManager.test.ts#manual connect',
      rustTest: 'connection_workflow::manual_connect',
      command: 'connect',
      capabilities: ['ble', 'timer', 'persistence'],
      inputs: ['services_discovered', 'serial_read'],
      expected: {
        effects: ['connect', 'discover_services', 'read_serial'],
        notifications: ['started', 'connection_established', 'completed'],
        terminalStatus: 'completed',
        checkpoint: {
          workflow: 'connection',
          operation: 'connect',
          device: 'EVFXXW67KP',
          phase: 'connecting',
          completedUnits: 0,
          retryCount: 0,
        },
      },
    },
  ],
});

test('accepts a complete deterministic workflow scenario', () => {
  assert.deepEqual(validateWorkflowSuite(validSuite(), schema), []);
});

test('all committed workflow suites satisfy the conformance contract', () => {
  assert.deepEqual(validateWorkflowDirectory('protocol/workflows'), []);
});

test('requires pinned source, command, capabilities, ordered traces, and terminal status', () => {
  const suite = validSuite();
  suite.baseline.revision = 'main';
  delete suite.scenarios[0].sourceTest;
  delete suite.scenarios[0].command;
  delete suite.scenarios[0].capabilities;
  delete suite.scenarios[0].inputs;
  delete suite.scenarios[0].expected.effects;
  delete suite.scenarios[0].expected.notifications;
  delete suite.scenarios[0].expected.terminalStatus;

  const errors = validateWorkflowSuite(suite, schema).join('\n');
  assert.match(errors, /revision.*must match pattern/);
  assert.match(errors, /must have required property 'sourceTest'/);
  assert.match(errors, /must have required property 'command'/);
  assert.match(errors, /must have required property 'capabilities'/);
  assert.match(errors, /must have required property 'inputs'/);
  assert.match(errors, /must have required property 'effects'/);
  assert.match(errors, /must have required property 'notifications'/);
  assert.match(errors, /must have required property 'terminalStatus'/);
});

test('rejects duplicate scenario names within and across workflow files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bota-workflows-'));
  try {
    writeFileSync(join(directory, 'schema.json'), JSON.stringify(schema));
    const first = validSuite();
    first.scenarios.push({ ...first.scenarios[0] });
    writeFileSync(join(directory, 'first.json'), JSON.stringify(first));
    const second = validSuite();
    second.workflow = 'reconnect';
    writeFileSync(join(directory, 'second.json'), JSON.stringify(second));

    const errors = validateWorkflowDirectory(directory).join('\n');
    assert.match(errors, /duplicate scenario name manual-connect/);
    assert.match(errors, /already used by connection/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('requires positive, rejection, cancellation, and resume coverage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bota-workflows-'));
  try {
    writeFileSync(join(directory, 'schema.json'), JSON.stringify(schema));
    writeFileSync(join(directory, 'connection.json'), JSON.stringify(validSuite()));

    assert.match(
      validateWorkflowDirectory(directory).join('\n'),
      /missing required classifications: rejection, cancellation, resume/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects secret, URL, path, and payload fields in checkpoints', () => {
  for (const forbidden of [
    ['token', 'secret'],
    ['url', 'https://example.invalid/upload'],
    ['filePath', '/tmp/recording.ogg'],
    ['payload', 'deadbeef'],
  ]) {
    const suite = validSuite();
    suite.scenarios[0].expected.checkpoint[forbidden[0]] = forbidden[1];
    assert.match(
      validateWorkflowSuite(suite, schema).join('\n'),
      /must NOT have additional properties/
    );
  }
});

test('compares every declared scenario with its deterministic Rust trace', () => {
  const suite = validSuite();
  const trace = {
    workflow: suite.workflow,
    scenarios: suite.scenarios.map(({ name, command, capabilities, inputs, expected }) => ({
      name,
      command,
      capabilities,
      inputs,
      ...expected,
    })),
  };

  assert.deepEqual(compareWorkflowTraces([suite], [trace]), []);
  trace.scenarios[0].effects = ['connect'];
  assert.match(
    compareWorkflowTraces([suite], [trace]).join('\n'),
    /connection\/manual-connect: trace mismatch/
  );
});

test('validates frozen source anchors and executable Rust test references', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bota-workflow-refs-'));
  try {
    const sdkPath = join(directory, 'react-native-sdk');
    const rustTestsPath = join(directory, 'tests');
    mkdirSync(join(sdkPath, 'src/managers/__tests__'), { recursive: true });
    mkdirSync(rustTestsPath, { recursive: true });
    writeFileSync(
      join(sdkPath, 'src/managers/__tests__/DeviceManager.test.ts'),
      "it('manual connect', () => {});\n"
    );
    writeFileSync(
      join(rustTestsPath, 'connection_workflow.rs'),
      '#[test]\nfn manual_connect() {}\n'
    );

    assert.deepEqual(
      validateWorkflowReferences([validSuite()], { sdkPath, rustTestsPath }),
      []
    );

    const suite = validSuite();
    suite.scenarios[0].sourceTest =
      'src/managers/__tests__/DeviceManager.test.ts#missing source anchor';
    suite.scenarios[0].rustTest = 'connection_workflow::missing_rust_test';
    const errors = validateWorkflowReferences([suite], {
      sdkPath,
      rustTestsPath,
    }).join('\n');
    assert.match(errors, /source anchor not found/);
    assert.match(errors, /Rust test not found/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects supported compatibility claims without complete workflow coverage', () => {
  const suite = validSuite();
  suite.scenarios = ['positive', 'rejection', 'cancellation', 'resume'].map(
    (classification, index) => ({
      ...suite.scenarios[0],
      name: `scenario-${index}`,
      classification,
    })
  );
  const compatibility = {
    workflows: [
      {
        workflow: 'connection',
        scenarios: 4,
        classifications: ['positive'],
        status: 'supported',
      },
    ],
  };

  assert.match(
    validateWorkflowCompatibility([suite], compatibility).join('\n'),
    /cannot be supported without positive, rejection, cancellation, resume/
  );

  compatibility.workflows[0].classifications = [
    'positive',
    'rejection',
    'cancellation',
    'resume',
  ];
  assert.deepEqual(validateWorkflowCompatibility([suite], compatibility), []);
});
