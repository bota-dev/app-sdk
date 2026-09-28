import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { verifyCandidateArchive, verifyPublishedArchive } from './verify-publication.mjs';

// Only absence authorizes upload. Every retry repeats this check, including a
// retry after pub.dev accepted a package but the upload job lost its response.
export async function publicationNeeded({ archive, inventory, fetchImpl = fetch }) {
  await verifyCandidateArchive({ archive, inventory });
  const response = await fetchImpl(`https://pub.dev/api/archives/${inventory.packageName}-${inventory.version}.tar.gz`,
    { signal: AbortSignal.timeout(60_000) });
  if (response.status === 404) return true;
  assert.ok(response.ok, `pub.dev lookup failed: HTTP ${response.status}`);
  await verifyPublishedArchive({ archive: Buffer.from(await response.arrayBuffer()), inventory });
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 2, 'usage: node tools/flutter/prepare-publication.mjs');
    assert.ok(process.env.GITHUB_REPOSITORY === 'bota-dev/app-sdk'
      && process.env.GITHUB_EVENT_NAME === 'push'
      && process.env.GITHUB_REF === `refs/tags/${process.env.GITHUB_REF_NAME}`, 'tag-push context required');
    const inventory = JSON.parse(await readFile('target/flutter-release/package-inventory.json', 'utf8'));
    assert.equal(inventory.sourceRevision, process.env.GITHUB_SHA, 'Flutter source mismatch');
    assert.equal(`v${inventory.version}`, process.env.GITHUB_REF_NAME, 'Flutter tag mismatch');
    const archive = await readFile(`target/flutter-release/${inventory.archive.name}`);
    const needed = await publicationNeeded({ archive, inventory });
    await appendFile(process.env.GITHUB_OUTPUT, `needs-publish=${needed}\n`);
    console.log(needed ? 'Verified candidate is ready for its first pub.dev upload.'
      : 'Existing pub.dev package matches the candidate; upload is already complete.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
