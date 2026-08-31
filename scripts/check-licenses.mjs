#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN = [
  'GPL',
  'AGPL',
  'LGPL',
  'SSPL',
  'BUSL',
  'EUPL',
  'CC-BY-NC',
  'CC-BY-SA',
  'OSL',
  'EPL',
  'MPL',
];

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const licenseOf = (pkg) => {
  const value = pkg.license ?? pkg.licenses ?? 'UNKNOWN';
  if (Array.isArray(value)) {
    return value
      .map((license) =>
        typeof license === 'object' ? license.type ?? license.name : license
      )
      .join(' OR ');
  }
  if (value && typeof value === 'object') {
    return value.type ?? value.name ?? 'UNKNOWN';
  }
  return String(value);
};

const isForbidden = (license) => {
  const options = license
    .toUpperCase()
    .replaceAll(/[()]/g, '')
    .split(/\s+OR\s+/)
    .map((option) => option.trim());
  const forbidden = (option) =>
    FORBIDDEN.some((prefix) => option.startsWith(prefix));

  return options.some(forbidden) && !options.some((option) => !forbidden(option));
};

const loadReport = (path) => {
  const report = readJson(path);
  if (!Array.isArray(report.packages)) {
    throw new Error(`license-gate: ${path} must contain a packages array`);
  }
  return report.packages;
};

const loadInstalledPackages = () => {
  const lock = readJson('package-lock.json');
  const entries = Object.entries(lock.packages ?? {}).filter(
    ([path]) => path.startsWith('node_modules/')
  );

  return entries.flatMap(([path, lockEntry]) => {
    try {
      return [readJson(join(path, 'package.json'))];
    } catch (error) {
      if (lockEntry.optional === true && error?.code === 'ENOENT') {
        return [];
      }
      throw new Error(
        `license-gate: cannot inspect ${path}; run npm ci before the license check`,
        { cause: error }
      );
    }
  });
};

const args = process.argv.slice(2);
const reportIndex = args.indexOf('--report');
if (reportIndex >= 0 && !args[reportIndex + 1]) {
  console.error('license-gate: --report requires a JSON path');
  process.exit(1);
}

try {
  const packages =
    reportIndex >= 0
      ? loadReport(args[reportIndex + 1])
      : loadInstalledPackages();
  const allowlist = readJson(
    join(scriptDirectory, 'check-license-allowlist.json')
  ).packages ?? {};
  const violations = [];

  for (const pkg of packages) {
    if (pkg.private) continue;
    const name = pkg.name ?? 'UNKNOWN';
    const version = pkg.version ?? '?';
    const license = licenseOf(pkg);
    const exception = allowlist[name];
    const exceptionMatches =
      exception && exception.observedLicense === license && exception.reason;

    if (isForbidden(license) && !exceptionMatches) {
      violations.push({ name: `${name}@${version}`, license });
    }
  }

  if (violations.length) {
    console.error(
      `license-gate: ${violations.length} forbidden license(s) found:`
    );
    for (const violation of violations.sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      console.error(`  ${violation.license.padEnd(28)} ${violation.name}`);
    }
    console.error(`Blocked families: ${FORBIDDEN.join(', ')}`);
    process.exit(1);
  }

  console.log(
    `license-gate: ${packages.length} packages scanned, no forbidden licenses.`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
