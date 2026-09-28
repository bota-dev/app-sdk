import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import {
  BETA4, JOBS, validateRun, validateArtifacts, validateCandidate,
  validateApproval, recover, createIO,
} from './recover-beta4.mjs';

function run(kind = 'release') {
  const names = kind === 'release'
    ? [...JOBS.prerequisites, JOBS.central, ...JOBS.release]
    : JOBS.flutter;
  return {
    id: BETA4[kind], path: `.github/workflows/${kind === 'release' ? 'release' : 'publish-flutter'}.yml`,
    repository: { full_name: BETA4.repository }, head_repository: { full_name: BETA4.repository },
    event: 'push', head_branch: BETA4.tag, head_sha: BETA4.source,
    status: 'completed', conclusion: 'failure', run_attempt: 5,
    jobs: names.map((name, index) => ({ id: index + 1, name, status: 'completed',
      conclusion: JOBS.prerequisites.includes(name) ? 'success'
        : name === JOBS.release[0] || name === JOBS.flutter[0] ? 'failure' : 'skipped' })),
  };
}

test('historical recovery accepts only the two exact tag-push runs', () => {
  for (const kind of ['release', 'flutter']) {
    validateRun(run(kind), kind);
    for (const [field, value] of Object.entries({ id: 1, path: '.github/workflows/other.yml',
      event: 'workflow_dispatch', head_branch: 'main', head_sha: '0'.repeat(40),
      head_repository: { full_name: 'attacker/app-sdk' } })) {
      assert.throws(() => validateRun({ ...run(kind), [field]: value }, kind), /identity/);
    }
  }
});

test('failed native gates, unknown jobs and ambiguous job names fail closed', () => {
  const failed = run();
  failed.jobs[0].conclusion = 'failure';
  assert.throws(() => validateRun(failed, 'release'), /prerequisite/);
  for (const name of ['Unexpected publisher', JOBS.release[0]]) {
    const duplicate = run();
    duplicate.jobs.push({ id: 99, name, conclusion: 'success' });
    assert.throws(() => validateRun(duplicate, 'release'), /jobs/);
  }
});

test('preserved native artifact IDs, digests, source and expiration are mandatory', () => {
  const artifacts = BETA4.artifacts.map(a => ({ ...a, expired: false,
    workflow_run: { id: BETA4.release, head_sha: BETA4.source } }));
  validateArtifacts(artifacts);
  for (const patch of [{ expired: true }, { id: 1 }, { digest: 'sha256:wrong' },
    { workflow_run: { id: BETA4.release, head_sha: 'other' } }]) {
    assert.throws(() => validateArtifacts([{ ...artifacts[0], ...patch }, ...artifacts.slice(1)]), /artifact/);
  }
  assert.throws(() => validateArtifacts([...artifacts, artifacts[0]]), /artifact/);
});

test('Flutter archive must match every pinned inventory file and reject extra bytes', () => {
  const files = { 'package-inventory.json': Buffer.from(JSON.stringify({ sourceRevision: BETA4.source })),
    'bota_app_sdk-2.0.0-beta.4.tar.gz': Buffer.from('candidate') };
  const inventory = { files: Object.entries(files).map(([name, bytes]) => ({
    path: `flutter-release/${name}`, byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })) };
  validateCandidate(zipSync(files), inventory);
  assert.throws(() => validateCandidate(zipSync({ ...files, extra: Buffer.from('x') }), inventory), /inventory/);
  assert.throws(() => validateCandidate(zipSync({ ...files,
    'bota_app_sdk-2.0.0-beta.4.tar.gz': Buffer.from('changed') }), inventory), /inventory/);
  assert.throws(() => validateCandidate(zipSync({ 'package-inventory.json': files['package-inventory.json'] }), inventory), /inventory/);
});

test('approval belongs to this main workflow revision and successful gate', () => {
  const context = { sha: 'a'.repeat(40), runId: 123 };
  const approved = { id: 123, head_sha: context.sha, head_branch: 'main',
    event: 'workflow_dispatch', path: '.github/workflows/recover-beta4.yml',
    repository: { full_name: BETA4.repository },
    jobs: [{ name: 'Approve beta.4 recovery', conclusion: 'success' }] };
  validateApproval(approved, context);
  for (const patch of [{ id: 1 }, { head_sha: BETA4.source }, { head_branch: BETA4.tag },
    { jobs: [{ name: 'Approve beta.4 recovery', conclusion: 'skipped' }] },
    { jobs: [] }]) {
    assert.throws(() => validateApproval({ ...approved, ...patch }, context), /approval/);
  }
});

