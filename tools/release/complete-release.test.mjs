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

test('Flutter OIDC upload retains its registered environment identity', async () => {
  const flutterWorkflow = await readWorkflow('.github/workflows/publish-flutter.yml');
  const publisher = flutterWorkflow.slice(flutterWorkflow.indexOf('\n  publish:'));
  assert.match(publisher, /uses: dart-lang\/setup-dart\/\.github\/workflows\/publish\.yml@v1/);
  assert.match(publisher, /with:\n\s+environment: release\n/);
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
  assert.match(approval, /needs: \[verify, apple, android, react-native, web\]/);
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

test('Flutter continues only from the approved tag run and read-only jobs do not gate again', async () => {
  const flutter = await readWorkflow('.github/workflows/publish-flutter.yml');
  const gate = job(flutter, 'gate');
  assert.doesNotMatch(gate, /environment:/);
  assert.doesNotMatch(job(workflow, 'verify-flutter-publication'), /environment:/);
  assert.match(gate, /\.head_branch == \$tag/);
  assert.match(gate, /jobs\?filter=latest&per_page=100/);
  assert.match(gate, /\.name == "Approve SDK release" and \.conclusion == "success"/);
  assert.ok(gate.indexOf('Approve SDK release') < gate.indexOf('/artifacts"'));
  assert.equal((workflow.match(/environment: release-approval\n/g) ?? []).length, 2);
  assert.doesNotMatch(flutter, /environment: release-approval/);
});
