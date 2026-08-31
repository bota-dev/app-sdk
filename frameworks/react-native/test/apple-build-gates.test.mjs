import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));

test('Apple build tooling is pinned and exposes local and remote gates', () => {
  const gemfile = readFileSync(new URL('../Gemfile', import.meta.url), 'utf8');
  const lockfile = readFileSync(new URL('../Gemfile.lock', import.meta.url), 'utf8');
  const workflow = readFileSync(
    new URL('../../../.github/workflows/ci.yml', import.meta.url),
    'utf8'
  );

  assert.match(gemfile, /gem "cocoapods", "1\.16\.2"/);
  assert.match(gemfile, /gem "nkf", "0\.2\.0"/);
  assert.match(gemfile, /gem "xcodeproj", "1\.27\.0"/);
  assert.match(lockfile, /cocoapods \(1\.16\.2\)/);
  assert.match(lockfile, /xcodeproj \(1\.27\.0\)/);
  assert.equal(
    packageJson.scripts['test:apple:spm-workaround'],
    'ruby test/apple-spm-workaround.test.rb'
  );
  assert.ok(
    packageJson.files.includes('scripts/bota_device_sdk_spm_workaround.rb')
  );
  assert.equal(
    packageJson.scripts['test:apple:remote-resolution'],
    '../../tools/react-native/test-apple-adapter.sh remote'
  );
  assert.match(workflow, /DEVELOPER_DIR: \/Applications\/Xcode_26\.3\.app\/Contents\/Developer/);
  assert.match(workflow, /BOTA_EXPECTED_RUBY_VERSION: "3\.3\.12"/);
  assert.match(workflow, /BOTA_EXPECTED_XCODE_BUILD: 17C529/);
  assert.match(workflow, /npm run test:apple:spm-workaround/);
  assert.match(workflow, /bundle _2\.6\.9_ exec npm run test:apple:remote-resolution/);
});

test('remote consumer mode omits the local Apple package override', () => {
  const generator = readFileSync(
    new URL('../../../tools/react-native/create-apple-adapter-consumer.rb', import.meta.url),
    'utf8'
  );
  const integration = readFileSync(
    new URL('../../../tools/react-native/test-apple-adapter.sh', import.meta.url),
    'utf8'
  );

  assert.match(generator, /source_mode = ARGV\.fetch\(3, "local"\)/);
  assert.match(generator, /source_mode == "local"/);
  assert.match(integration, /source_mode="\$\{1:-local\}"/);
  assert.match(integration, /-resolvePackageDependencies/);
  assert.match(integration, /Package\.resolved/);
});
