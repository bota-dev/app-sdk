import { fileURLToPath } from 'node:url'

import { verifyInstalledPackageEvidence } from './verify-package.mjs'

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tarball, inventory, checksum, installedPackage, ...extra] =
    process.argv.slice(2)
  if (!tarball || !inventory || !checksum || !installedPackage || extra.length > 0) {
    console.error(
      'usage: node tools/web/verify-installed-package.mjs <tarball> <inventory> <checksum> <installed-package>',
    )
    process.exitCode = 2
  } else {
    verifyInstalledPackageEvidence(
      tarball,
      inventory,
      checksum,
      installedPackage,
    )
    console.log(`verified installed package against ${inventory}`)
  }
}
