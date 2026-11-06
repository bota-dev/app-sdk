import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve('react-native-builder-bob/package.json'));
const glob = builder('glob');
const matcher = createRequire(builder.resolve('glob/package.json'));

test('the build glob bounds advisory pattern amplification', () => {
  const { Minimatch } = matcher('minimatch');
  const pattern = Array(8).fill('**/../a/b').join('/');
  const result = new Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: 16 });
  assert.equal(result.set.length, 16);
  const ordinary = new Minimatch('**/../a/b/**/../c/d', { optimizationLevel: 2 });
  assert.equal(ordinary.match('../a/b/../c/d'), true);
  assert.equal(ordinary.match('x/a/b/y/c/d'), true);
  assert.equal(ordinary.match('x/a/b/y/c/e'), false);
  assert.equal(matcher('minimatch/package.json').version, '11.0.1');
  const fixed = createRequire(matcher.resolve('minimatch/package.json'));
  assert.equal(fixed('@isaacs/nonrecursive-glob-match/package.json').version, '1.0.1');
});

test('the actual build glob preserves file, brace, dot and ignore selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bota-build-globs-'));
  try {
    const files = ['index.ts', 'nested/module.ts', 'nested/module.mts', 'assets/config.json',
      '.hidden.ts', '__tests__/trap.ts', 'fixtures/trap.ts'];
    for (const file of files) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), '');
    }
    const options = { cwd: root, absolute: true, nodir: true,
      ignore: ['**/__tests__/**', '**/fixtures/**'] };
    const select = async (pattern, extra = {}) => (await glob.glob(pattern, { ...options, ...extra }))
      .map(file => relative(root, file).replaceAll('\\', '/')).sort();
    assert.deepEqual(await select('**/*'),
      ['assets/config.json', 'index.ts', 'nested/module.mts', 'nested/module.ts']);
    assert.deepEqual(await select('**/*.{ts,mts}'),
      ['index.ts', 'nested/module.mts', 'nested/module.ts']);
    assert.deepEqual(await select('**/*.ts', { dot: true }),
      ['.hidden.ts', 'index.ts', 'nested/module.ts']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the installed compiler accepts valid source and rejects a semantic error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bota-build-compiler-'));
  try {
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      strict: true, noEmit: true, types: [], target: 'ES2022', module: 'NodeNext',
      moduleResolution: 'NodeNext', skipLibCheck: true }, files: ['input.ts'] }));
    const compile = () => spawnSync(process.execPath,
      [require.resolve('typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')],
      { cwd: root, encoding: 'utf8', timeout: 30000 });
    await writeFile(join(root, 'input.ts'), 'export const answer: number = 42;\n');
    const valid = compile();
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    await writeFile(join(root, 'input.ts'), 'export const answer: number = "invalid";\n');
    const invalid = compile();
    assert.equal(invalid.status, 2);
    assert.match(invalid.stdout + invalid.stderr, /TS2322/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
