import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { publicPackageIdentifier } from './package-identities.mjs';

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const CHECKSUM = /^[0-9a-f]{64}$/;

export function renderPublicPodspec({ sdkVersion, artifactChecksum }) {
  if (typeof sdkVersion !== 'string' || !VERSION.test(sdkVersion)) {
    throw new Error('SDK version must be a semantic version without a v prefix');
  }
  if (typeof artifactChecksum !== 'string' || !CHECKSUM.test(artifactChecksum) || /^0+$/.test(artifactChecksum)) {
    throw new Error('artifact checksum must be a nonzero lowercase SHA-256 digest');
  }

  const packageName = publicPackageIdentifier('apple', sdkVersion);
  return `Pod::Spec.new do |spec|
  spec.name = "${packageName}"
  spec.module_name = "${packageName}"
  spec.version = "${sdkVersion}"
  spec.summary = "Bota App SDK for Apple platforms"
  spec.homepage = "https://docs.bota.dev"
  spec.license = { type: "Apache-2.0" }
  spec.author = "Bota"
  spec.source = {
    http: "https://github.com/bota-dev/app-sdk/releases/download/v${sdkVersion}/${packageName}.cocoapods.zip",
    sha256: "${artifactChecksum}",
  }
  spec.platforms = { ios: "15.0", osx: "13.0" }
  spec.cocoapods_version = ">= 1.13"
  spec.swift_version = "6.0"
  spec.source_files = "{,platforms/apple/}Sources/${packageName}/**/*.swift"
  spec.vendored_frameworks =
    "{,platforms/apple/}Artifacts/BotaDeviceSDKCore.xcframework"
  spec.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "SWIFT_STRICT_CONCURRENCY" => "complete",
    "SWIFT_TREAT_WARNINGS_AS_ERRORS" => "YES",
  }
end
`;
}

async function main() {
  const args = process.argv.slice(2);
  const options = { check: false };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--check') {
      options.check = true;
      continue;
    }
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument ${key ?? ''}`);
    options[key.slice(2)] = value;
    index += 1;
  }
  if (!options.output) throw new Error('--output is required');
  const contents = renderPublicPodspec({
    sdkVersion: options['sdk-version'],
    artifactChecksum: options['artifact-checksum'],
  });
  if (options.check) {
    const current = await readFile(options.output, 'utf8');
    if (current !== contents) throw new Error(`${options.output} does not match the release version and checksum`);
  } else {
    await writeFile(options.output, contents);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
