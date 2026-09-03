import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const policyUrl = new URL('../../release/channel-policy.json', import.meta.url);

export function parseReleaseRef(ref) {
  const tag = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : ref;
  if (!tag.startsWith('v')) {
    throw new Error(`${ref} is not an exact release tag`);
  }

  const version = tag.slice(1);
  if (!SEMVER.test(version)) {
    throw new Error(`${version} is not a valid semantic version`);
  }
  return version;
}

export async function loadPolicy() {
  return JSON.parse(await readFile(policyUrl, 'utf8'));
}

export function resolveReleaseChannel({ ref, mode, policy }) {
  if (mode !== 'new' && mode !== 'recovery') {
    throw new Error(`invalid mode ${mode}`);
  }
  if (
    policy.schemaVersion !== 1 ||
    policy.appSdkChannel !== 'beta' ||
    policy.npmDistTag !== 'beta' ||
    policy.githubPrerelease !== true
  ) {
    throw new Error('unsupported release channel policy');
  }

  const version = parseReleaseRef(ref);
  const versionWithoutBuildMetadata = version.split('+', 1)[0];
  if (
    mode === 'new' &&
    policy.requirePrereleaseForNewTags &&
    !versionWithoutBuildMetadata.includes('-')
  ) {
    throw new Error(`new App SDK version ${version} must contain a prerelease component`);
  }

  return {
    version,
    npmTag: policy.npmDistTag,
    githubPrerelease: policy.githubPrerelease,
  };
}

export async function run(argv) {
  let ref;
  let mode;
  let githubOutput;

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for ${option}`);
    }

    if (option === '--ref') {
      ref = value;
    } else if (option === '--mode') {
      mode = value;
    } else if (option === '--github-output') {
      githubOutput = value;
    } else {
      throw new Error(`unknown option ${option}`);
    }
    index += 1;
  }

  if (!ref || !mode) {
    throw new Error('usage: resolve-release-channel.mjs --ref <tag-ref> --mode <new|recovery> [--github-output <path>]');
  }

  const result = resolveReleaseChannel({ ref, mode, policy: await loadPolicy() });
  if (githubOutput) {
    await appendFile(
      githubOutput,
      `version=${result.version}\nnpm_tag=${result.npmTag}\ngithub_prerelease=${result.githubPrerelease}\n`,
    );
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
