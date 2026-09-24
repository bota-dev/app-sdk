import { parseReleaseRef } from './resolve-release-channel.mjs';
import { pathToFileURL } from 'node:url';

const historical = new Map([
  ['apple', 'BotaAppleSDK'],
  ['android', 'dev.bota:bota-android-sdk'],
  ['react-native', '@bota.dev/react-native-sdk'],
  ['web', '@bota.dev/web-sdk'],
  ['flutter', 'bota_flutter_sdk'],
  ['windows', 'Bota.WindowsSdk'],
  ['electron', '@bota.dev/electron-sdk'],
]);
const renamed = new Map([
  ['apple', 'BotaAppSDK'],
  ['android', 'dev.bota:bota-app-sdk'],
  ['react-native', '@bota.dev/react-native-app-sdk'],
  ['web', '@bota.dev/web-app-sdk'],
  ['flutter', 'bota_app_sdk'],
]);

export function publicPackageIdentifier(platform, sdkVersion) {
  const version = parseReleaseRef(`v${sdkVersion}`);
  const major = Number(version.split('.')[0]);
  const packages = major <= 1 ? historical : major === 2 ? renamed : undefined;
  const identifier = packages?.get(platform);
  if (!identifier) throw new Error(`unsupported SDK package identity: ${platform} at version ${sdkVersion}`);
  return identifier;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) throw new Error('usage: package-identities.mjs <platform> <version>');
  console.log(publicPackageIdentifier(process.argv[2], process.argv[3]));
}
