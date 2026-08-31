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
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildReactNativeApiContract,
  extractReactNativeApi,
  surfaceDigest,
  validateReactNativeApiBaseline,
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
  const externalBaseLock = {
    version: '1.0.0',
    resolved: 'https://registry.example/external-base-1.0.0.tgz',
    integrity: 'sha512-fixture',
  };
  writeJson(join(root, 'package-lock.json'), {
    name: '@bota.dev/react-native-sdk',
    version: '0.0.65',
    lockfileVersion: 3,
    packages: {
      '': {
        name: '@bota.dev/react-native-sdk',
        version: '0.0.65',
        dependencies: { 'external-base': '1.0.0' },
      },
      'node_modules/external-base': externalBaseLock,
    },
  });
  writeJson(join(root, 'node_modules', '.package-lock.json'), {
    name: '@bota.dev/react-native-sdk',
    version: '0.0.65',
    lockfileVersion: 3,
    packages: {
      'node_modules/external-base': externalBaseLock,
    },
  });
  writeFileSync(
    join(root, 'node_modules', 'external-base', 'index.d.ts'),
    'export declare class ExternalBase { static inherited: boolean; external(): void; }\n'
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
  static create(): Zebra { return new Zebra(); }
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
    ['external', 'label', 'ping']
  );
  assert.deepEqual(
    zebra.staticMembers.map((member) => member.name),
    ['create', 'inherited']
  );
  assert.equal(zebra.members.find((member) => member.name === 'label').optional, true);
  assert.equal(zebra.members.find((member) => member.name === 'label').readonly, true);
  assert.ok(!zebra.members.some((member) => member.name === 'hidden'));
  assert.ok(!zebra.members.some((member) => member.name === 'secret'));

  const alpha = surface.exports.find((entry) => entry.name === 'Alpha');
  assert.match(alpha.declaredType, /"a"/);
  assert.match(alpha.declaredType, /"b"/);
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

test('digest detects type-alias and static-member changes', () => {
  const root = createSdkFixture();
  const indexPath = join(root, 'src', 'index.ts');
  const original = extractReactNativeApi(root);
  const source = readFileSync(indexPath, 'utf8');

  writeFileSync(indexPath, source.replace("'a' | 'b'", "'a' | 'c'"));
  assert.notEqual(surfaceDigest(extractReactNativeApi(root)), surfaceDigest(original));

  writeFileSync(indexPath, source.replace('static create()', 'static make()'));
  assert.notEqual(surfaceDigest(extractReactNativeApi(root)), surfaceDigest(original));
});

test('requires installed declarations for imported dependencies', () => {
  const root = createSdkFixture();
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });

  assert.throws(() => extractReactNativeApi(root), /unresolved dependencies/);
});

test('requires installed dependencies to match package-lock.json', () => {
  const root = createSdkFixture();
  const hiddenLockPath = join(root, 'node_modules', '.package-lock.json');
  const hiddenLock = JSON.parse(readFileSync(hiddenLockPath, 'utf8'));
  const installedPackagePath = join(
    root,
    'node_modules',
    'external-base',
    'package.json'
  );
  const installedPackage = JSON.parse(readFileSync(installedPackagePath, 'utf8'));
  installedPackage.version = '2.0.0';
  writeJson(installedPackagePath, installedPackage);

  assert.throws(() => extractReactNativeApi(root), /run npm ci/);

  installedPackage.version = '1.0.0';
  writeJson(installedPackagePath, installedPackage);
  hiddenLock.packages['node_modules/external-base'].version = '2.0.0';
  writeJson(hiddenLockPath, hiddenLock);
  assert.throws(() => extractReactNativeApi(root), /run npm ci/);
});

test('allows lock-recorded optional dependencies omitted by npm', () => {
  const root = createSdkFixture();
  const expectedLockPath = join(root, 'package-lock.json');
  const expectedLock = JSON.parse(readFileSync(expectedLockPath, 'utf8'));
  const optionalPackage = { version: '1.0.0', optional: true };
  expectedLock.packages['node_modules/optional-base'] = optionalPackage;
  writeJson(expectedLockPath, expectedLock);

  assert.doesNotThrow(() => extractReactNativeApi(root));
});

