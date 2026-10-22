import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function selectManifestTemplate(root, version, mode) {
  if (!['--ci', '--check', '--write-example'].includes(mode)) {
    throw new Error('Unknown Flutter packaging mode');
  }
  const candidate = join(root, 'release/candidates', `${version}.json`);
  const release = join(root, 'release/examples', `${version}.json`);
  return mode === '--ci' && existsSync(candidate) ? candidate : release;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(selectManifestTemplate(...process.argv.slice(2)));
}
