import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  buildReactNativeApiContract,
  extractReactNativeApi,
  surfaceDigest,
  validateReactNativeApiContract,
  verifyReactNativeApiContract,
  writeReactNativeApiContract,
} from './react-native-api-contract.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createSdkFixture() {
  const root = mkdtempSync(join(tmpdir(), 'bota-rn-api-'));
  temporaryDirectories.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'external-base'), { recursive: true });

  writeJson(join(root, 'package.json'), {
    name: '@bota.dev/react-native-sdk',
    version: '0.0.65',
  });
  writeJson(join(root, 'tsconfig.build.json'), {
    compilerOptions: {
      declaration: true,
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      target: 'ES2022',
    },
    include: ['src'],
  });
  writeJson(join(root, 'node_modules', 'external-base', 'package.json'), {
    name: 'external-base',
    types: 'index.d.ts',
    version: '1.0.0',
  });
  writeFileSync(
    join(root, 'node_modules', 'external-base', 'index.d.ts'),
    'export declare class ExternalBase { external(): void; }\n'
  );
  writeFileSync(
    join(root, 'src', 'index.ts'),
    `import { ExternalBase } from 'external-base';

export type Alpha = 'a' | 'b';

class ClientImpl {
  get state(): 'ready' { return 'ready'; }
  configure(value?: string): Promise<void> { return Promise.resolve(); }
  private reset(): void {}
}

export const Client = new ClientImpl();

export class Zebra extends ExternalBase {
  readonly label?: string;
  ping(value: string): Promise<number> { return Promise.resolve(value.length); }
  protected hidden(): void {}
  private secret(): void {}
}
`
  );
  return root;
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function commitFixture(root) {
  git(root, 'init');
  git(root, 'config', 'user.name', 'Bota Test');
  git(root, 'config', 'user.email', 'test@bota.dev');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  return git(root, 'rev-parse', 'HEAD');
}

test('extracts the sorted public API and excludes non-public ownership', () => {
  const surface = extractReactNativeApi(createSdkFixture());

  assert.deepEqual(
    surface.exports.map((entry) => [entry.name, entry.runtime]),
    [
      ['Alpha', false],
      ['Client', true],
      ['Zebra', true],
    ]
  );

  const client = surface.exports.find((entry) => entry.name === 'Client');
  assert.deepEqual(
    client.members.map((member) => member.name),
    ['configure', 'state']
  );
  assert.equal(client.members.find((member) => member.name === 'state').readonly, true);

  const zebra = surface.exports.find((entry) => entry.name === 'Zebra');
  assert.deepEqual(
    zebra.members.map((member) => member.name),
    ['label', 'ping']
  );
  assert.equal(zebra.members.find((member) => member.name === 'label').optional, true);
  assert.equal(zebra.members.find((member) => member.name === 'label').readonly, true);
  assert.ok(!zebra.members.some((member) => member.name === 'external'));
  assert.ok(!zebra.members.some((member) => member.name === 'hidden'));
  assert.ok(!zebra.members.some((member) => member.name === 'secret'));
});

test('surface digest is deterministic and sensitive to signatures', () => {
  const surface = extractReactNativeApi(createSdkFixture());
  const first = surfaceDigest(surface);
  const second = surfaceDigest(structuredClone(surface));

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);

  const changed = structuredClone(surface);
  changed.exports.find((entry) => entry.name === 'Client').members[0].type = '() => void';
  assert.notEqual(surfaceDigest(changed), first);
});

test('builds a pinned contract and rejects dirty capture by default', () => {
  const root = createSdkFixture();
  const revision = commitFixture(root);
  const contract = buildReactNativeApiContract({
    sdkPath: root,
    expectedCommit: revision,
    expectedVersion: '0.0.65',
  });

  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.package, '@bota.dev/react-native-sdk');
  assert.equal(contract.packageVersion, '0.0.65');
  assert.equal(contract.sourceRevision, revision);
  assert.equal(contract.entrypoint, 'src/index.ts');
  assert.equal(contract.surfaceDigest, surfaceDigest(contract.surface));

  writeFileSync(join(root, 'src', 'dirty.ts'), 'export {};\n');
  assert.throws(
    () =>
      buildReactNativeApiContract({
        sdkPath: root,
        expectedCommit: revision,
        expectedVersion: '0.0.65',
      }),
    /checkout is dirty/
  );
  assert.doesNotThrow(() =>
    buildReactNativeApiContract({
      sdkPath: root,
      expectedCommit: revision,
      expectedVersion: '0.0.65',
      allowDirty: true,
    })
  );
});

test('writes canonical JSON and validates its semantic digest', () => {
  const root = createSdkFixture();
  const revision = commitFixture(root);
  const output = join(root, 'contract.json');
  const contract = writeReactNativeApiContract({
    sdkPath: root,
    expectedCommit: revision,
    expectedVersion: '0.0.65',
    output,
  });

  assert.equal(readFileSync(output, 'utf8'), `${JSON.stringify(contract, null, 2)}\n`);
  assert.deepEqual(validateReactNativeApiContract(contract), contract);

  const corrupted = structuredClone(contract);
  corrupted.surfaceDigest = '0'.repeat(64);
  assert.throws(() => validateReactNativeApiContract(corrupted), /surfaceDigest/);
});

test('verifies semantic compatibility and reports changed exports', () => {
  const root = createSdkFixture();
  const revision = commitFixture(root);
  const contractPath = join(root, 'contract.json');
  writeReactNativeApiContract({
    sdkPath: root,
    expectedCommit: revision,
    expectedVersion: '0.0.65',
    output: contractPath,
  });

  assert.doesNotThrow(() =>
    verifyReactNativeApiContract({ sdkPath: root, contract: contractPath })
  );

  const indexPath = join(root, 'src', 'index.ts');
  writeFileSync(
    indexPath,
    readFileSync(indexPath, 'utf8').replace(
      'configure(value?: string): Promise<void>',
      'configure(value: number): Promise<void>'
    )
  );
  assert.throws(
    () => verifyReactNativeApiContract({ sdkPath: root, contract: contractPath }),
    /changed exports: Client/
  );
});
