import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export function supportsGeneratedRuntime(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.exec(version);
  assert.ok(match, 'Invalid release version');
  const [major, minor, patch, beta] = match.slice(1).map(value => value === undefined ? undefined : Number(value));
  assert.ok([major, minor, patch, beta].filter(value => value !== undefined).every(Number.isSafeInteger), 'Release version exceeds safe integer range');
  return major === 2 && (minor > 0 || patch > 0 || beta === undefined || beta >= 16);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, 'usage: runtime-release-support.mjs VERSION');
  console.log(supportsGeneratedRuntime(process.argv[2]));
}
