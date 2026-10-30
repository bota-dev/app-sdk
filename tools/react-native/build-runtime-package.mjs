import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nativeRoot = join(workspace, 'frameworks/react-native');
const runtimeRoot = join(workspace, 'frameworks/react-native-runtime');
const output = join(runtimeRoot, 'lib');
const pkg = JSON.parse(readFileSync(join(runtimeRoot, 'package.json'), 'utf8'));

// Consumers use the committed executable JS; provenance checking needs no compiler.
execFileSync(process.execPath, [join(workspace, 'tools/react-native/generate-js-core.mjs'), '--provenance-only'],
  { cwd: workspace, stdio: 'inherit' });
// Build one authoritative TypeScript facade; no Cargo, Gradle or Xcode.
execFileSync(process.execPath, [join(nativeRoot, 'node_modules/react-native-builder-bob/bin/bob'), 'build'],
  { cwd: nativeRoot, stdio: 'inherit' });
if (!resolve(output).startsWith(resolve(runtimeRoot) + sep) ||
  (existsSync(output) && !realpathSync(output).startsWith(realpathSync(runtimeRoot) + sep))) {
  throw new Error('Runtime output escaped its package');
}
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const flavor of ['commonjs', 'module', 'typescript']) {
  cpSync(join(nativeRoot, 'lib', flavor), join(output, flavor), {
    recursive: true,
    filter: path => {
      const relative = path.slice(join(nativeRoot, 'lib', flavor).length).replaceAll('\\', '/');
      return !relative.endsWith('.map') && !/^\/index\./.test(relative) &&
        !(flavor !== 'typescript' && (relative === '/specs' || relative.startsWith('/specs/')));
    },
  });
  if (flavor !== 'typescript') {
    const identity = flavor === 'commonjs'
      ? `exports.SDK_PACKAGE = ${JSON.stringify(pkg.name)};\nexports.SDK_VERSION = ${JSON.stringify(pkg.version)};\n`
      : `export const SDK_PACKAGE = ${JSON.stringify(pkg.name)};\nexport const SDK_VERSION = ${JSON.stringify(pkg.version)};\n`;
    writeFileSync(join(output, flavor, 'sdkIdentity.js'), identity);
  }
}
// Emit structural adapter types from the exact Codegen contract, without an OS
// type dependency. Runtime data, signatures and event payloads stay identical.
for (const name of ['NativeBotaDeviceSDK', 'NativeBotaUploadV2Backend', 'NativeBotaLocalWifiTransport']) {
  const path = join(output, 'typescript/specs', `${name}.d.ts`);
  let source = readFileSync(path, 'utf8')
    .replace(/^import type .* from 'react-native(?:\/[^']+)?';\r?\n/gm, '')
    .replace('interface Spec extends TurboModule', 'interface Spec')
    .replace(/declare const _default: Spec \| null;\r?\nexport default _default;\r?\n/, '');
  source = 'type EventEmitter<T> = (listener: (event: T) => void) => { remove(): void };\n' + source;
  writeFileSync(path, source.replace(/^\/\/\# sourceMappingURL=.*\r?\n?/gm, ''));
}
const visit = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? visit(join(dir, entry.name)) : [join(dir, entry.name)]);
for (const path of visit(output)) {
  if (!/\.(?:js|ts)$/.test(path)) continue;
  const source = readFileSync(path, 'utf8').replace(/^\/\/\# sourceMappingURL=.*\r?\n?/gm, '');
  writeFileSync(path, source);
  if (/(?:from\s*|require\()['"]react-native/.test(source) || /extends TurboModule/.test(source)) {
    throw new Error(`Native dependency in runtime output: ${path}`);
  }
}
writeFileSync(join(output, 'typescript/sdkIdentity.d.ts'),
  `export declare const SDK_PACKAGE: ${JSON.stringify(pkg.name)};\nexport declare const SDK_VERSION: ${JSON.stringify(pkg.version)};\n`);
cpSync(join(workspace, 'LICENSE'), join(runtimeRoot, 'LICENSE'));
cpSync(join(nativeRoot, 'THIRD_PARTY_NOTICES.md'), join(runtimeRoot, 'THIRD_PARTY_NOTICES.md'));
cpSync(join(nativeRoot, 'THIRD_PARTY_NOTICES'), join(runtimeRoot, 'THIRD_PARTY_NOTICES'), { recursive: true });
console.log(`Built JavaScript-only ${pkg.name}@${pkg.version}; installed OS ports are supplied by the app.`);
