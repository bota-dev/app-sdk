import { createHash, verify } from 'node:crypto';
import { appendFile, lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const repository = 'bota-dev/app-sdk';
const repositoryId = '1350249290';
const unit = 'app-sdk-prod';
const SHA = /^(?!0{40}$)[0-9a-f]{40}$/;
const DIGEST = /^(?!0{64}$)[0-9a-f]{64}$/;
const ID = /^[1-9][0-9]*$/;
const TAG = /^v[12]\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-beta\.(0|[1-9][0-9]*)$/;
const roots = ['apple', 'android', 'react-native', 'web', 'flutter'];
const bindingFields = ['repositoryId', 'unit', 'sha', 'target', 'candidateId', 'generation', 'approvalId', 'runId', 'runAttempt',
  'tag', 'tagObjectSha', 'ciRunId', 'ciRunAttempt', 'inventorySha256', 'requestDeploymentId'];
class ApprovalError extends Error {}
const requireValue = (ok, message) => { if (!ok) throw new ApprovalError(message); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (actual, expected, message) => requireValue(isDeepStrictEqual(actual, expected), message);

function enabled({ activation, policy }) {
  requireValue(activation === true && policy?.enabled === true, 'Slack SDK production approval is disabled');
  requireValue(policy.repository === repository && policy.repositoryId === repositoryId && policy.unit === unit
    && typeof policy.publicKey?.id === 'string' && typeof policy.publicKey.pem === 'string', 'Invalid SDK approval policy');
  const endpoint = new URL(policy.endpoint);
  requireValue(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password
    && endpoint.pathname === '/' && !endpoint.search && !endpoint.hash, 'Invalid approval service endpoint');
}

function localCandidate({ event, inventoryBytes, promotion }) {
  const tag = event?.ref?.slice('refs/tags/'.length);
  requireValue(event?.name === 'push' && event.repository === repository && event.repositoryId === repositoryId
    && event.refType === 'tag' && TAG.test(tag ?? '') && event.ref === `refs/tags/${tag}` && SHA.test(event.sha ?? '')
    && ID.test(event.runId ?? '') && positive(Number(event.runId)) && positive(event.runAttempt)
    && event.workflowRef === `${repository}/.github/workflows/release.yml@refs/tags/${tag}`, 'Original SDK tag-push workflow required');
  requireValue(Buffer.isBuffer(inventoryBytes) && inventoryBytes.length > 0 && inventoryBytes.length <= 2 * 1024 * 1024,
    'Invalid local candidate inventory size');
  const inventory = JSON.parse(inventoryBytes.toString('utf8'));
  requireValue(inventory.schemaVersion === 1 && inventory.sourceRevision === event.sha
    && Array.isArray(inventory.files) && inventory.files.length > 0 && inventory.files.length <= 10_000, 'Candidate inventory identity mismatch');
  const seen = new Set();
  for (const file of inventory.files) {
    requireValue(record(file) && typeof file.path === 'string' && file.path.split('/').every(part =>
      /^[A-Za-z0-9_@.+-]+$/.test(part) && part !== '.' && part !== '..')
      && roots.some(root => file.path.startsWith(`${root}-release/`)) && !seen.has(file.path)
      && Number.isSafeInteger(file.byteLength) && file.byteLength >= 0 && DIGEST.test(file.sha256 ?? ''), 'Invalid inventory file binding');
    seen.add(file.path);
  }
  requireValue(roots.every(root => inventory.files.some(file => file.path.startsWith(`${root}-release/`))), 'Inventory lacks a synchronized facade');
  requireValue(promotion?.schemaVersion === 1 && promotion.sourceRevision === event.sha && promotion.tag === tag
    && SHA.test(promotion.tagObject ?? '') && positive(promotion.ciRunId) && positive(promotion.ciRunAttempt)
    && promotion.inventorySha256 === hash(inventoryBytes), 'Local CI promotion binding mismatch');
  const sourceNames = [`release-candidate-${event.sha}`, `apple-package-${event.sha}`,
    ...['android', 'react-native', 'web', 'flutter'].map(root => `${root}-ci-${event.sha}`)];
  validateArtifacts(promotion.artifacts, sourceNames);
  return { tag, tagObjectSha: promotion.tagObject, sourceSha: event.sha, tagRunId: event.runId,
    tagRunAttempt: event.runAttempt, ciRunId: String(promotion.ciRunId), ciRunAttempt: promotion.ciRunAttempt,
    inventorySha256: promotion.inventorySha256 };
}

function validateArtifacts(artifacts, names) {
  requireValue(Array.isArray(artifacts) && artifacts.length === names.length
    && new Set(artifacts.map(item => item?.id)).size === names.length, 'Invalid preserved artifact snapshot');
  for (const name of names) {
    const matches = artifacts.filter(item => item?.name === name);
    requireValue(matches.length === 1 && positive(matches[0].id)
      && /^sha256:[0-9a-f]{64}$/.test(matches[0].digest ?? '') && DIGEST.test(matches[0].digest.slice(7)), 'Invalid preserved artifact identity');
  }
}

function selectedArtifacts(result, names, runId, sourceSha) {
  requireValue(record(result) && positive(result.total_count) && result.total_count <= 100
    && Array.isArray(result.artifacts) && result.artifacts.length === result.total_count, 'Incomplete preserved artifact listing');
  const selected = names.map(name => {
    const matches = result.artifacts.filter(item => item.name === name);
    requireValue(matches.length === 1, 'Missing or ambiguous preserved artifact');
    const item = matches[0];
    requireValue(item.expired === false && String(item.workflow_run?.id) === runId
      && String(item.workflow_run.repository_id) === repositoryId && item.workflow_run.head_sha === sourceSha, 'Preserved artifact source mismatch');
    return { id: item.id, name: item.name, digest: item.digest };
  });
  validateArtifacts(selected, names);
  return selected.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function validateState(state, local) {
  requireValue(state?.schemaVersion === 1 && ['intent', 'registered', 'approved'].includes(state.phase)
    && state.candidateId === `${unit}:${repositoryId}:${local.tagRunId}:${local.tagRunAttempt}` && record(state.payload), 'Invalid frozen approval request');
  const payload = state.payload;
  requireValue(payload.schemaVersion === 1 && payload.unit === unit && positive(payload.ciRunAttempt)
    && Object.entries(local).every(([key, value]) => payload[key] === value), 'Frozen SDK request binding changed');
  validateArtifacts(payload.artifacts, [...roots.map(root => `${root}-release-${local.tag}`), `release-inputs-${local.tag}`]);
  if (state.phase !== 'intent') requireValue(ID.test(state.requestDeploymentId ?? ''), 'Missing original request deployment');
  if (state.phase === 'approved') requireValue(positive(state.generation)
    && /^[A-Za-z0-9-]{1,128}$/.test(state.approvalId ?? ''), 'Invalid frozen approval identity');
  return state;
}

function annotation(message, name) {
  requireValue(typeof message === 'string' && message.length <= 65_536, 'Invalid annotated SDK tag');
  const lines = message.split(/\r?\n/).filter(line => line.startsWith(`${name}:`));
  requireValue(lines.length === 1, 'Missing or ambiguous tag candidate annotation');
  return lines[0].slice(name.length + 1).trim();
}

export async function registerSdkRelease(options) {
  enabled(options);
  const local = localCandidate(options);
  const { api, promotion, persist = async () => {} } = options;
  const resumed = options.state !== undefined;
  let state = options.state;
  if (resumed) validateState(state, local);
  else {
    const ref = await api(`git/ref/tags/${local.tag}`);
    requireValue(ref.object?.type === 'tag' && ref.object.sha === local.tagObjectSha, 'Annotated tag object changed');
    const tag = await api(`git/tags/${local.tagObjectSha}`);
    requireValue(tag.tag === local.tag && tag.object?.type === 'commit' && tag.object.sha === local.sourceSha
      && annotation(tag.message, 'Source-Revision') === local.sourceSha
      && annotation(tag.message, 'Candidate-Run-ID') === local.ciRunId
      && annotation(tag.message, 'Candidate-Inventory-SHA256') === local.inventorySha256, 'Tag candidate annotation mismatch');
    const ci = await api(`actions/runs/${local.ciRunId}`);
    requireValue(String(ci.id) === local.ciRunId && ci.repository?.full_name === repository && String(ci.repository.id) === repositoryId
      && ci.head_sha === local.sourceSha && ci.head_branch === 'main' && ci.event === 'push'
      && ci.path === '.github/workflows/ci.yml' && ci.status === 'completed' && ci.conclusion === 'success'
      && ci.run_attempt === local.ciRunAttempt, 'Successful exact main CI identity required');
    const tagRun = await api(`actions/runs/${local.tagRunId}`);
    requireValue(String(tagRun.id) === local.tagRunId && tagRun.run_attempt === local.tagRunAttempt
      && tagRun.repository?.full_name === repository && String(tagRun.repository.id) === repositoryId
      && tagRun.head_sha === local.sourceSha && tagRun.head_branch === local.tag && tagRun.event === 'push'
      && tagRun.path === '.github/workflows/release.yml'
      && (tagRun.status === 'in_progress' || (tagRun.status === 'completed' && tagRun.conclusion === 'success')), 'Original tag run identity mismatch');
    const sourceArtifacts = selectedArtifacts(await api(`actions/runs/${local.ciRunId}/artifacts?per_page=100`),
      promotion.artifacts.map(item => item.name), local.ciRunId, local.sourceSha);
    equal(sourceArtifacts, [...promotion.artifacts].sort((a, b) => a.name.localeCompare(b.name, 'en')), 'Promoted CI artifact snapshot changed');
    const names = [...roots.map(root => `${root}-release-${local.tag}`), `release-inputs-${local.tag}`];
    const artifacts = selectedArtifacts(await api(`actions/runs/${local.tagRunId}/artifacts?per_page=100`), names, local.tagRunId, local.sourceSha);
    state = { schemaVersion: 1, phase: 'intent', candidateId: `${unit}:${repositoryId}:${local.tagRunId}:${local.tagRunAttempt}`,
      payload: { schemaVersion: 1, unit, ...local, ciRunAttempt: ci.run_attempt, artifacts } };
    await persist(state); // Persist before the only registration POST; an uncertain outcome cannot authorize another one.
  }
  async function existing() {
    const deployments = await api(`deployments?sha=${local.sourceSha}&environment=prod&task=sdk-release&per_page=100`);
    requireValue(Array.isArray(deployments) && deployments.length <= 100, 'Incomplete SDK request deployment listing');
    const matches = deployments.filter(item => item.payload?.unit === unit && item.payload.tagRunId === local.tagRunId
      && item.payload.tagRunAttempt === local.tagRunAttempt);
    requireValue(matches.length <= 1, 'Ambiguous SDK request deployments');
    if (!matches.length) return null;
    const item = matches[0];
    requireValue(positive(item.id) && item.environment === 'prod' && item.task === 'sdk-release'
      && item.sha === local.sourceSha && item.ref === local.sourceSha, 'SDK deployment identity mismatch');
    equal(item.payload, state.payload, 'SDK deployment payload differs from the frozen request');
    if (state.requestDeploymentId) requireValue(String(item.id) === state.requestDeploymentId, 'Original SDK deployment changed');
    return item;
  }
  let deployment = await existing();
  if (!deployment && resumed) throw new ApprovalError('SDK registration outcome is unknown; inspect the original request before retrying');
  if (!deployment) {
    const finalRef = await api(`git/ref/tags/${local.tag}`);
    requireValue(finalRef.object?.type === 'tag' && finalRef.object.sha === local.tagObjectSha, 'Tag moved before request registration');
    try {
      await api('deployments', { method: 'POST', body: { ref: local.sourceSha, task: 'sdk-release', environment: 'prod',
        auto_merge: false, required_contexts: [], payload: state.payload } });
    } catch { /* Reconcile a lost response once; never repeat this POST. */ }
    deployment = await existing();
    requireValue(deployment, 'SDK registration outcome is unknown; inspect the original request before retrying');
  }
  let result = { ...state, phase: state.phase === 'approved' ? 'approved' : 'registered', requestDeploymentId: String(deployment.id) };
  await persist(result);
  if (result.phase === 'approved') return result;
  async function pending() {
    const statuses = await api(`deployments/${result.requestDeploymentId}/statuses?per_page=100`);
    requireValue(Array.isArray(statuses) && statuses.length <= 100, 'Incomplete SDK deployment status listing');
    if (!statuses.length) return false;
    requireValue(statuses[0].state === 'pending', 'SDK request has already advanced beyond pending approval');
    return true;
  }
  if (!await pending()) {
    requireValue(!result.pendingStatus, 'SDK pending status outcome is unknown; inspect the original deployment before retrying');
    result = { ...result, pendingStatus: 'intent' };
    await persist(result);
    try {
      await api(`deployments/${result.requestDeploymentId}/statuses`, { method: 'POST', body: {
        state: 'pending', description: 'Awaiting Slack SDK production approval',
        log_url: `https://github.com/${repository}/actions/runs/${local.tagRunId}`, auto_inactive: false,
      } });
    } catch { /* Preserve the intent and reconcile status readback once. */ }
    requireValue(await pending(), 'SDK pending status outcome is unknown; inspect the original deployment before retrying');
  }
  result = { ...result, pendingStatus: 'recorded' };
  await persist(result);
  return result;
}

function receiptBinding(state) {
  const p = state.payload;
  return { repositoryId, unit, sha: p.sourceSha, target: 'prod', candidateId: state.candidateId,
    generation: state.generation, approvalId: state.approvalId, runId: p.tagRunId, runAttempt: p.tagRunAttempt,
    tag: p.tag, tagObjectSha: p.tagObjectSha, ciRunId: p.ciRunId, ciRunAttempt: p.ciRunAttempt,
    inventorySha256: p.inventorySha256, requestDeploymentId: state.requestDeploymentId };
}

export function verifySdkReceipt(receipt, policy, expected, now) {
  requireValue(typeof receipt === 'string' && receipt.length < 16_384, 'Missing signed SDK receipt');
  const parts = receipt.split('.');
  requireValue(parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)), 'Invalid SDK receipt');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  requireValue(header.alg === 'RS256' && header.kid === policy.publicKey.id
    && Object.keys(header).every(key => ['alg', 'kid', 'typ'].includes(key)) && (!header.typ || header.typ === 'JWT'), 'Invalid SDK receipt key/header');
  requireValue(verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), policy.publicKey.pem,
    Buffer.from(parts[2], 'base64url')), 'Invalid SDK receipt signature');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  requireValue(bindingFields.every(key => expected[key] !== undefined && claims[key] === expected[key])
    && claims.iss === 'bota-slack-release-control' && claims.aud === 'bota-production-executor'
    && Number.isSafeInteger(now) && Number.isSafeInteger(claims.iat) && claims.iat <= now + 30
    && Number.isSafeInteger(claims.exp) && claims.exp > now && claims.exp > claims.iat && claims.exp - claims.iat <= 300
    && typeof claims.jti === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(claims.jti), 'SDK receipt expired or binding mismatch');
  return claims;
}

