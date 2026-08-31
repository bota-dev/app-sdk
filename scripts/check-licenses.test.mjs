import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const checker = resolve('scripts/check-licenses.mjs');

const writeInstalledPackageFixture = ({ missingEntry }) => {
  const root = mkdtempSync(join(tmpdir(), 'bota-license-package-'));
  const dependency = join(root, 'node_modules', 'permissive-package');
  mkdirSync(dependency, { recursive: true });
  writeFileSync(
    join(root, 'package-lock.json'),
    `${JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: '1.0.0', private: true },
        'node_modules/permissive-package': {
          name: 'permissive-package',
          version: '1.0.0',
        },
        'node_modules/platform-package': {
          name: 'platform-package',
          version: '1.0.0',
          ...missingEntry,
        },
      },
    })}\n`
  );
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({
      name: '@bota.dev/nested-package',
      version: '1.0.0',
      private: true,
      devDependencies: {},
    })}\n`
  );
  writeFileSync(
    join(dependency, 'package.json'),
    `${JSON.stringify({
      name: 'permissive-package',
      version: '1.0.0',
      license: 'MIT',
    })}\n`
  );
  return root;
};

const run = (fixture) =>
  spawnSync(
    process.execPath,
    ['scripts/check-licenses.mjs', '--report', `scripts/__fixtures__/${fixture}`],
    { cwd: process.cwd(), encoding: 'utf8' }
  );

test('rejects a dependency whose only license is forbidden', () => {
  const result = run('forbidden.json');
  const output = `${result.stdout}${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /forbidden-package@1\.0\.0/);
  assert.match(output, /GPL-3\.0-only/);
});

test('accepts a dual license with a permissive option', () => {
  const result = run('permissive-dual.json');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no forbidden licenses/);
});

test('uses the repository allowlist when scanning a nested package', () => {
  const root = writeInstalledPackageFixture({
    missingEntry: { optional: true },
  });

  const result = spawnSync(process.execPath, [checker], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /1 packages scanned/);
});

test('rejects a required lockfile package that is absent on disk', () => {
  const root = writeInstalledPackageFixture({ missingEntry: {} });
  const result = spawnSync(process.execPath, [checker], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /cannot inspect/);
});

test('normal repository scan reports the pinned Android release tooling dependencies', () => {
  const result = spawnSync(process.execPath, [checker], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /release tooling: fast-xml-parser@5\.11\.1, fflate@0\.8\.3/);
});
