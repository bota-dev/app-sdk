import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { renderPublicPodspec } from './generate-public-podspec.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('unpublished pod lint uses candidate checksum without changing the release spec', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'bota-pod-evidence-'));
  try {
    for (const dir of ['tools/apple', 'tools/release', 'platforms/apple', 'target/apple-release', 'bin', 'input']) {
      await mkdir(join(fixture, dir), { recursive: true });
    }
    for (const path of ['tools/apple/test-pod-archive.sh', 'tools/release/generate-public-podspec.mjs', 'tools/release/package-identities.mjs', 'tools/release/resolve-release-channel.mjs']) {
      await copyFile(join(root, path), join(fixture, path));
    }
    await writeFile(join(fixture, 'sdk-version.toml'), 'version = "2.0.0-beta.3"\n');
    const spec = renderPublicPodspec({ sdkVersion: '2.0.0-beta.3', artifactChecksum: '1'.repeat(64) });
    const specPath = join(fixture, 'platforms/apple/BotaAppSDK.podspec');
    await writeFile(specPath, spec);
    await writeFile(join(fixture, 'input/LICENSE'), 'test fixture');
    const archive = join(fixture, 'target/apple-release/BotaAppSDK.cocoapods.zip');
    assert.equal(spawnSync('zip', ['-q', archive, 'LICENSE'], { cwd: join(fixture, 'input') }).status, 0);
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    await writeFile(`${archive}.sha256`, `${digest}  BotaAppSDK.cocoapods.zip\n`);
    // CocoaPods is the external compiler; exercise real archive and spec validation here.
    await writeFile(join(fixture, 'bin/pod'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'ipc') {
  const spec = fs.readFileSync(process.argv[4], 'utf8');
  console.log(JSON.stringify({version: spec.match(/spec.version = "([^"]+)"/)[1], source: {sha256: spec.match(/sha256: "([^"]+)"/)[1]}}));
} else {
  fs.writeFileSync(process.env.LINT_MARKER, fs.readFileSync(process.argv[4]));
}
`, { mode: 0o755 });
    const marker = join(fixture, 'linted-spec');
    const run = (...args) => spawnSync('bash', ['tools/apple/test-pod-archive.sh', ...args], {
      cwd: fixture, encoding: 'utf8', env: { ...process.env, PATH: `${join(fixture, 'bin')}:${process.env.PATH}`, LINT_MARKER: marker },
    });
    assert.notEqual(run().status, 0, 'release mode must reject a stale checksum');
    const evidence = run('--evidence-only');
    assert.equal(evidence.status, 0, evidence.stdout + evidence.stderr);
    assert.match(await readFile(marker, 'utf8'), new RegExp(digest));
    assert.equal(await readFile(specPath, 'utf8'), spec, 'source manifest remains immutable');
    assert.notEqual(run('--unknown').status, 0);
    await writeFile(`${archive}.sha256`, `${'2'.repeat(64)}  BotaAppSDK.cocoapods.zip\n`);
    assert.notEqual(run('--evidence-only').status, 0, 'evidence mode still rejects corrupt archives');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('only non-publishing CI selects pod evidence mode', async () => {
  const ci = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8');
  const release = await readFile(join(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(ci, /test-pod-archive\.sh --evidence-only/);
  assert.doesNotMatch(release, /test-pod-archive\.sh --evidence-only/);
});
