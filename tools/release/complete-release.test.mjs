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
  assert.match(publisher, /needs: \[flutter, publish\]\n/);
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

function jobCondition(source) {
  const match = /^    if: (.*)\n((?:      .*(?:\n|$))*)/m.exec(source);
  assert.ok(match, 'job condition is missing');
  return (match[1] === '>-' ? match[2] : match[1]).replace(/\s+/g, ' ').trim();
}

function assertApprovalTopology(source) {
  const approval = job(source, 'approve-release');
  const slack = job(source, 'approve-release-slack');
  assert.equal(jobCondition(approval), "github.event_name == 'push' && vars.SLACK_SDK_PRODUCTION_APPROVAL_ENABLED != 'true'");
  assert.equal(jobCondition(slack), "github.event_name == 'push' && vars.SLACK_SDK_PRODUCTION_APPROVAL_ENABLED == 'true'");
  assert.match(approval, /needs: verify\n/);
  assert.match(approval, /environment: release-approval\n/);
  assert.match(slack, /needs: verify\n/);
  assert.match(slack, /id-token: write\n/);
  const publish = job(source, 'publish');
  assert.match(publish, /needs: \[approve-release, approve-release-slack\]\n/);
  assert.equal(jobCondition(publish), "always() && !cancelled() && github.event_name == 'push' && "
    + "((needs.approve-release.result == 'success' && needs.approve-release-slack.result == 'skipped') || "
    + "(needs.approve-release.result == 'skipped' && needs.approve-release-slack.result == 'success'))");
}

test('tag publishing accepts exactly one approval route after completed candidate verification', () => {
  assertApprovalTopology(workflow);
  assert.match(job(workflow, 'publish'), /environment: release\n/);
  assert.match(job(workflow, 'publish-apple-pod'), /needs: publish\n/);
  for (const changed of [
    workflow.replace('needs: [approve-release, approve-release-slack]', 'needs: verify'),
    workflow.replace("needs.approve-release-slack.result == 'success'))", "needs.approve-release-slack.result == 'failure'))"),
    workflow.replace("if: github.event_name == 'push' && vars.SLACK_SDK_PRODUCTION_APPROVAL_ENABLED != 'true'",
      "if: github.event_name == 'push'"),
  ]) assert.throws(() => assertApprovalTopology(changed), 'an approval bypass passed the topology guard');
});

test('manual recovery has its own single approval', () => {
  const approval = job(workflow, 'approve-recovery');
  assert.match(approval, /if: github.event_name == 'workflow_dispatch'/);
  assert.match(approval, /environment: release-approval\n/);
  assert.match(job(workflow, 'recover-central'), /needs: approve-recovery\n/);
  assert.match(job(workflow, 'recover-central'), /environment: release\n/);
  for (const name of ['approve-recovery', 'recover-central']) {
    assert.equal(jobCondition(job(workflow, name)), "github.event_name == 'workflow_dispatch' && vars.SLACK_SDK_PRODUCTION_APPROVAL_ENABLED != 'true'",
      'manual recovery must not bypass active Slack approval');
  }
});

test('Slack requests preserve six tag artifacts and wait only after the preflight job completes', () => {
  const verify = job(workflow, 'verify');
  assert.match(verify, /name: Verify tag and promote CI artifacts\n/);
  const registration = verify.indexOf('node tools/release/slack-sdk-release.mjs register');
  assert.ok(registration > 0);
  const preserved = verify.slice(0, registration).match(/name: (?:apple|android|react-native|web|flutter)-release-\$\{\{ github.ref_name \}\}|name: release-inputs-\$\{\{ github.ref_name \}\}/g);
  assert.equal(preserved?.length, 6, 'all immutable tag payloads must exist before request registration');
  assert.match(verify.slice(registration), /if: always\(\) && vars.SLACK_SDK_PRODUCTION_APPROVAL_ENABLED == 'true'/);
  assert.match(verify.slice(registration), /name: sdk-slack-request-\$\{\{ github.ref_name \}\}-\$\{\{ github.run_attempt \}\}/);
  const slack = job(workflow, 'approve-release-slack');
  const wait = slack.indexOf('node tools/release/slack-sdk-release.mjs wait');
  assert.ok(wait > slack.indexOf('name: release-inputs-${{ github.ref_name }}'));
  assert.ok(wait > slack.indexOf('name: sdk-slack-request-${{ github.ref_name }}-${{ github.run_attempt }}'));
  assert.match(slack.slice(wait), /name: sdk-slack-approval-\$\{\{ github.ref_name \}\}-\$\{\{ github.run_attempt \}\}/);
  assert.doesNotMatch(slack, /publish-npm.mjs|gh release (create|upload|edit)|publish-preserved.sh --publish/);
});

