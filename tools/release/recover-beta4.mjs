import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { unzipSync } from 'fflate';

// Finite exception for the two immutable runs stranded by the approval cutover.
export const BETA4 = {
  repository: 'bota-dev/app-sdk', tag: 'v2.0.0-beta.4',
  source: '4b972255d2d9d3005278799451741e025afed168',
  tagObject: 'db26c88d45582238d94e66e64365bbd04a518b7b',
  inventory: '87f00905121df029cdbc534e33e2701c0755e0a19873d09f05e48d9146416540',
  release: 36343414157, flutter: 36343414333,
  artifacts: [
    { id: 10939213199, name: 'apple-release-v2.0.0-beta.4', digest: 'sha256:3e2a6b7fc9b7eb173331bae5f1ba881cf96f6ca9cc29b75c9d5c9a1b9af2a427' },
    { id: 10942603393, name: 'android-release-v2.0.0-beta.4', digest: 'sha256:ccf96a84aec8e935e9dcdb1dbabe364f359b2c7a0d07eca929779c02fe9117a4' },
    { id: 10939458669, name: 'react-native-release-v2.0.0-beta.4', digest: 'sha256:9a5f1653b7f9c9ff104b7807aec3618351682db18708e0aa53d2f9ae20533628' },
    { id: 10939309207, name: 'web-release-v2.0.0-beta.4', digest: 'sha256:28bb682b20337923beb49de4724187e76f0791c5828a61665bc53c8aa517ba90' },
  ],
};
export const JOBS = {
  prerequisites: ['Verify v2.0.0-beta.4', 'Package Apple SDK', 'Package and verify Android SDK',
    'Package and verify React Native SDK', 'Package and verify Web SDK', 'Publish v2.0.0-beta.4',
    'Smoke public Apple package', 'Smoke public Android package on API 26', 'Smoke public Android package on API 35'],
  central: 'Recover Central deployment',
  release: ['Publish Apple CocoaPod bootstrap / Publish and verify Apple SDK',
    'Build Flutter release candidate', 'Verify Flutter publication', 'Complete synchronized prerelease'],
  flutter: ['Verify protected Flutter candidate', 'publish'],
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizedName = name => name.startsWith('publish / ') ? 'publish' : name;
const jobNamed = (run, name) => run.jobs.find(job => normalizedName(job.name) === name);
const succeeded = (run, name) => jobNamed(run, name)?.conclusion === 'success';

export function validateRun(run, kind) {
  const path = `.github/workflows/${kind === 'release' ? 'release' : 'publish-flutter'}.yml`;
  assert.ok(run.id === BETA4[kind] && run.path === path && run.event === 'push'
    && run.head_branch === BETA4.tag && run.head_sha === BETA4.source
    && run.repository?.full_name === BETA4.repository
    && run.head_repository?.full_name === BETA4.repository, 'historical run identity mismatch');
  const expected = kind === 'release' ? [...JOBS.prerequisites, JOBS.central, ...JOBS.release] : JOBS.flutter;
  const names = run.jobs.map(job => normalizedName(job.name));
  assert.ok(new Set(names).size === names.length && names.every(name => expected.includes(name))
    && (run.status !== 'completed' || expected.every(name => names.includes(name))), 'unexpected or missing jobs');
  if (kind === 'release') {
    assert.ok(JOBS.prerequisites.every(name => succeeded(run, name)), 'native/public prerequisite failed');
    assert.equal(jobNamed(run, JOBS.central)?.conclusion, 'skipped', 'Central recovery must remain skipped');
  }
}

export function validateArtifacts(artifacts) {
  for (const expected of BETA4.artifacts) {
    const matches = artifacts.filter(a => a.name === expected.name);
    assert.equal(matches.length, 1, 'preserved artifact missing or ambiguous');
    const actual = matches[0];
    assert.ok(actual.id === expected.id && actual.digest === expected.digest && actual.expired === false
      && actual.workflow_run?.id === BETA4.release && actual.workflow_run?.head_sha === BETA4.source,
    'preserved artifact identity/expiration mismatch');
  }
}

export function validateCandidate(bytes, inventory) {
  const files = unzipSync(bytes);
  const expected = inventory.files.filter(file => file.path.startsWith('flutter-release/'));
  const names = Object.keys(files).filter(name => !name.endsWith('/'));
  assert.ok(expected.length > 0 && expected.length === names.length, 'Flutter inventory file count mismatch');
  for (const file of expected) {
    const actual = files[file.path.slice('flutter-release/'.length)];
    assert.ok(actual && actual.length === file.byteLength && hash(actual) === file.sha256,
      `Flutter inventory mismatch: ${file.path}`);
  }
  assert.equal(JSON.parse(Buffer.from(files['package-inventory.json']).toString()).sourceRevision,
    BETA4.source, 'Flutter inventory source mismatch');
}

export function validateApproval(run, context) {
  assert.ok(run.id === context.runId && run.head_sha === context.sha && run.head_branch === 'main'
    && run.event === 'workflow_dispatch' && run.path === '.github/workflows/recover-beta4.yml'
    && run.repository?.full_name === BETA4.repository, 'recovery approval identity mismatch');
  const approvals = run.jobs.filter(job => job.name === 'Approve beta.4 recovery');
  assert.ok(approvals.length === 1 && approvals[0].conclusion === 'success', 'recovery approval missing');
}

// At most one request per failed stage per dispatch. A new failure requires
// diagnosis and a new protected dispatch, never an automatic publish retry.
export async function recover(io, { polls = 240 } = {}) {
  const initial = await io.preflight();
  await io.approve();
  const waitFor = async (kind, ready, attempt) => {
    for (let count = 0; count < polls; count++) {
      const run = await io.read(kind);
      if (run.run_attempt >= attempt) {
        if (ready(run)) return run;
        assert.notEqual(run.status, 'completed', `${kind} recovery failed; inspect original run`);
      }
      await io.sleep(30_000);
    }
    throw new Error(`${kind} recovery timed out; inspect original runs before another dispatch`);
  };
  const rerunFailed = async (kind, run, names) => {
    const job = names.map(name => jobNamed(run, name)).find(j => j && j.conclusion !== 'success');
    assert.ok(run.status === 'completed' && job
      && ['failure', 'cancelled', 'timed_out'].includes(job.conclusion), 'no eligible failed recovery job');
    const attempt = run.run_attempt + 1;
    await io.rerun(kind, job);
    return attempt;
  };

  let release = initial.release;
  if (!succeeded(release, JOBS.release[1])) {
    const attempt = await rerunFailed('release', release, JOBS.release.slice(0, 2));
    release = await waitFor('release', r => succeeded(r, JOBS.release[0]) && succeeded(r, JOBS.release[1]), attempt);
  }
  // A successful original build proves clean native consumers. Independently
  // match its ZIP contents to the annotation-bound inventory before OIDC resumes.
  await io.candidate();
  let flutter = await io.read('flutter');
  if (flutter.conclusion !== 'success') {
    await io.approve();
    const attempt = await rerunFailed('flutter', flutter, JOBS.flutter);
    flutter = await waitFor('flutter', r => r.status === 'completed' && r.conclusion === 'success', attempt);
  }
  release = await io.read('release');
  let attempt = release.run_attempt;
  if (release.status === 'completed' && release.conclusion !== 'success') {
    assert.equal(release.run_attempt, initial.release.run_attempt, 'new release recovery failed; do not retry automatically');
    await io.approve();
    attempt = await rerunFailed('release', release, JOBS.release.slice(2));
  }
  await waitFor('release', r => r.status === 'completed' && r.conclusion === 'success'
    && JOBS.release.every(name => succeeded(r, name)), attempt);
}

function githubClient(token) {
  return async (path, { method = 'GET', binary = false } = {}) => {
    const response = await fetch(`https://api.github.com/repos/${BETA4.repository}/${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(60_000),
    });
    assert.ok(response.ok, `GitHub ${method} ${path} returned HTTP ${response.status}`);
    if (binary) return Buffer.from(await response.arrayBuffer());
    const body = await response.text();
    return body ? JSON.parse(body) : null;
  };
}

export function createIO(api, context, download = fetch) {
  let inventory;
  const readRun = async id => {
    const run = await api(`actions/runs/${id}`);
    const result = await api(`actions/runs/${id}/jobs?filter=latest&per_page=100`);
    assert.ok(result.total_count <= 100, 'unexpected jobs pagination');
    return { ...run, jobs: result.jobs };
  };
  const read = async kind => {
    const run = await readRun(BETA4[kind]);
    validateRun(run, kind);
    return run;
  };
  const artifacts = async () => {
    const result = await api(`actions/runs/${BETA4.release}/artifacts?per_page=100`);
    assert.ok(result.total_count <= 100, 'unexpected artifacts pagination');
    validateArtifacts(result.artifacts);
    return result.artifacts;
  };
  const immutable = async () => {
    const ref = await api(`git/ref/tags/${BETA4.tag}`);
    assert.ok(ref.object.type === 'tag' && ref.object.sha === BETA4.tagObject, 'immutable tag mismatch');
    const tag = await api(`git/tags/${BETA4.tagObject}`);
    assert.ok(tag.object.type === 'commit' && tag.object.sha === BETA4.source && tag.tag === BETA4.tag
      && tag.message.includes(`Source-Revision: ${BETA4.source}`)
      && tag.message.includes(`Candidate-Inventory-SHA256: ${BETA4.inventory}`), 'tag annotation mismatch');
    await artifacts();
  };
  return {
    read, sleep,
    preflight: async () => {
      assert.ok(context.repository === BETA4.repository && context.ref === 'refs/heads/main'
        && context.event === 'workflow_dispatch', 'recovery requires a main workflow dispatch');
      const main = await api('git/ref/heads/main');
      assert.equal(main.object.sha, context.sha, 'recovery source is no longer current main');
      for (const workflow of ['ci.yml', 'license-gate.yml']) {
        const result = await api(`actions/workflows/${workflow}/runs?head_sha=${context.sha}&per_page=100`);
        assert.ok(result.workflow_runs.some(run => run.head_sha === context.sha && run.head_branch === 'main'
          && run.repository.full_name === BETA4.repository && run.status === 'completed'
          && run.conclusion === 'success'), `exact main ${workflow} has not passed`);
      }
      await immutable();
      const response = await download(`https://github.com/${BETA4.repository}/releases/download/${BETA4.tag}/release-candidate-files.json`,
        { signal: AbortSignal.timeout(60_000) });
      assert.ok(response.ok, 'release candidate inventory unavailable');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(hash(bytes), BETA4.inventory, 'release candidate inventory digest mismatch');
      inventory = JSON.parse(bytes);
      assert.equal(inventory.sourceRevision, BETA4.source, 'release inventory source mismatch');
      const state = { release: await read('release'), flutter: await read('flutter') };
      assert.ok(Object.values(state).every(run => run.status === 'completed'), 'historical run already active; inspect before recovery');
      return state;
    },
    approve: async () => {
      validateApproval(await readRun(context.runId), context);
      await immutable();
    },
    candidate: async () => {
      const run = await read('release');
      assert.ok(succeeded(run, JOBS.release[0]) && succeeded(run, JOBS.release[1]), 'Flutter prerequisites incomplete');
      const matches = (await artifacts()).filter(a => a.name === `flutter-release-${BETA4.tag}`);
      assert.equal(matches.length, 1, 'Flutter candidate missing or ambiguous');
      const candidate = matches[0];
      assert.ok(!candidate.expired && candidate.workflow_run?.id === BETA4.release
        && candidate.workflow_run?.head_sha === BETA4.source, 'Flutter artifact identity mismatch');
      const bytes = await api(`actions/artifacts/${candidate.id}/zip`, { binary: true });
      assert.equal(`sha256:${hash(bytes)}`, candidate.digest, 'Flutter artifact digest mismatch');
      validateCandidate(bytes, inventory);
    },
    rerun: async (kind, job) => {
      // Read again immediately before the only mutating request; never accept
      // a caller-supplied ID or rerun an entire workflow.
      const current = await read(kind);
      const allowed = kind === 'release' ? JOBS.release : JOBS.flutter;
      assert.ok(current.status === 'completed' && allowed.includes(normalizedName(job.name))
        && current.jobs.some(j => j.id === job.id && j.name === job.name
          && ['failure', 'cancelled', 'timed_out'].includes(j.conclusion)), 'recovery job changed');
      console.log(`Resuming ${kind} run ${BETA4[kind]}, job ${job.id}: ${job.name}`);
      await api(`actions/jobs/${job.id}/rerun`, { method: 'POST' });
    },
  };
}

async function main() {
  const mode = process.argv[2];
  assert.ok(['preflight', 'recover'].includes(mode), 'usage: recover-beta4.mjs preflight|recover');
  const env = process.env;
  assert.ok(env.GH_TOKEN, 'GH_TOKEN is required');
  const context = { repository: env.GITHUB_REPOSITORY, ref: env.GITHUB_REF,
    event: env.GITHUB_EVENT_NAME, sha: env.GITHUB_SHA, runId: Number(env.GITHUB_RUN_ID) };
  const io = createIO(githubClient(env.GH_TOKEN), context);
  if (mode === 'preflight') await io.preflight();
  else await recover(io);
  const result = mode === 'preflight' ? 'Preflight passed; protected approval still required.'
    : 'Both original workflows completed successfully; synchronized publication verified.';
  console.log(result);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
    `${result}\n\nTag: ${BETA4.tag}; source: ${BETA4.source}; inventory: ${BETA4.inventory}.\n\n`
    + `- [Original release](https://github.com/${BETA4.repository}/actions/runs/${BETA4.release})\n`
    + `- [Original Flutter OIDC](https://github.com/${BETA4.repository}/actions/runs/${BETA4.flutter})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
