import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const CHECKSUM = /^[0-9a-f]{64}$/;

export function renderPublicSwiftPackage({ sdkVersion, artifactChecksum }) {
  if (typeof sdkVersion !== 'string' || !VERSION.test(sdkVersion)) {
    throw new Error('SDK version must be a semantic version without a v prefix');
  }
  if (
    typeof artifactChecksum !== 'string'
    || !CHECKSUM.test(artifactChecksum)
    || /^0+$/.test(artifactChecksum)
  ) {
    throw new Error('artifact checksum must be a nonzero lowercase SHA-256 digest');
  }

  return `// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BotaDeviceSDK",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
    ],
    products: [
        .library(name: "BotaDeviceSDK", targets: ["BotaDeviceSDK"]),
    ],
    targets: [
        .binaryTarget(
            name: "BotaDeviceSDKC",
            url: "https://github.com/bota-dev/app-sdk/releases/download/v${sdkVersion}/BotaDeviceSDKCore.xcframework.zip",
            checksum: "${artifactChecksum}"
        ),
        .target(
            name: "BotaDeviceSDK",
            dependencies: ["BotaDeviceSDKC"],
            path: "platforms/apple/Sources/BotaDeviceSDK"
        ),
    ]
)
`;
}

function parseArguments(argv) {
  const options = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      options.check = true;
      continue;
    }
    const value = argv[index + 1];
    if (!argument?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`invalid argument ${argument ?? ''}`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.output) throw new Error('--output is required');
  const contents = renderPublicSwiftPackage({
    sdkVersion: options['sdk-version'],
    artifactChecksum: options['artifact-checksum'],
  });

  if (options.check) {
    const current = await readFile(options.output, 'utf8');
    if (current !== contents) {
      throw new Error(`${options.output} does not match the release version and checksum`);
    }
    process.stdout.write(`Public Swift package is current: ${options.output}\n`);
    return;
  }

  await writeFile(options.output, contents);
  process.stdout.write(`Generated public Swift package: ${options.output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