function assertWriteRefresh(source) {
  const writes = /gh release (?:create|upload|edit)|central-portal\.mjs upload-or-resume|publish-npm\.mjs (?:react-native|web)|publish-preserved\.sh --publish/;
  const blocks = source.split(/\n      - /).slice(1).filter(block => writes.test(block));
  assert.ok(blocks.length > 0, 'publisher has no guarded writes');
  for (const block of blocks) {
    const firstWrite = block.search(writes);
    const refresh = block.indexOf('node tools/release/slack-sdk-release.mjs refresh');
    assert.ok(refresh >= 0 && refresh < firstWrite, 'publication write lost its preceding signed refresh');
    assert.match(block.slice(0, refresh), /if \[\[ "\$SLACK_SDK_PRODUCTION_APPROVAL_ENABLED" == true \]\]; then/);
  }
}

test('each publisher refreshes frozen approval before public writes while pub.dev keeps tag-push OIDC', () => {
  assert.match(workflow, /on:\n  push:\n    tags:\n      - "v\*\.\*\.\*"/);
  for (const name of ['publish', 'publish-flutter', 'complete-release']) {
    const publisher = job(workflow, name);
    assert.match(publisher, /name: sdk-slack-approval-\$\{\{ github.ref_name \}\}-\$\{\{ github.run_attempt \}\}/);
    assert.match(publisher, /name: release-inputs-\$\{\{ github.ref_name \}\}/);
    assert.match(publisher, /id-token: write/);
    assertWriteRefresh(publisher);
  }
  const publish = job(workflow, 'publish');
  assert.throws(() => assertWriteRefresh(publish.replaceAll('node tools/release/slack-sdk-release.mjs refresh', 'echo removed')));
  assert.match(job(workflow, 'complete-release'), /needs: \[verify-flutter-publication, publish\]/);
});

test('normal and recovery publication verify the original generated runtime after npm publication', async () => {
  for (const name of ['publish', 'recover-central']) {
    const publisher = job(workflow, name);
    const upload = publisher.indexOf('node tools/release/publish-npm.mjs react-native');
    const consumer = publisher.indexOf('node tools/release/verify-runtime-consumer.mjs');
    assert.ok(upload >= 0 && consumer > upload, `${name} must test the public runtime after publication`);
    assert.match(publisher, /@bota\.dev\/react-native-app-sdk@\$RELEASE_VERSION/);
    assert.match(publisher, /npm install --ignore-scripts/);
    assert.match(publisher, /VERIFY_GENERATED_RUNTIME="\$\(node tools\/release\/runtime-release-support.mjs "\$RELEASE_VERSION"\)"/);
    assert.match(publisher, /typescript\/bin\/tsc -p target\/react-native-runtime-consumer\/tsconfig\.json/);
    assert.doesNotMatch(publisher, /@bota\.dev\/react-native-app-sdk-runtime/);
  }
  const fixture = await readFile('tools/release/runtime-consumer/client.ts', 'utf8');
  assert.match(fixture, /from '@bota\.dev\/react-native-app-sdk\/runtime'/);
  const config = JSON.parse(await readFile('tools/release/runtime-consumer/tsconfig.json', 'utf8'));
  assert.equal(config.compilerOptions.strict, true);
  assert.equal(config.compilerOptions.skipLibCheck, false);
  assert.deepEqual(config.compilerOptions.lib, ['ES2022']);
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