test('allows platform-optional dependencies claimed by npm but absent on disk', () => {
  const root = createSdkFixture();
  const expectedLockPath = join(root, 'package-lock.json');
  const hiddenLockPath = join(root, 'node_modules', '.package-lock.json');
  const expectedLock = JSON.parse(readFileSync(expectedLockPath, 'utf8'));
  const hiddenLock = JSON.parse(readFileSync(hiddenLockPath, 'utf8'));
  const optionalPackage = { version: '1.0.0', optional: true };
  expectedLock.packages['node_modules/optional-base'] = optionalPackage;
  hiddenLock.packages['node_modules/optional-base'] = optionalPackage;
  writeJson(expectedLockPath, expectedLock);
  writeJson(hiddenLockPath, hiddenLock);

  assert.doesNotThrow(() => extractReactNativeApi(root));
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

  const malformed = structuredClone(contract);
  malformed.surface.exports[0].runtime = 'yes';
  malformed.surfaceDigest = surfaceDigest(malformed.surface);
  assert.throws(() => validateReactNativeApiContract(malformed), /runtime/);

  const impossible = structuredClone(contract);
  impossible.surface.exports[0] = {
    name: impossible.surface.exports[0].name,
    runtime: false,
    declarationKinds: [],
    callSignatures: [],
    constructSignatures: [],
    members: [],
    staticMembers: [],
  };
  impossible.surfaceDigest = surfaceDigest(impossible.surface);
  assert.throws(
    () => validateReactNativeApiContract(impossible),
    /declarationKinds|declaredType/
  );
});

function createBaselineMetadataFixture() {
  const root = createSdkFixture();
  const revision = commitFixture(root);
  const contract = buildReactNativeApiContract({
    sdkPath: root,
    expectedCommit: revision,
    expectedVersion: '0.0.65',
  });

  const metadata = {
    package: '@bota.dev/react-native-sdk',
    packageVersion: '0.0.65',
    sourceRevision: contract.sourceRevision,
    publicApi: {
      contract: 'protocol/baseline/react-native-public-api-0.0.65.json',
      surfaceDigest: contract.surfaceDigest,
    },
  };
  return { contract, metadata };
}

test('accepts equivalent relative and absolute baseline contract paths', () => {
  const { contract, metadata } = createBaselineMetadataFixture();
  assert.doesNotThrow(() =>
    validateReactNativeApiBaseline({
      contract,
      metadata,
      contractPath: 'protocol/baseline/react-native-public-api-0.0.65.json',
    })
  );
  assert.doesNotThrow(() =>
    validateReactNativeApiBaseline({
      contract,
      metadata,
      contractPath: resolve(
        'protocol/baseline/react-native-public-api-0.0.65.json'
      ),
    })
  );
});

test('CLI validates absolute baseline paths outside the repository cwd', () => {
  const root = createSdkFixture();
  const revision = commitFixture(root);
  const contract = buildReactNativeApiContract({
    sdkPath: root,
    expectedCommit: revision,
    expectedVersion: '0.0.65',
  });
  const baselineDirectory = join(root, 'protocol', 'baseline');
  mkdirSync(baselineDirectory, { recursive: true });
  const contractPath = join(baselineDirectory, 'contract.json');
  const metadataPath = join(baselineDirectory, 'metadata.json');
  writeJson(contractPath, contract);
  writeJson(metadataPath, {
    package: contract.package,
    packageVersion: contract.packageVersion,
    sourceRevision: contract.sourceRevision,
    publicApi: {
      contract: 'protocol/baseline/contract.json',
      surfaceDigest: contract.surfaceDigest,
    },
  });
  const outside = mkdtempSync(join(tmpdir(), 'bota-rn-api-cwd-'));
  temporaryDirectories.push(outside);
  const cli = fileURLToPath(new URL('./react-native-api-contract.mjs', import.meta.url));

  assert.doesNotThrow(() =>
    execFileSync(
      process.execPath,
      [
        cli,
        'validate',
        '--contract',
        contractPath,
        '--baseline-metadata',
        metadataPath,
      ],
      { cwd: outside, encoding: 'utf8' }
    )
  );
});

test('rejects baseline metadata with a different package', () => {
  const { contract, metadata } = createBaselineMetadataFixture();
  metadata.package = '@bota.dev/wrong-sdk';
  assert.throws(
    () =>
      validateReactNativeApiBaseline({
        contract,
        metadata,
        contractPath: 'protocol/baseline/react-native-public-api-0.0.65.json',
      }),
    /metadata package/
  );
});

test('rejects baseline metadata with a different source revision', () => {
  const { contract, metadata } = createBaselineMetadataFixture();
  metadata.sourceRevision = 'f'.repeat(40);
  assert.throws(
    () =>
      validateReactNativeApiBaseline({
        contract,
        metadata,
        contractPath: 'protocol/baseline/react-native-public-api-0.0.65.json',
      }),
    /metadata sourceRevision/
  );
});

test('rejects baseline metadata with a different surface digest', () => {
  const { contract, metadata } = createBaselineMetadataFixture();
  metadata.publicApi.surfaceDigest = 'f'.repeat(64);
  assert.throws(
    () =>
      validateReactNativeApiBaseline({
        contract,
        metadata,
        contractPath: 'protocol/baseline/react-native-public-api-0.0.65.json',
      }),
    /baseline metadata surfaceDigest/
  );
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
    /changed members: Client\.configure/
  );
});
