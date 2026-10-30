import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(pkg, '../..');
const assets = [
  ['platforms/apple/Sources/BotaAppSDK/LocalWiFi/LocalWiFiHTTP.swift', 'apple/LocalWiFiHTTP.swift'],
  ['platforms/apple/Sources/BotaAppSDK/LocalWiFi/LocalWiFiHotspot.swift', 'apple/LocalWiFiHotspot.swift'],
  ['platforms/android/sdk/src/main/kotlin/dev/bota/sdk/localwifi/LocalWiFiHTTP.kt', 'android/LocalWiFiHTTP.kt'],
  ['platforms/android/sdk/src/main/kotlin/dev/bota/sdk/localwifi/LocalWiFiNetwork.kt', 'android/LocalWiFiNetwork.kt'],
  ['frameworks/react-native/ios/BotaLocalWifiTransportBridge.swift', 'apple/BotaLocalWifiTransportBridge.swift'],
  ['frameworks/react-native/ios/BotaLocalWifiTransport.mm', 'apple/BotaLocalWifiTransport.mm'],
  ['frameworks/react-native/android/src/main/java/dev/bota/sdk/reactnative/localwifi/BotaLocalWifiTransportModule.kt', 'android/BotaLocalWifiTransportModule.kt'],
  ['frameworks/react-native/src/specs/NativeBotaLocalWifiTransport.ts', 'specs/NativeBotaLocalWifiTransport.ts'],
];
const check = process.argv.includes('--check');
const manifest = [];
function publish(relative, bytes) {
  const target = resolve(pkg, 'native-io/generated', relative);
  if (check) {
    if (!readFileSync(target).equals(bytes)) throw new Error(`Stale local WiFi native asset: ${relative}`);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}
for (const [source, destination] of assets) {
  const bytes = readFileSync(resolve(repository, source));
  publish(destination, bytes);
  manifest.push({ source, destination, sha256: createHash('sha256').update(bytes).digest('hex') });
}
publish('sources.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
const metadata = JSON.parse(readFileSync(resolve(pkg, 'package.json'), 'utf8'));
const nativeMetadata = {
  name: metadata.name, version: metadata.version, description: metadata.description,
  license: metadata.license, author: metadata.author, repository: metadata.repository,
  codegenConfig: { ...metadata.codegenConfig, jsSrcsDir: './generated/specs' },
};
publish('../package.json', Buffer.from(JSON.stringify(nativeMetadata, null, 2) + '\n'));
console.log(`Local WiFi native assets ${check ? 'verified' : 'prepared'} (${assets.length})`);
