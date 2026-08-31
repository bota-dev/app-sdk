#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ALLOWED_LICENSES = new Set(['Apache-2.0', 'MIT']);

export function verifyMavenLicensePolicy({ moduleMetadata, sbom, policy }) {
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy.dependencies)) {
    throw new Error('Android Maven license policy must use schema version 1');
  }
  const reviewed = new Map();
  for (const entry of policy.dependencies) {
    const key = coordinate(entry);
    if (reviewed.has(key)) throw new Error(`duplicate reviewed Maven dependency ${key}`);
    if (!ALLOWED_LICENSES.has(entry.license) || !entry.reviewedBy?.trim()) {
      throw new Error(`Maven dependency ${key} lacks an allowed reviewed license`);
    }
    reviewed.set(key, entry);
  }

  const published = new Map();
  for (const variant of moduleMetadata?.variants ?? []) {
    for (const dependency of variant.dependencies ?? []) {
      const entry = {
        group: dependency.group,
        module: dependency.module,
        version: dependency.version?.requires,
      };
      published.set(coordinate(entry), entry);
    }
  }
  assertSameCoordinates(published, reviewed);

  const sbomDependencies = new Map(
    (sbom?.packages ?? [])
      .filter((entry) => entry.name !== 'BotaAndroidSDK' && !entry.name.startsWith('bota-device-sdk-'))
      .map((entry) => [`${entry.name}:${entry.versionInfo}`, entry])
  );
  for (const entry of reviewed.values()) {
    const found = sbomDependencies.get(`${entry.module}:${entry.version}`);
    if (!found || found.licenseDeclared !== entry.license) {
      throw new Error(`SPDX license does not match reviewed policy for ${coordinate(entry)}`);
    }
  }
  if (sbomDependencies.size !== reviewed.size) {
    throw new Error('SPDX Maven dependency set does not match reviewed policy');
  }
}

function coordinate(entry) {
  if (![entry?.group, entry?.module, entry?.version].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new Error('Maven dependency coordinate is incomplete');
  }
  return `${entry.group}:${entry.module}:${entry.version}`;
}

function assertSameCoordinates(actual, expected) {
  const missing = [...expected.keys()].filter((key) => !actual.has(key));
  const unreviewed = [...actual.keys()].filter((key) => !expected.has(key));
  if (missing.length || unreviewed.length) {
    throw new Error(`Maven policy drift: missing=[${missing.join(',')}] unreviewed=[${unreviewed.join(',')}]`);
  }
}

async function main() {
  const [modulePath, sbomPath, policyPath] = process.argv.slice(2);
  if (!modulePath || !sbomPath || !policyPath) {
    throw new Error('usage: check-maven-license-policy.mjs MODULE SBOM POLICY');
  }
  const [moduleMetadata, sbom, policy] = await Promise.all(
    [modulePath, sbomPath, policyPath].map(async (path) => JSON.parse(await readFile(path, 'utf8')))
  );
  verifyMavenLicensePolicy({ moduleMetadata, sbom, policy });
  console.log('Android Maven dependencies match the reviewed license policy and SPDX evidence');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