async function signedClaim(options, state, mode) {
  const { policy, now = () => Math.floor(Date.now() / 1000) } = options;
  const body = Object.fromEntries(['unit', 'sha', 'target', 'candidateId', 'generation', 'approvalId']
    .map(key => [key, receiptBinding(state)[key]]));
  const result = await serviceRequest(options, `/executions/${mode}`, body);
  requireValue(result.status === 200, 'SDK execution claim denied');
  verifySdkReceipt(result.data?.receipt, policy, receiptBinding(state), now());
  return state;
}

async function serviceRequest(options, path, body) {
  const token = await options.getOidc();
  requireValue(typeof token === 'string' && token.length > 0 && token.length < 16_384
    && !/[\x00-\x20\x7f]/.test(token), 'Missing fresh GitHub OIDC');
  return options.service(path, body, token);
}

export async function waitForSdkRelease(options) {
  enabled(options);
  const local = localCandidate(options);
  const state = validateState(options.state, local);
  requireValue(state.phase !== 'intent', 'SDK registration is unresolved');
  const { maxAttempts = 120, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    persist = async () => {}, onWait = () => {} } = options;
  requireValue(positive(maxAttempts) && maxAttempts <= 120, 'Invalid SDK approval wait bound');
  if (state.phase === 'approved') return signedClaim(options, state, 'claim');
  const deadline = Date.now() + 60 * 60_000;
  for (let attempt = 0; attempt < maxAttempts && Date.now() < deadline; attempt++) {
    const response = await serviceRequest(options, '/executions/claim', { mode: 'status', unit, sha: local.sourceSha,
      target: 'prod', candidateId: state.candidateId, requestDeploymentId: state.requestDeploymentId });
    const status = response.data;
    requireValue(record(status) && status.candidateId === state.candidateId, 'SDK status candidate mismatch');
    if (response.status === 202) requireValue(status.status === 'pending_qualification', 'Invalid SDK qualification status');
    else {
      requireValue(response.status === 200 && positive(status.generation)
        && ['pending', 'approved', 'deploying', 'rejected', 'superseded'].includes(status.status), 'Invalid SDK approval status');
      requireValue(!['rejected', 'superseded'].includes(status.status), 'SDK release was rejected or superseded');
      if (['approved', 'deploying'].includes(status.status)) {
        requireValue(/^[A-Za-z0-9-]{1,128}$/.test(status.approvalId ?? ''), 'Missing SDK approval identity');
        const approved = { ...state, phase: 'approved', generation: status.generation, approvalId: status.approvalId };
        await signedClaim(options, approved, 'claim');
        await persist(approved);
        return approved;
      }
    }
    if (attempt + 1 < maxAttempts) { onWait(`Waiting for Slack approval of ${local.tag} (${attempt + 1}/${maxAttempts})`); await sleep(30_000); }
  }
  throw new ApprovalError('SDK release was not approved within the bounded wait');
}

