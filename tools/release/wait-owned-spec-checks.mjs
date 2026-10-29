import { pathToFileURL } from 'node:url';

const required = ['Validate Specs', 'Dependency licenses', 'Scan'];

export async function waitForOwnedSpecsChecks({
  commit, fetchImpl = fetch, maxAttempts = 30,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onWait = () => {},
}) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '') || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 60) {
    throw new Error('an exact Specs commit and bounded check attempts are required');
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // This is a public-repository read; no SDK token or write credential is sent.
    const response = await fetchImpl(`https://api.github.com/repos/bota-dev/app-sdk/commits/${commit}/check-runs?filter=latest&per_page=100`, {
      redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/vnd.github+json' },
    });
    if (response.status !== 200 || response.redirected) throw new Error(`Specs check lookup failed: HTTP ${response.status}`);
    const result = await response.json();
    if (!Array.isArray(result.check_runs) || result.total_count > 100) throw new Error('invalid or incomplete Specs check listing');
    let ready = true;
    for (const name of required) {
      const matches = result.check_runs.filter(check => check.name === name);
      if (matches.length > 1) throw new Error(`ambiguous required Specs check: ${name}`);
      if (!matches.length) { ready = false; continue; }
      const check = matches[0];
      if (check.head_sha !== commit || check.app?.slug !== 'github-actions') throw new Error(`Specs check identity mismatch: ${name}`);
      if (check.status !== 'completed') { ready = false; continue; }
      if (check.conclusion !== 'success') throw new Error(`required Specs check did not pass: ${name}`);
    }
    if (ready) return { commit, checks: required };
    if (attempt + 1 < maxAttempts) {
      onWait(`Waiting for Specs validation, license and security checks (${attempt + 1}/${maxAttempts})`);
      await sleep(30_000);
    }
  }
  throw new Error('Specs checks did not complete; the publication branch is retained and main was not advanced');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('usage: wait-owned-spec-checks.mjs <exact-specs-commit>');
  console.log(JSON.stringify(await waitForOwnedSpecsChecks({ commit: process.argv[2], onWait: console.log })));
}
