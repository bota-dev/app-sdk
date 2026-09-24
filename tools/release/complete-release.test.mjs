import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile('.github/workflows/release.yml', 'utf8');
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
