import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ZERO = '0'.repeat(40);
const SHA = /^[0-9a-f]{40}$/;
const POD_PATH = /^Specs\/(BotaAppSDK|BotaAppleSDK)\/([^/]+)\/\1\.podspec\.json$/;
const SPEC_KEYS = new Set([
  'name', 'module_name', 'version', 'summary', 'homepage', 'license', 'authors', 'source',
  'platforms', 'cocoapods_version', 'swift_versions', 'swift_version', 'source_files',
  'vendored_frameworks', 'pod_target_xcconfig',
]);
const versionText = value => typeof value === 'string' && /^\d+(?:\.\d+)*$/.test(value);

function semver(value) {
  assert.equal(typeof value, 'string', 'version must be a string');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  assert.ok(match, 'version must be an exact semantic version without a prefix or build metadata');
  if (match[4]) for (const part of match[4].split('.')) {
    assert.ok(/^[0-9A-Za-z-]+$/.test(part), 'empty or invalid prerelease identifier');
    assert.ok(!/^\d+$/.test(part) || part === '0' || !part.startsWith('0'), 'numeric prerelease identifiers cannot have leading zeros');
  }
  assert.ok(match[1] === '1' || match[1] === '2', 'unsupported SDK major; update the identity contract explicitly');
  return match[1] === '1' ? 'BotaAppleSDK' : 'BotaAppSDK';
}

export function canonicalJson(value) {
  const sorted = (item, depth = 0) => {
    assert.ok(depth <= 32, 'podspec nesting limit exceeded');
    return Array.isArray(item) ? item.map(value => sorted(value, depth + 1))
      : item !== null && typeof item === 'object'
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key], depth + 1)])) : item;
  };
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}

export function validateSpec(path, contents) {
  const match = POD_PATH.exec(path);
  assert.ok(match, `unexpected index path: ${path}`);
  assert.ok(Buffer.byteLength(contents) <= 65_536, 'podspec exceeds the metadata size limit');
  const spec = JSON.parse(contents);
  assert.ok(spec && typeof spec === 'object' && !Array.isArray(spec), 'podspec must be an object');
  assert.equal(spec.name, match[1], 'pod name differs from its index path');
  assert.equal(spec.module_name, spec.name, 'module identity differs from pod identity');
  assert.equal(spec.version, match[2], 'version differs from its index path');
  assert.equal(semver(spec.version), spec.name, 'SDK major and public package identity disagree');
  for (const key of Object.keys(spec)) assert.ok(SPEC_KEYS.has(key), `unsupported podspec field: ${key}`);
  assert.deepEqual(spec.license, { type: 'Apache-2.0' }, 'SDK license must remain Apache-2.0');
  assert.ok(spec.source && typeof spec.source === 'object' && !Array.isArray(spec.source), 'source is required');
  assert.deepEqual(Object.keys(spec.source).sort(), ['http', 'sha256'], 'source must contain only an archive URL and SHA-256');
  assert.equal(spec.source.http,
    `https://github.com/bota-dev/app-sdk/releases/download/v${spec.version}/${spec.name}.cocoapods.zip`,
    'source must identify the immutable SDK release archive');
  assert.ok(typeof spec.source.sha256 === 'string' && /^[0-9a-f]{64}$/.test(spec.source.sha256)
    && spec.source.sha256 !== '0'.repeat(64), 'source SHA-256 must be a nonzero lowercase digest');
  if (spec.summary !== undefined) assert.ok(typeof spec.summary === 'string' && spec.summary.length > 0 && spec.summary.length <= 256, 'invalid summary');
  if (spec.homepage !== undefined) assert.equal(spec.homepage, 'https://docs.bota.dev');
  if (spec.authors !== undefined) assert.equal(spec.authors, 'Bota');
  if (spec.platforms !== undefined) {
    assert.ok(spec.platforms && typeof spec.platforms === 'object' && !Array.isArray(spec.platforms), 'invalid platforms');
    for (const [platform, version] of Object.entries(spec.platforms)) {
      assert.ok(['ios', 'osx'].includes(platform) && versionText(version), 'unsupported platform version');
    }
  }
  if (spec.cocoapods_version !== undefined) assert.equal(spec.cocoapods_version, '>= 1.13');
  for (const key of ['swift_version', 'swift_versions']) if (spec[key] !== undefined) {
    const versions = Array.isArray(spec[key]) ? spec[key] : [spec[key]];
    assert.ok(versions.length > 0 && versions.every(versionText), 'unsupported Swift version');
  }
  if (spec.source_files !== undefined) assert.equal(spec.source_files, `{,platforms/apple/}Sources/${spec.name}/**/*.swift`);
  if (spec.vendored_frameworks !== undefined) assert.equal(spec.vendored_frameworks, '{,platforms/apple/}Artifacts/BotaDeviceSDKCore.xcframework');
  if (spec.pod_target_xcconfig !== undefined) assert.deepEqual(spec.pod_target_xcconfig, {
    DEFINES_MODULE: 'YES', SWIFT_STRICT_CONCURRENCY: 'complete', SWIFT_TREAT_WARNINGS_AS_ERRORS: 'YES',
  }, 'unsupported build settings');
  assert.equal(contents, canonicalJson(spec), 'podspec must use canonical sorted JSON with one trailing newline');
  return spec;
}