export async function refreshSdkRelease(options) {
  enabled(options);
  const state = validateState(options.state, localCandidate(options));
  requireValue(state.phase === 'approved', 'Frozen SDK approval is required before refresh');
  return signedClaim(options, state, 'refresh');
}

async function readBounded(response, maximum) {
  requireValue(response.body, 'Empty verification response');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      requireValue(length <= maximum, 'Verification response exceeds its metadata limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function requestSdkService({ policy, path, body, token, fetchImpl = fetch }) {
  enabled({ policy, activation: true });
  requireValue(['/executions/claim', '/executions/refresh'].includes(path)
    && typeof token === 'string' && token.length > 0 && token.length < 16_384 && !/[\x00-\x20\x7f]/.test(token), 'Invalid SDK service request');
  const serialized = JSON.stringify(body);
  requireValue(typeof serialized === 'string' && Buffer.byteLength(serialized) <= 16_384, 'SDK service request exceeds its metadata limit');
  let response;
  try { response = await fetchImpl(new URL(path, policy.endpoint), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: serialized }); }
  catch { throw new ApprovalError('SDK approval service unavailable'); }
  requireValue([200, 202].includes(response.status) && !response.redirected, 'SDK approval service denied this execution');
  return { status: response.status, data: await readBounded(response, 16_384) };
}

