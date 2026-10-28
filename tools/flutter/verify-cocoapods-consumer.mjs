import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { publicPackageIdentifier } from '../release/package-identities.mjs';
import { ownedSpecPath, specsRepository as ownedSpecsRepository } from '../release/owned-cocoapods.mjs';

export const specsRepository = ownedSpecsRepository.gitUrl;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const rootName = value => value.split(' (')[0].split('/')[0];

export function verifyCocoaPodsConsumer({
  lock, expectedSpec, installedSpec, installedManifest, installedSdkPresent, expectedSpecChecksum, version,
  repository = specsRepository,
}) {
  ownedSpecPath(version);
  const name = publicPackageIdentifier('apple', version);
  const repositoryUrl = new URL(repository);
  assert(repositoryUrl.protocol === 'https:' && !repositoryUrl.username && !repositoryUrl.password
    && !repositoryUrl.search && !repositoryUrl.hash, 'invalid Specs repository');
  assert(isRecord(lock), 'invalid CocoaPods lock metadata');
  const observedClient = !Object.hasOwn(lock, 'COCOAPODS') ? '<missing>'
    : typeof lock.COCOAPODS === 'string' ? JSON.stringify(lock.COCOAPODS.slice(0, 64)) : '<invalid>';
  assert(lock.COCOAPODS === '1.16.2', `unexpected CocoaPods client: expected 1.16.2, observed ${observedClient}`);
  assert(Array.isArray(lock.PODS), 'missing resolved SDK');
  const entries = lock.PODS.flatMap(entry => typeof entry === 'string' ? [entry]
    : isRecord(entry) ? Object.keys(entry) : []);
  assert.deepEqual(entries.filter(entry => rootName(entry) === name), [`${name} (${version})`],
    'resolved SDK is missing, ambiguous or has a different version');
  assert(Array.isArray(lock.DEPENDENCIES)
    && lock.DEPENDENCIES.filter(entry => typeof entry === 'string' && rootName(entry) === name).length === 1
    && lock.DEPENDENCIES.includes(`${name} (= ${version})`), 'missing exact native dependency');
  assert(isRecord(lock['SPEC REPOS']), 'missing Specs repository provenance');
  const sources = Object.entries(lock['SPEC REPOS']).flatMap(([url, pods]) => {
    assert(Array.isArray(pods) && pods.every(pod => typeof pod === 'string'), 'invalid Specs repository provenance');
    return pods.filter(pod => rootName(pod) === name).map(() => url);
  });
  assert.deepEqual(sources, [repository], 'SDK did not resolve exclusively from the selected Specs repository');
  for (const section of ['EXTERNAL SOURCES', 'CHECKOUT OPTIONS']) {
    if (lock[section] === undefined) continue;
    assert(isRecord(lock[section]) && !Object.keys(lock[section]).some(key => rootName(key) === name),
      'SDK has an external override');
  }
  assert(isRecord(expectedSpec) && expectedSpec.name === name && expectedSpec.version === version,
    'indexed Podspec identity mismatch');
  const expectedUrl = `https://github.com/bota-dev/app-sdk/releases/download/v${version}/${name}.cocoapods.zip`;
  assert(isRecord(expectedSpec.source) && expectedSpec.source.http === expectedUrl
    && /^[0-9a-f]{64}$/.test(expectedSpec.source.sha256 ?? '')
    && !/^0+$/.test(expectedSpec.source.sha256), 'indexed archive identity or SHA-256 mismatch');
  assert(installedSpec === null || isDeepStrictEqual(installedSpec, expectedSpec),
    'installed Podspec differs from the indexed Podspec');
  assert(/^[0-9a-f]{40}$/.test(expectedSpecChecksum ?? '')
    && isRecord(lock['SPEC CHECKSUMS']) && lock['SPEC CHECKSUMS'][name] === expectedSpecChecksum,
  'indexed Podspec checksum does not match the lock');
  assert(isRecord(installedManifest) && isDeepStrictEqual(installedManifest, lock),
    'installed sandbox manifest differs from the consumer lock');
  assert(installedSdkPresent === true, 'installed SDK payload is missing from the sandbox');
  return { name, version, repository, artifactUrl: expectedUrl,
    artifactSha256: expectedSpec.source.sha256, cocoapodsVersion: lock.COCOAPODS,
    specificationStorage: installedSpec === null ? 'registry' : 'sandbox' };
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--repository-url') {
    console.log(specsRepository);
    return;
  }
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!['--version', '--lock', '--repos-root', '--sandbox', '--repository'].includes(key)
      || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error('invalid consumer verification arguments');
    options[key] = value;
  }
  for (const key of ['--version', '--lock', '--repos-root', '--sandbox']) {
    if (!options[key]) throw new Error(`${key} is required`);
  }
  const version = options['--version'];
  const name = publicPackageIdentifier('apple', version);
  ownedSpecPath(version);
  const repository = options['--repository'] ?? specsRepository;
  let indexedCheckout;
  let indexedSpec;
  for (const entry of await readdir(options['--repos-root'], { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const checkout = join(options['--repos-root'], entry.name);
    let origin;
    try {
      // Read only the origin of this consumer's isolated CocoaPods checkout; no shell or supplied command is used.
      origin = execFileSync('git', ['-C', checkout, 'remote', 'get-url', 'origin'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4096 }).trim();
    } catch { continue; }
    if (origin !== repository) continue;
    assert(!indexedSpec, 'multiple selected Specs repository checkouts');
    indexedCheckout = checkout;
    indexedSpec = join(checkout, ...ownedSpecPath(version).split('/'));
  }
  assert(indexedSpec, 'selected Specs repository checkout is missing');
  // Registry pods need not have a Local Podspecs copy. Bind the actual sandbox manifest
  // to the consumer lock and the selected source's JSON spec using CocoaPods' own APIs.
  // All paths are literal argv values; no executable Ruby Podspec is loaded.
  const ruby = `gem 'cocoapods', '= 1.16.2'
require 'cocoapods'
require 'json'
lock = Pod::Lockfile.from_file(Pathname.new(ARGV.fetch(0)))
abort 'consumer lock is missing' unless lock
source = Pod::Source.new(Pathname.new(ARGV.fetch(1)))
indexed_path = Pathname.new(ARGV.fetch(2)).expand_path
name = ARGV.fetch(4)
version = ARGV.fetch(5)
abort 'indexed Podspec must be the selected JSON metadata' unless indexed_path.file? &&
  indexed_path.basename.to_s == "#{name}.podspec.json" && source.specification_path(name, version) == indexed_path
expected = source.specification(name, version)
sandbox_root = Pathname.new(ARGV.fetch(3))
abort 'installed sandbox is missing' unless sandbox_root.directory?
sandbox = Pod::Sandbox.new(sandbox_root)
manifest = sandbox.manifest
abort 'installed sandbox manifest is missing' unless manifest
payload = sandbox.pod_dir(name)
payload_present = payload.directory? && !payload.symlink? && payload.realpath.parent == sandbox.root && !payload.children.empty?
local_path = sandbox.specification_path(name)
if local_path
  abort 'installed Podspec must be the selected JSON metadata' unless local_path.file? &&
    local_path.basename.to_s == "#{name}.podspec.json"
end
installed = sandbox.specification(name) if local_path
puts JSON.generate({ lock: lock.to_hash, expectedSpec: expected.to_hash, installedSpec: installed&.to_hash,
  installedManifest: manifest.to_hash, installedSdkPresent: payload_present,
  expectedSpecChecksum: expected.checksum })`;
  const parsed = JSON.parse(execFileSync('ruby', ['-e', ruby, options['--lock'], indexedCheckout,
    indexedSpec, options['--sandbox'], name, version],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }));
  console.log(JSON.stringify(verifyCocoaPodsConsumer({ ...parsed, version, repository })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
