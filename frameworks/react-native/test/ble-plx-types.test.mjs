import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
test('the real pinned BLE manager satisfies the portable port without casts', () => {
  assert.equal(require('react-native-ble-plx/package.json').version, '3.5.1');
  const file = fileURLToPath(new URL('./ble-plx-types.ts', import.meta.url));
  const program = ts.createProgram([file], { strict: true, skipLibCheck: false, noEmit: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.es2022.d.ts'], types: [], esModuleInterop: true });
  const errors = ts.getPreEmitDiagnostics(program).filter(item => item.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
});
