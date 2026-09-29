import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readWorkflow = async path => (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
const workflow = await readWorkflow('.github/workflows/release.yml');
const completion = workflow.slice(workflow.indexOf('\n  complete-release:'));

test('release completion identifies the repository without a checkout', () => {
  const commands = completion.match(/^\s+gh release .+$/gm);
  assert.equal(commands?.length, 2);
  for (const command of commands) {
    assert.match(command, /--repo "\$GITHUB_REPOSITORY"/);
  }
});

test('Flutter completion preserves the previously published native manifest', () => {
  const rename = completion.indexOf('mv target/flutter-release/release-manifest.json');
  assert.ok(rename >= 0);
  assert.match(completion.slice(rename), /target\/flutter-release\/flutter-release-manifest\.json/);
  assert.ok(rename < completion.indexOf('gh release upload'));
});

test('Flutter OIDC upload retains its registered identity and checks occupied versions on every retry', () => {
  const publisher = job(workflow, 'publish-flutter');
  assert.match(publisher, /needs: flutter\n/);
  assert.match(publisher, /if: \$\{\{ !cancelled\(\) && github.event_name == 'push' && needs.flutter.result == 'success' \}\}/);
  assert.match(publisher, /uses: dart-lang\/setup-dart@[0-9a-f]{40}/);
  assert.match(publisher, /environment: release\n/);
  assert.match(publisher, /prepare-publication.mjs/);
  assert.ok(publisher.indexOf('prepare-publication.mjs') < publisher.indexOf('uses: dart-lang'));
  assert.match(publisher, /if: steps.public-version.outputs.needs-publish == 'true'/);
  assert.match(publisher, /tools\/flutter\/publish-preserved.sh --publish/);
});

function job(source, name) {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `missing ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n  [\w-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test('tag publishing has one approval after all package gates', () => {
  const approval = job(workflow, 'approve-release');
  assert.match(approval, /if: github.event_name == 'push'/);
  assert.match(approval, /needs: verify\n/);
  assert.match(approval, /environment: release-approval\n/);
  assert.match(job(workflow, 'publish'), /needs: approve-release\n/);
  assert.match(job(workflow, 'publish'), /environment: release\n/);
  assert.match(job(workflow, 'publish-apple-pod'), /needs: publish\n/);
});

test('manual recovery has its own single approval', () => {
  const approval = job(workflow, 'approve-recovery');
  assert.match(approval, /if: github.event_name == 'workflow_dispatch'/);
  assert.match(approval, /environment: release-approval\n/);
  assert.match(job(workflow, 'recover-central'), /needs: approve-recovery\n/);
  assert.match(job(workflow, 'recover-central'), /environment: release\n/);
});

test('Flutter continues through the approved dependency graph without cross-workflow polling', () => {
  const flutter = job(workflow, 'flutter');
  assert.doesNotMatch(flutter, /environment:/);
  assert.doesNotMatch(job(workflow, 'verify-flutter-publication'), /environment:/);
  assert.match(flutter, /needs: \[publish, publish-apple-pod, smoke-public-package, smoke-public-android\]/);
  assert.match(job(workflow, 'verify-flutter-publication'), /needs: publish-flutter/);
  assert.equal((workflow.match(/environment: release-approval\n/g) ?? []).length, 2);
  assert.doesNotMatch(flutter, /package-release.sh|actions\/workflows/);
  assert.match(job(workflow, 'verify'), /promote-ci.mjs/);
  assert.doesNotMatch(workflow, /tools\/(apple|android|flutter)\/package-release.sh|npm.*pack --pack-destination/);
});

test('CI dry-runs the same extracted and locked Flutter package used for publication', async () => {
  const ci = await readWorkflow('.github/workflows/ci.yml');
  const staging = await readWorkflow('tools/flutter/publish-preserved.sh');
  assert.match(ci, /tools\/flutter\/publish-preserved.sh --dry-run/);
  assert.ok(ci.indexOf('publish-preserved.sh --dry-run') < ci.indexOf('name: Upload Flutter candidate'));
  assert.match(staging, /verify-candidate/);
  assert.match(staging, /tar -xzf.*--directory "\$PUBLISH_ROOT"/);
  assert.match(staging, /pub get --enforce-lockfile --no-example/);
  assert.match(staging, /pub publish --dry-run/);
  assert.match(staging, /pub publish --force/);
});