export async function validateIndex(root) {
  const index = resolve(root, 'Specs');
  let count = 0;
  async function walk(path) {
    const stat = await lstat(path);
    assert.ok(!stat.isSymbolicLink(), 'symlinks are not permitted in Specs');
    if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await walk(resolve(path, entry));
    } else {
      assert.ok(stat.isFile(), 'Specs entries must be regular files');
      assert.ok(stat.size <= 65_536, 'podspec exceeds the metadata size limit');
      const name = relative(resolve(root), path).split(sep).join('/');
      validateSpec(name, await readFile(path, 'utf8'));
      count += 1;
    }
  }
  try { await lstat(index); } catch (error) {
    if (error.code === 'ENOENT') return { count: 0 };
    throw error;
  }
  await walk(index);
  return { count };
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

export function validateChanges(root, base, head = git(root, ['rev-parse', 'HEAD'])) {
  assert.ok(SHA.test(head) && head !== ZERO, 'head must be a full immutable commit SHA');
  assert.equal(git(root, ['rev-parse', 'HEAD']), head, 'head is not the checked-out source');
  assert.equal(git(root, ['rev-parse', '--is-shallow-repository']), 'false', 'append-only checks require complete Git history');
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=all', '--', 'Specs']), '', 'Specs must match the committed source');
  if (base === '' || base === ZERO) {
    let main;
    try { main = git(root, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']); } catch { /* Initial local repository. */ }
    if (main && main !== head) {
      base = git(root, ['merge-base', main, head]);
    } else {
      const parents = git(root, ['rev-list', '--parents', '-n', '1', head]).split(' ');
      base = parents[1] ?? ZERO;
    }
  }
  assert.ok(SHA.test(base), 'base must be a full immutable commit SHA');
  if (base === ZERO) return { added: git(root, ['ls-tree', '-r', '--name-only', head, '--', 'Specs']).split('\n').filter(Boolean).length };
  git(root, ['merge-base', '--is-ancestor', base, head]);
  const records = git(root, ['diff', '--name-status', '-z', '--no-renames', base, head, '--', 'Specs']).split('\0');
  if (records.at(-1) === '') records.pop();
  assert.equal(records.length % 2, 0, 'invalid Git diff record');
  for (let index = 0; index < records.length; index += 2) {
    assert.equal(records[index], 'A', `immutable Specs entry was changed: ${records[index + 1]}`);
    assert.ok(POD_PATH.test(records[index + 1]), 'only canonical podspec files may be added to Specs');
  }
  return { added: records.length / 2 };
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--base'), 'usage: validate-owned-specs.mjs [--base <full-sha-or-empty-for-first-parent>]');
  const root = process.cwd();
  const index = await validateIndex(root);
  const changes = args.length ? validateChanges(root, args[1]) : null;
  console.log(JSON.stringify({ specs: index.count, empty: index.count === 0, appendOnlyChecked: changes !== null, added: changes?.added ?? null }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