async function localFile(path, maximum) {
  const info = await lstat(path);
  requireValue(info.isFile() && !info.isSymbolicLink() && info.size <= maximum, 'Invalid bounded local approval input');
  return readFile(path);
}

async function cli() {
  const mode = process.argv[2];
  requireValue(['register', 'wait', 'refresh'].includes(mode), 'Expected register, wait or refresh');
  const paths = { '--inventory': 'target/release-candidate-files.json', '--promotion': 'target/ci-promotion.json', '--state': 'target/sdk-slack-request.json' };
  const selected = new Set();
  for (let index = 3; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    requireValue(Object.hasOwn(paths, key) && !selected.has(key) && value && !value.startsWith('--'), 'Invalid SDK approval CLI arguments');
    selected.add(key); paths[key] = value;
  }
  const policy = JSON.parse(await localFile(new URL('../../release/slack-production-policy.json', import.meta.url), 16_384));
  const activation = process.env.SLACK_SDK_PRODUCTION_APPROVAL_ENABLED === 'true';
  enabled({ activation, policy });
  const options = { activation, policy,
    inventoryBytes: await localFile(paths['--inventory'], 2 * 1024 * 1024),
    promotion: JSON.parse(await localFile(paths['--promotion'], 65_536)),
    event: { name: process.env.GITHUB_EVENT_NAME, repository: process.env.GITHUB_REPOSITORY, repositoryId: process.env.GITHUB_REPOSITORY_ID,
      refType: process.env.GITHUB_REF_TYPE, ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT), workflowRef: process.env.GITHUB_WORKFLOW_REF } };
  enabled(options);
  requireValue(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === options.event.sha, 'Checked-out SDK source mismatch');
  try { options.state = JSON.parse(await localFile(paths['--state'], 65_536)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  options.persist = async state => {
    const temporary = `${paths['--state']}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, paths['--state']);
  };
  options.api = async (path, { method = 'GET', body } = {}) => {
    requireValue(typeof process.env.GH_TOKEN === 'string' && process.env.GH_TOKEN.length > 0, 'GitHub repository token unavailable');
    let response;
    try {
      response = await fetch(`https://api.github.com/repos/${repository}/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new ApprovalError('GitHub SDK request unavailable'); }
    requireValue(response.status === (method === 'GET' ? 200 : 201) && !response.redirected
      && !response.headers.get('link')?.includes('rel="next"'), 'GitHub SDK request denied or incomplete');
    return readBounded(response, 1024 * 1024);
  };
  options.getOidc = async () => {
    const target = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
    requireValue(target.protocol === 'https:' && !target.username && !target.password && !target.hash
      && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'GitHub OIDC unavailable');
    target.searchParams.set('audience', 'bota-slack-release-control');
    let response;
    try { response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } }); }
    catch { throw new ApprovalError('GitHub OIDC unavailable'); }
    requireValue(response.status === 200 && !response.redirected, 'GitHub OIDC unavailable');
    const result = await readBounded(response, 16_384);
    requireValue(typeof result.value === 'string' && result.value.length > 0 && result.value.length < 16_384, 'Missing GitHub OIDC');
    return result.value;
  };
  options.service = (path, body, token) => requestSdkService({ policy, path, body, token });
  options.onWait = console.log;
  const result = await ({ register: registerSdkRelease, wait: waitForSdkRelease, refresh: refreshSdkRelease })[mode](options);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    `request_deployment_id=${result.requestDeploymentId}\ncandidate_id=${result.candidateId}\n${result.approvalId ? `approval_id=${result.approvalId}\ngeneration=${result.generation}\n` : ''}`);
  console.log(`Verified SDK ${mode}: ${result.payload.tag}, original run ${result.payload.tagRunId}/${result.payload.tagRunAttempt}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli().catch(error => {
  console.error(`Slack SDK production approval failed: ${error instanceof ApprovalError ? error.message : 'verification unavailable'}; publication is blocked`);
  process.exitCode = 1;
});
