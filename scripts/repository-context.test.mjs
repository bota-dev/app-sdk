import assert from 'node:assert/strict';
import { lstat, readFile, readlink } from 'node:fs/promises';
import test from 'node:test';

const requiredFiles = [
  'AGENTS.md',
  'ARCHITECTURE.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
];

const publicContextFiles = requiredFiles.filter((path) => path.endsWith('.md'));

test('public repository context files are present', async () => {
  await Promise.all(requiredFiles.map((path) => lstat(path)));
});

test('CLAUDE.md uses AGENTS.md as its canonical context', async () => {
  const metadata = await lstat('CLAUDE.md');

  assert.equal(metadata.isSymbolicLink(), true);
  assert.equal(await readlink('CLAUDE.md'), 'AGENTS.md');
});

test('public repository context has no developer-specific paths', async () => {
  for (const path of publicContextFiles) {
    const contents = await readFile(path, 'utf8');
    assert.doesNotMatch(contents, /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/);
  }
});
