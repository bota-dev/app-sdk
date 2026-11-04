import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

for (const name of ['client-v1.json', 'capture-v1.json']) {
  const fixture = readFileSync(new URL(`protocol/speech-session/${name}`, root));
  for (const directory of [
    'platforms/apple/Tests/BotaAppSDKTests/Resources/SpeechFixtures/',
    'platforms/android/sdk/src/androidTest/assets/SpeechFixtures/',
  ]) {
    const path = new URL(`${directory}${name}`, root);
    if (process.argv.includes('--write')) {
      mkdirSync(new URL(directory, root), { recursive: true });
      writeFileSync(path, fixture);
    } else if (!readFileSync(path).equals(fixture)) {
      throw new Error(`Stale native speech fixture: ${fileURLToPath(path)}`);
    }
  }
}
console.log('Native speech fixtures match the shared policy fixture.');
