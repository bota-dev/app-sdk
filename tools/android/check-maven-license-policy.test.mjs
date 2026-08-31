import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyMavenLicensePolicy } from './check-maven-license-policy.mjs';

const dependency = {
  group: 'org.example', module: 'runtime', version: '1.2.3',
  license: 'Apache-2.0', reviewedBy: 'Bota maintainers',
};
const input = () => ({
  moduleMetadata: { variants: [{ dependencies: [{ group: dependency.group, module: dependency.module, version: { requires: dependency.version } }] }] },
  sbom: { packages: [{ name: dependency.module, versionInfo: dependency.version, licenseDeclared: dependency.license }] },
  policy: { schemaVersion: 1, dependencies: [dependency] },
});

test('reviewed Maven coordinates and SPDX licenses agree', () => {
  assert.doesNotThrow(() => verifyMavenLicensePolicy(input()));
});

test('unreviewed dependencies and SPDX license drift fail closed', () => {
  const unreviewed = input();
  unreviewed.moduleMetadata.variants[0].dependencies.push({ group: 'org.example', module: 'new-runtime', version: { requires: '2.0.0' } });
  assert.throws(() => verifyMavenLicensePolicy(unreviewed), /unreviewed/);

  const mismatched = input();
  mismatched.sbom.packages[0].licenseDeclared = 'NOASSERTION';
  assert.throws(() => verifyMavenLicensePolicy(mismatched), /SPDX license/);
});