function scenario() {
  const state = { release: run(), flutter: run('flutter') };
  const events = [];
  return { state, events, io: {
    preflight: async () => { events.push('preflight'); return structuredClone(state); },
    approve: async () => { events.push('approve'); },
    read: async kind => structuredClone(state[kind]),
    candidate: async () => { events.push('candidate'); },
    sleep: async () => {},
    rerun: async (kind, job) => {
      events.push(job.name);
      const current = state[kind];
      current.run_attempt++;
      if (kind === 'release' && job.name === JOBS.release[0]) {
        for (const j of current.jobs.filter(j => JOBS.release.slice(0, 2).includes(j.name))) j.conclusion = 'success';
        current.status = 'in_progress';
        current.jobs.find(j => j.name === JOBS.release[2]).status = 'in_progress';
      } else {
        current.status = 'completed';
        current.conclusion = 'success';
        current.jobs.forEach(j => { j.status = 'completed'; j.conclusion = 'success'; });
        state.release.status = 'completed';
        state.release.conclusion = 'success';
        state.release.jobs.filter(j => JOBS.release.includes(j.name)).forEach(j => {
          j.status = 'completed'; j.conclusion = 'success';
        });
      }
    },
  } };
}

test('recovery orders approval, CocoaPods/candidate, artifact validation, OIDC and completion', async () => {
  const { io, events } = scenario();
  await recover(io, { polls: 3 });
  assert.deepEqual(events, ['preflight', 'approve', JOBS.release[0], 'candidate', 'approve', JOBS.flutter[0]]);
});

test('failed or absent approval never reruns a historical publisher', async () => {
  const { io, events } = scenario();
  io.approve = async () => { throw new Error('approval missing'); };
  await assert.rejects(recover(io), /approval/);
  assert.deepEqual(events, ['preflight']);
});

test('candidate drift stops before the separate Flutter publisher', async () => {
  const { io, events } = scenario();
  io.candidate = async () => { throw new Error('inventory mismatch'); };
  await assert.rejects(recover(io, { polls: 3 }), /inventory/);
  assert.ok(!events.includes(JOBS.flutter[0]));
});

test('a new failure stops without automatic retries; accepted reruns have bounded polling', async () => {
  for (const advance of [true, false]) {
    const { io, state, events } = scenario();
    io.rerun = async () => { events.push('rerun'); if (advance) state.release.run_attempt++; };
    await assert.rejects(recover(io, { polls: 2 }), advance ? /failed/ : /timed out/);
    assert.equal(events.filter(e => e === 'rerun').length, 1);
  }
});

test('already complete release is verified without another publication', async () => {
  const { io, state, events } = scenario();
  for (const r of Object.values(state)) {
    r.conclusion = 'success';
    r.jobs.filter(j => j.name !== JOBS.central).forEach(j => { j.conclusion = 'success'; });
  }
  await recover(io);
  assert.deepEqual(events, ['preflight', 'approve', 'candidate']);
});

test('a running historical workflow is not eligible for another rerun', async () => {
  const { io, state, events } = scenario();
  state.release.status = 'in_progress';
  await assert.rejects(recover(io), /eligible/);
  assert.deepEqual(events, ['preflight', 'approve']);
});

test('preflight refuses other refs, stale main and missing exact CI without mutations', async () => {
  const context = { repository: BETA4.repository, ref: 'refs/heads/main',
    event: 'workflow_dispatch', sha: 'a'.repeat(40), runId: 123 };
  for (const [patch, main, message] of [[{ ref: `refs/tags/${BETA4.tag}` }, context.sha, /main/],
    [{}, BETA4.source, /current main/], [{}, context.sha, /has not passed/]]) {
    const calls = [];
    const api = async (path, options) => {
      calls.push({ path, options });
      return path === 'git/ref/heads/main' ? { object: { sha: main } } : { workflow_runs: [] };
    };
    await assert.rejects(createIO(api, { ...context, ...patch }).preflight(), message);
    assert.ok(calls.every(call => !call.options?.method));
  }
});

test('mutating adapter refuses a substituted job ID and native publication job', async () => {
  const historical = run();
  const api = async (path, options) => {
    assert.notEqual(options?.method, 'POST');
    return path.includes('/jobs?') ? { jobs: historical.jobs, total_count: historical.jobs.length } : historical;
  };
  const io = createIO(api, {});
  await assert.rejects(io.rerun('release', { ...historical.jobs.find(j => j.name === JOBS.release[0]), id: 999 }), /changed/);
  await assert.rejects(io.rerun('release', historical.jobs[0]), /changed/);
});

test('workflow has one main-only secret-free gate before actions write permission', async () => {
  const workflow = (await readFile('.github/workflows/recover-beta4.yml', 'utf8')).replaceAll('\r\n', '\n');
  assert.match(workflow, /if: github.repository == 'bota-dev\/app-sdk' && github.ref == 'refs\/heads\/main'/);
  assert.equal((workflow.match(/environment: release-approval/g) ?? []).length, 1);
  assert.match(workflow, /approve:\n\s+name: Approve beta.4 recovery\n\s+needs: preflight/);
  assert.match(workflow, /recover:\n\s+needs: approve/);
  assert.equal((workflow.match(/actions: write/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /secrets\.|id-token: write|contents: write|inputs:|cancel-in-progress: true/);
  assert.match(workflow, /group: app-sdk-beta4-recovery-controller/);
});
