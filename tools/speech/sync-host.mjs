import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('frameworks/shared/speechHost.ts', root), 'utf8');
const generated = '// Generated from frameworks/shared/speechHost.ts. Do not edit.\n' + source;
for (const platform of ['web', 'react-native']) {
  const path = new URL(`frameworks/${platform}/src/speechHost.ts`, root);
  if (process.argv.includes('--write')) writeFileSync(path, generated);
  else if (readFileSync(path, 'utf8') !== generated) throw new Error(`Stale shared speech host: ${fileURLToPath(path)}`);
}
console.log('Shared speech IO host synchronized for Web and React Native.');
