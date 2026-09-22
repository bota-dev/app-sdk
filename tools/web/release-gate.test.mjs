import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import * as packageVerifier from './verify-package.mjs'

test('consumer verifies once and browser receives the exact inventory evidence', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'bota-web-release-gate-'))
  const trace = join(fixture, 'trace.log')
  try {
    for (const script of ['test-consumer.sh', 'test-browser.sh']) {
      const destination = join(fixture, 'tools/web', script)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(join('tools/web', script), destination)
      chmodSync(destination, 0o755)
    }
    mkdirSync(join(fixture, 'frameworks/web'), { recursive: true })
    mkdirSync(
      join(fixture, 'tests/consumers/web-vite/node_modules/@bota.dev/web-sdk'),
      { recursive: true },
    )
    mkdirSync(join(fixture, 'bin'), { recursive: true })
    writeExecutable(join(fixture, 'bin/npm'), `#!/bin/sh
printf 'npm %s\n' "$*" >> "$TRACE"
`)
    writeExecutable(join(fixture, 'bin/npx'), `#!/bin/sh
printf 'npx %s\n' "$*" >> "$TRACE"
destination=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '--pack-destination' ]; then destination="$argument"; fi
  previous="$argument"
done
if [ -n "$destination" ]; then
  mkdir -p "$destination"
  printf 'packed' > "$destination/bota.dev-web-sdk-test.tgz"
fi
`)
    writeExecutable(join(fixture, 'bin/node'), `#!/bin/sh
printf 'node %s\n' "$*" >> "$TRACE"
inventory=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '--inventory' ]; then inventory="$argument"; fi
  previous="$argument"
done
if [ -n "$inventory" ]; then
  printf '{}\n' > "$inventory"
  printf 'fixture  web-package-files.json\n' > "$inventory.sha256"
fi
`)

    execFileSync('/bin/bash', [join(fixture, 'tools/web/test-consumer.sh')], {
      cwd: fixture,
      env: {
        ...process.env,
        PATH: `${join(fixture, 'bin')}:/usr/bin:/bin`,
        TRACE: trace,
      },
      stdio: 'pipe',
    })

    const calls = readFileSync(trace, 'utf8').trim().split('\n')
    const packageVerifierCalls = calls.filter((line) =>
      line.includes('/tools/web/verify-package.mjs '))
    const installedVerifierCalls = calls.filter((line) =>
      line.includes('/tools/web/verify-installed-package.mjs '))
    assert.equal(packageVerifierCalls.length, 1)
    assert.equal(installedVerifierCalls.length, 1)
    assert.match(
      installedVerifierCalls[0],
      /bota\.dev-web-sdk-test\.tgz .*web-package-files\.json .*web-package-files\.json\.sha256/,
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('browser evidence rejects a mismatched inventory checksum', () => {
  withEvidenceFixture((fixture) => {
    assert.doesNotThrow(() => verifyEvidence(fixture))
    writeFileSync(fixture.checksum, `${'0'.repeat(64)}  web-package-files.json\n`)
    assert.throws(
      () => verifyEvidence(fixture),
      /inventory checksum does not match/,
    )
  })
})

test('browser evidence rejects an inventory from a stale source revision', () => {
  withEvidenceFixture((fixture) => {
    fixture.value.sourceRevision = '0'.repeat(40)
    writeInventory(fixture)
    assert.throws(
      () => verifyEvidence(fixture),
      /inventory source revision does not match HEAD/,
    )
  })
})

test('browser evidence rejects tarball drift', () => {
  withEvidenceFixture((fixture) => {
    writeFileSync(fixture.tarball, 'changed tarball')
    assert.throws(
      () => verifyEvidence(fixture),
      /tarball does not match verified inventory/,
    )
  })
})

test('browser evidence rejects installed-package drift', () => {
  withEvidenceFixture((fixture) => {
    writeFileSync(join(fixture.installed, 'dist/index.js'), 'changed package')
    assert.throws(
      () => verifyEvidence(fixture),
      /installed package does not match verified tarball inventory/,
    )
  })
})

function writeExecutable(path, contents) {
  writeFileSync(path, contents)
  chmodSync(path, 0o755)
}

function withEvidenceFixture(assertion) {
  const root = mkdtempSync(join(tmpdir(), 'bota-web-release-evidence-'))
  const tarball = join(root, 'bota.dev-web-sdk-test.tgz')
  const inventory = join(root, 'web-package-files.json')
  const checksum = `${inventory}.sha256`
  const installed = join(root, 'installed')
  const tarballContents = Buffer.from('packed tarball')
  const packageContents = Buffer.from('export {}\n')
  mkdirSync(join(installed, 'dist'), { recursive: true })
  writeFileSync(tarball, tarballContents)
  writeFileSync(join(installed, 'dist/index.js'), packageContents)
  const files = [{
    path: 'package/dist/index.js',
    byteLength: packageContents.byteLength,
    sha256: sha256(packageContents),
  }]
  const value = {
    schemaVersion: 1,
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    tarball: {
      name: 'bota.dev-web-sdk-test.tgz',
      byteLength: tarballContents.byteLength,
      sha256: sha256(tarballContents),
      normalizedContentSha256: sha256(`${JSON.stringify(files)}\n`),
    },
    files,
  }
  const fixture = {
    root,
    tarball,
    inventory,
    checksum,
    installed,
    value,
  }
  try {
    writeInventory(fixture)
    assertion(fixture)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeInventory(fixture) {
  const serialized = `${JSON.stringify(fixture.value, null, 2)}\n`
  writeFileSync(fixture.inventory, serialized)
  writeFileSync(
    fixture.checksum,
    `${sha256(serialized)}  web-package-files.json\n`,
  )
}

function verifyEvidence(fixture) {
  return packageVerifier.verifyInstalledPackageEvidence(
    fixture.tarball,
    fixture.inventory,
    fixture.checksum,
    fixture.installed,
    { workspaceRoot: process.cwd() },
  )
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}
