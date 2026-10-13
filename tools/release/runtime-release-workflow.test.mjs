import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = (await readFile('.github/workflows/release-react-native-runtime.yml', 'utf8')).replaceAll('\r\n', '\n');
const verify = workflow.slice(workflow.indexOf('\n  verify:'), workflow.indexOf('\n  approve-release:'));
const approval = workflow.slice(workflow.indexOf('\n  approve-release:'), workflow.indexOf('\n  publish:'));
const publish = workflow.slice(workflow.indexOf('\n  publish:'));

test('runtime publication keeps the existing approval between byte verification and registry writes', () => {
  assert.match(verify, /promote-runtime-ci\.mjs/);
  assert.match(verify, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(approval, /needs: verify\n/);
  assert.match(approval, /environment: release-approval\n/);
  assert.match(publish, /needs: \[verify, approve-release\]/);
  assert.match(publish, /environment: release\n/);
  assert.equal((workflow.match(/environment: release-approval\n/g) ?? []).length, 1);
  assert.doesNotMatch(verify + approval, /id-token: write/);
  assert.match(publish, /id-token: write/);
});

test('independent runtime cannot trigger family tags, cancel releases, rebuild payloads or use stored publication tokens', () => {
  assert.match(workflow, /on:\n  workflow_dispatch:/);
  assert.match(verify, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /\n  push:|\n  workflow_call:|NODE_AUTH_TOKEN:|NPM_TOKEN:|npm.*\bpack\b|cargo build|generate-js-core|package-release\.sh/);
  assert.equal((workflow.match(/uses: /g) ?? []).length, (workflow.match(/uses: [\w/-]+@[a-f0-9]{40}/g) ?? []).length);
  assert.doesNotMatch(workflow.match(/run:.*$/gm)?.join('\n') ?? '', /\$\{\{\s*inputs\./);
});

test('runtime public execution and declaration checks follow exact archive publication', () => {
  const write = publish.indexOf('publish-runtime-npm.mjs publish');
  const install = publish.indexOf('npm install --ignore-scripts');
  assert.ok(write > publish.indexOf('actions/download-artifact@'));
  assert.ok(install > write);
  assert.ok(publish.indexOf('verify-runtime-consumer.mjs') > install);
  assert.ok(publish.indexOf('typescript/bin/tsc') > install);
});
