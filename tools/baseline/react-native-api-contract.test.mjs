import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  extractReactNativeApi,
  surfaceDigest,
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
