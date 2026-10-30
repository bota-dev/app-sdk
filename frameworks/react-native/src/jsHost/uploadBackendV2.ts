import { Buffer } from 'buffer';
import type { BotaUploadBackendAdapter } from '../runtimeAdapter';
import type {
  JsFilePort, JsHostContext, JsPersistencePort, JsValue, OpaqueHostHandle, RawJsCoreFactory,
} from './contracts';
import type { JsEncryptedUploadV2Material, JsEncryptedUploadV2MarkerDocument } from './encryptedUploadV2';
import { BotaJsHostError } from './executor';

export interface JsV2HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly redirect: 'error';
  readonly credentials: 'omit';
  readonly signal: AbortSignal;
}
export interface JsV2HttpResponse {
  readonly status: number;
  readonly url: string;
  readonly redirected?: boolean;
  readonly headers?: { get(name: string): string | null };
  readonly body?: { getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<void>;
    releaseLock?(): void;
  } } | null;
  text(): Promise<string>;
}
/** The supplied transport must refuse redirects before forwarding credentials. */
export type JsV2Fetch = (url: string, request: JsV2HttpRequest) => Promise<JsV2HttpResponse>;
export interface JsV2UploadTarget {
  readonly url: string;
  readonly method: 'PUT';
  readonly headers: Readonly<Record<string, string>>;
}
export interface JsEncryptedUploadV2BackendOptions {
  readonly core: Pick<RawJsCoreFactory, 'codec'>;
  readonly persistence: JsPersistencePort;
  readonly files: JsFilePort;
  readonly fetch: JsV2Fetch;
  /** This port uploads a captured opaque file and refuses redirects/cookies. */
  readonly uploadFile: (target: JsV2UploadTarget, handle: OpaqueHostHandle, context: JsHostContext) => Promise<void>;
  readonly requestCredentials: (operationId: string, signal?: AbortSignal) => Promise<string>;
  readonly readNonce: (operationId: string, signal?: AbortSignal) => Promise<Uint8Array | string>;
  readonly context: (operationId: string, signal?: AbortSignal) => JsHostContext;
  readonly checkOperation?: (operationId: string) => void;
  readonly registerMaterial: (operationId: string, material: JsEncryptedUploadV2Material) => string;
  readonly unregisterMaterial: (registrationId: string) => void | Promise<void>;
  readonly signal?: AbortSignal;
  readonly checkScope?: () => void;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
export type JsEncryptedUploadV2Backend = Pick<BotaUploadBackendAdapter, 'prepare' | 'cancel' | 'complete'> & {
  drain(operationId: string): Promise<void>;
  dispose(): Promise<void>;
};

interface Input {
  operationId: string;
  scope: { apiOrigin: string; apiBasePath?: string; organizationId: string; deviceId: string; [key: string]: JsValue | undefined };
  recording: { markersRequired?: boolean; [key: string]: JsValue | undefined };
  [key: string]: unknown;
}
interface Entry { recordingId: string; sessionId?: string; ownerRevision?: number }
interface Journal {
  entry?: Entry;
  authorizationNonceSha256?: string;
  recoveryNonceBase64?: string;
  [key: string]: unknown;
}
interface Session { session_id: string; owner_revision: number; policy: string; expires_at: string; state?: string }
interface Slot {
  readonly input: Input;
  readonly context: JsHostContext;
  readonly controller: AbortController;
  readonly key: string;
  readonly pending: Set<Promise<unknown>>;
  readonly cancellable: Set<AbortController>;
  readonly contexts: Map<number, Record<string, unknown>>;
  readonly ownerSignals: Map<AbortSignal, () => void>;
  readonly releaseScope: () => void;
  preparing: boolean;
  cancelled: boolean;
  work: Promise<string>;
  journal: Journal | null;
  entry?: Entry;
  session?: Session;
  registration?: string;
  authorization?: Uint8Array;
  receipt?: Uint8Array;
  receiptDelivered: boolean;
  receiptProvided: boolean;
  uploadCiphertext: boolean;
  needsManifest: boolean;
  release?: Promise<void>;
  completion?: Promise<void>;
}

/** SDK-private ordinary JS IO over generated Rust managed-upload decisions. */
export function createJsEncryptedUploadV2Backend(options: JsEncryptedUploadV2BackendOptions): JsEncryptedUploadV2Backend {
  options = { ...options };
  const namespace = options.persistence.namespace;
  const slots = new Map<string, Slot>();
  const used = new Set<string>();
  const leases = new Map<string, Slot>();
  const now = options.now ?? Date.now;
  const wait = options.wait ?? delay;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const checkScope = () => {
    if (disposed || options.signal?.aborted) throw failure('BOTA_UPLOAD_CANCELLED');
    if (options.persistence.namespace !== namespace) throw failure('BOTA_UPLOAD_IDENTITY_CONFLICT');
    options.checkScope?.();
  };
  const check = (slot: Slot, context?: JsHostContext) => {
    checkScope();
    if (slot.cancelled || slot.controller.signal.aborted || context?.signal.aborted || slots.get(slot.input.operationId) !== slot) {
      throw failure('BOTA_UPLOAD_CANCELLED');
    }
    if (context && context.operationId !== slot.input.operationId) throw failure('BOTA_UPLOAD_IDENTITY_CONFLICT');
    if (context && !slot.ownerSignals.has(context.signal)) {
      const abort = () => {
        slot.cancelled = true; slot.controller.abort();
        for (const request of slot.cancellable) request.abort();
      };
      slot.ownerSignals.set(context.signal, abort);
      context.signal.addEventListener('abort', abort, { once: true });
    }
    options.checkOperation?.(slot.input.operationId);
  };
  const reduce = (input: Input, event: Record<string, unknown>): Record<string, any> => {
    const result = object(options.core.codec('reduceManagedUpload', { input, event } as unknown as JsValue));
    if (result.error) throw failure(object(result.error).code as string);
    return object(result.value);
  };
  const track = <T>(slot: Slot, promise: Promise<T>): Promise<T> => {
    slot.pending.add(promise);
    void promise.then(() => slot.pending.delete(promise), () => slot.pending.delete(promise));
    return promise;
  };
  // A drain may persist an already-dispatched create response after cancellation. It
  // retains the exact captured namespace and operation identity, with a fresh IO signal.
  const persistenceContext = (slot: Slot): JsHostContext => ({ ...slot.context, signal: new AbortController().signal });
  const save = async (slot: Slot, entry: Entry | undefined, phase = 'ready', extra: Record<string, unknown> = {}) => {
    if (options.persistence.namespace !== namespace) throw failure('BOTA_UPLOAD_IDENTITY_CONFLICT');
    const record = reduce(slot.input, { type: 'SaveJournal', previous: slot.journal, entry: entry ?? null, phase, ...extra }).record;
    const context = persistenceContext(slot);
    await options.persistence.save(slot.key, record as JsValue, context);
    const proof = await options.persistence.load(slot.key, context);
    if (canonical(proof) !== canonical(record)) throw failure('BOTA_UPLOAD_JOURNAL');
    slot.journal = record;
    slot.entry = entry;
  };
  const remove = async (slot: Slot) => {
    if (options.persistence.namespace !== namespace) throw failure('BOTA_UPLOAD_IDENTITY_CONFLICT');
    const context = persistenceContext(slot);
    await options.persistence.remove(slot.key, context);
    if (await options.persistence.load(slot.key, context) !== null) throw failure('BOTA_UPLOAD_JOURNAL');
    slot.journal = null;
  };
  const rollback = async (slot: Slot, entry?: Entry) => {
    const proof = await options.persistence.load(slot.key, persistenceContext(slot));
    const plan = reduce(slot.input, { type: 'RollbackRejectedCreate', record: proof, entry: entry ?? null });
    if (plan.remove) await remove(slot); else await save(slot, entry);
  };
  const http = async (slot: Slot, path: string, body?: string, drain = false,
    beforeDispatch?: () => Promise<void>, authorizationRejected?: () => Promise<void>): Promise<string> => {
    check(slot);
    const token = await options.requestCredentials(slot.input.operationId, slot.controller.signal);
    check(slot);
    if (typeof token !== 'string' || !/^[!-~]{1,16384}$/.test(token)) throw failure('BOTA_UPLOAD_INVALID_INPUT');
    const url = exactUrl(slot.input.scope.apiOrigin + path);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
    if (slot.input.scope.organizationId) headers['X-Organization-Id'] = slot.input.scope.organizationId;
    await beforeDispatch?.();
    check(slot);
    const controller = new AbortController();
    const limits = reduce(slot.input, { type: 'Limits' });
    const deadline = setTimeout(() => controller.abort(), drain ? limits.drainTimeoutMs : limits.requestTimeoutMs);
    if (!drain) slot.cancellable.add(controller);
    const request = (async () => {
      try {
        const response = await options.fetch(url, { method: body === undefined ? 'GET' : 'POST', headers,
          ...(body === undefined ? {} : { body }), redirect: 'error', credentials: 'omit', signal: controller.signal });
        if (!drain) check(slot);
        if (response.redirected || response.url !== url || !Number.isInteger(response.status)) throw failure('BOTA_UPLOAD_INVALID_DOCUMENT');
        const text = await readBody(response, limits.responseBytes, controller.signal);
        if (!drain) check(slot);
        const policy = reduce(slot.input, { type: 'HttpResponse', status: response.status, responseJson: text });
        if (policy.authorizationRejected && authorizationRejected) {
          check(slot); await authorizationRejected();
        }
        if (!policy.success) throw new HttpFailure(response.status, policy.stagingMissing);
        return text;
      } catch (error) {
        if (!drain) check(slot);
        throw error instanceof BotaJsHostError || error instanceof HttpFailure ? error : failure('BOTA_UPLOAD_TRANSPORT');
      } finally { clearTimeout(deadline); slot.cancellable.delete(controller); }
    })();
    return track(slot, request);
  };
  const retry = async <T>(slot: Slot, body: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      check(slot);
      try { const value = await body(); check(slot); return value; }
      catch (error) {
        check(slot);
        const plan = reduce(slot.input, { type: 'HttpPolicy', attempt,
          status: error instanceof HttpFailure ? error.status : null,
          transportFailure: error instanceof BotaJsHostError && error.code === 'BOTA_UPLOAD_TRANSPORT' });
        if (!plan.retry) throw error;
        await wait(plan.waitMs, slot.controller.signal);
      }
    }
  };
  const nonce = async (slot: Slot): Promise<Uint8Array> => {
    check(slot);
    const result = await options.readNonce(slot.input.operationId, slot.controller.signal);
    check(slot);
    return typeof result === 'string' ? new Uint8Array(Buffer.from(result, 'hex')) : result.slice();
  };
  const sessionPath = (slot: Slot) => {
    if (!slot.entry?.sessionId) throw failure('BOTA_UPLOAD_STATE');
    return `${slot.input.scope.apiBasePath ?? '/v1'}/recordings/${slot.entry.recordingId}/encrypted-upload-v2/sessions/${slot.entry.sessionId}`;
  };
  const restore = async (slot: Slot): Promise<string> => {
    const visited: string[] = [];
    const limits = reduce(slot.input, { type: 'Limits' });
    for (let hop = 0; hop <= limits.maximumRecoveryHops; hop++) {
      if (!slot.entry?.sessionId) throw failure('BOTA_UPLOAD_STATE');
      const parent = { ...slot.entry };
      visited.push(parent.sessionId!);
      const text = await retry(slot, () => http(slot, sessionPath(slot)));
      let next = reduce(slot.input, { type: 'RestoreDecision', entry: parent, responseJson: text,
        nowMs: String(now()), authorizationNonceSha256: slot.journal?.authorizationNonceSha256 ?? null,
        recoveryNonceBase64: slot.journal?.recoveryNonceBase64 ?? null, nonce: null, hop });
      let bytes: Uint8Array | undefined;
      try {
        if (next.checkNonce) {
          bytes = next.nonce ? Uint8Array.from(next.nonce) : await nonce(slot);
          next = reduce(slot.input, { type: 'RestoreDecision', entry: parent, responseJson: text,
            nowMs: String(now()), authorizationNonceSha256: slot.journal?.authorizationNonceSha256 ?? null,
            recoveryNonceBase64: slot.journal?.recoveryNonceBase64 ?? null, nonce: Array.from(bytes), hop });
        }
        if (!next.recover) return text;
        const plan = reduce(slot.input, { type: 'RecoverSession', entry: parent, nonce: Array.from(bytes!), expired: next.expired });
        await save(slot, parent, 'ready', { recoveryNonceBase64: plan.recoveryNonceBase64 });
        await retry(slot, async () => {
          const response = await http(slot, plan.path, plan.bodyJSON, true);
          const successor = reduce(slot.input, { type: 'AcceptRecovery', parent, responseJson: response, visited }).entry as Entry;
          await save(slot, successor, 'ready', { authorizationNonceSha256: plan.nonceSha256, recoveredFrom: parent });
        });
      } finally { bytes?.fill(0); }
    }
    throw failure('BOTA_UPLOAD_EXPIRED');
  };
  const manifest = async (slot: Slot, bytes: Uint8Array, evidence: JsValue, context: JsHostContext) => {
    check(slot, context);
    const plan = reduce(slot.input, { type: 'Manifest', entry: slot.entry, bytes: Array.from(bytes),
      evidence: mapEvidence(evidence), needed: slot.needsManifest });
    if (!plan.skip) {
      await http(slot, plan.path, plan.bodyJSON);
      check(slot, context);
      slot.uploadCiphertext = false; slot.needsManifest = false;
    }
  };
  const material = (slot: Slot): JsEncryptedUploadV2Material => ({
    async authorization(context) { check(slot, context); return slot.authorization!.slice(); },
    async localWifiRecovery(checkpoint, context) {
      check(slot, context);
      return reduce(slot.input, { type: 'LocalWifiRecovery', record: slot.journal, checkpoint }).recovery;
    },
    async localWifiControlGrant(sessionId, context) {
      check(slot, context);
      const bytes = await nonce(slot);
      try {
        const plan = reduce(slot.input, { type: 'LocalControlGrant', sessionId, nonce: Array.from(bytes) });
        const response = await http(slot, plan.path, plan.bodyJSON);
        check(slot, context); return response;
      } finally { bytes.fill(0); }
    },
    async reconcileStaging(bytes, evidence, context) {
      check(slot, context); reduce(slot.input, { type: 'VerifyEvidence', evidence: mapEvidence(evidence) });
      if (!slot.uploadCiphertext) return false;
      try { await retry(slot, () => manifest(slot, bytes, evidence, context)); return false; }
      catch (error) { if (error instanceof HttpFailure && error.stagingMissing) return true; throw error; }
    },
    async stageCiphertext(sink, evidence, context) {
      check(slot, context); reduce(slot.input, { type: 'VerifyEvidence', evidence: mapEvidence(evidence) });
      if (!slot.uploadCiphertext) return;
      if (sink.scope !== namespace || sink.kind !== 'file') throw failure('BOTA_UPLOAD_IDENTITY_CONFLICT');
      const plan = reduce(slot.input, { type: 'StagingRequest', entry: slot.entry, evidence: mapEvidence(evidence),
        expiresAt: slot.session!.expires_at, nowMs: String(now()) });
      const text = await http(slot, plan.path, plan.bodyJSON);
      const target = reduce(slot.input, { type: 'Staging', responseJson: text, expiresAt: slot.session!.expires_at, nowMs: String(now()) });
      exactUrl(target.url);
      check(slot, context);
      const hashId = `${slot.input.operationId}:managed-source`;
      options.core.codec('hasherNew', { decoderId: hashId });
      try {
        const before = await options.files.metadata(sink, context);
        check(slot, context);
        const expected = String(object(evidence).ciphertext_length);
        if (before.durableUnits !== expected) throw failure('BOTA_UPLOAD_IDENTITY_CONFLICT');
        const size = BigInt(expected);
        for (let offset = 0n; offset < size;) {
          check(slot, context);
          const maximum = Number(size - offset > 65536n ? 65536n : size - offset);
          const bytes = await options.files.read(sink, offset.toString(), maximum, context);
          check(slot, context);
          if (!(bytes instanceof Uint8Array) || bytes.length !== maximum) throw failure('BOTA_UPLOAD_INVALID_DOCUMENT');
          try { options.core.codec('hasherUpdate', { decoderId: hashId, bytes: Array.from(bytes) }); }
          finally { bytes.fill(0); }
          offset += BigInt(maximum);
        }
        const proof = object(options.core.codec('hasherSnapshot', { decoderId: hashId }));
        reduce(slot.input, { type: 'VerifyEvidence', evidence: { ...mapEvidence(evidence),
          ciphertextLength: proof.length, ciphertextSha256: proof.sha256 } });
        const after = await options.files.metadata(sink, context);
        check(slot, context);
        if (after.durableUnits !== expected) throw failure('BOTA_UPLOAD_IDENTITY_CONFLICT');
      } finally { options.core.codec('hasherFree', { decoderId: hashId }); }
      await track(slot, options.uploadFile(target as JsV2UploadTarget, sink, context));
      check(slot, context);
    },
    async submitManifest(bytes, evidence, context) { await retry(slot, () => manifest(slot, bytes, evidence, context)); },
    ...(slot.input.recording.markersRequired ? {
      async submitMarkers(documents: readonly JsEncryptedUploadV2MarkerDocument[], evidence: JsValue, context: JsHostContext) {
        check(slot, context);
        const plan = reduce(slot.input, { type: 'MarkerBatch', entry: slot.entry, evidence: mapEvidence(evidence), count: documents.length });
        const encoded: string[] = [];
        for (let index = 0; index < documents.length; index++) {
          check(slot, context);
          const document = documents[index]!;
          if (document.index !== index || document.count !== documents.length || document.handle.scope !== namespace) {
            throw failure('BOTA_UPLOAD_IDENTITY_CONFLICT');
          }
          const proof = await options.files.metadata(document.handle, context);
          const bytes = await options.files.read(document.handle, '0', 403, context);
          if (!(bytes instanceof Uint8Array)) throw failure('BOTA_UPLOAD_INVALID_DOCUMENT');
          try {
            const value = reduce(slot.input, { type: 'MarkerDocument', index, count: documents.length,
              bytes: Array.from(bytes), expectedSha256: Array.from(wireBytes(document.sha256)), durableLength: proof.durableUnits });
            encoded.push(value.base64);
          } finally { bytes.fill(0); }
        }
        await retry(slot, () => http(slot, plan.path, JSON.stringify({ owner_revision: plan.ownerRevision,
          seal_base64: encoded[0], pages_base64: encoded.slice(1) })));
        check(slot, context);
      },
    } : {}),
    async finalize(evidence, context) {
      check(slot, context);
      const limits = reduce(slot.input, { type: 'Limits' });
      for (let poll = 0; poll < limits.maximumPolls; poll++) {
        const text = await retry(slot, () => http(slot, sessionPath(slot)));
        const decision = reduce(slot.input, { type: 'Finalize', entry: slot.entry, responseJson: text, evidence: mapEvidence(evidence) });
        check(slot, context);
        if (decision.published) { slot.receipt?.fill(0); slot.receipt = Uint8Array.from(decision.receipt); return; }
        await wait(decision.waitMs, slot.controller.signal);
      }
      throw failure('BOTA_UPLOAD_PENDING');
    },
    async completionReceipt(evidence, context) {
      check(slot, context); reduce(slot.input, { type: 'VerifyEvidence', evidence: mapEvidence(evidence) });
      if (!slot.receipt) throw failure('BOTA_UPLOAD_STATE');
      slot.receiptProvided = true; return slot.receipt.slice();
    },
    async confirmed(context) {
      check(slot, context);
      if (!slot.receiptProvided) throw failure('BOTA_UPLOAD_STATE');
      slot.receiptDelivered = true;
      // The verified CONFIRM handoff outlives the transport owner's terminal signal.
      for (const [signal, listener] of slot.ownerSignals) signal.removeEventListener('abort', listener);
      slot.ownerSignals.clear();
    },
    uploadContext: {
      async challenge(attemptId, bytes, context) {
        check(slot, context);
        const plan = reduce(slot.input, { type: 'ContextCreate', nonce: Array.from(bytes) });
        const text = await retry(slot, () => http(slot, plan.path, plan.bodyJSON));
        const initial = reduce(slot.input, { type: 'ContextInitial', responseJson: text });
        check(slot, context);
        slot.contexts.set(attemptId, initial.initial);
        return Uint8Array.from(initial.challenge);
      },
      async result(attemptId, proof, context) {
        check(slot, context);
        const initial = slot.contexts.get(attemptId);
        if (!initial) throw failure('BOTA_UPLOAD_STATE');
        const plan = reduce(slot.input, { type: 'ContextProof', initial, proof: Array.from(proof) });
        let text = await retry(slot, () => http(slot, plan.path, plan.bodyJSON));
        const limits = reduce(slot.input, { type: 'Limits' });
        for (let poll = 0; poll <= limits.contextMaximumPolls; poll++) {
          const decision = reduce(slot.input, { type: 'ContextResult', initial, responseJson: text });
          check(slot, context);
          if (decision.complete) { slot.contexts.delete(attemptId); return Uint8Array.from(decision.result); }
          if (poll === limits.contextMaximumPolls) break;
          await wait(decision.waitMs, slot.controller.signal);
          text = await retry(slot, () => http(slot, plan.path.replace(/\/proof$/, '')));
        }
        throw failure('BOTA_UPLOAD_PENDING');
      },
    },
    async cancel() { await cancelSlot(slot); },
  });
  const release = (slot: Slot): Promise<void> => {
    return slot.release ??= (async () => {
      try {
        if (slot.registration) await options.unregisterMaterial(slot.registration);
      } finally {
        slot.registration = undefined;
        slot.authorization?.fill(0); slot.receipt?.fill(0); slot.contexts.clear(); slot.releaseScope();
        for (const [signal, listener] of slot.ownerSignals) signal.removeEventListener('abort', listener);
        slot.ownerSignals.clear();
        if (slots.get(slot.input.operationId) === slot) slots.delete(slot.input.operationId);
        if (leases.get(slot.key) === slot) leases.delete(slot.key);
      }
    })();
  };
  const cancelSlot = async (slot: Slot) => {
    slot.cancelled = true; slot.controller.abort();
    for (const controller of slot.cancellable) controller.abort();
    await drainSlot(slot);
    if (!slot.preparing) await release(slot);
  };
  const drainSlot = async (slot: Slot) => {
    // Pending work may schedule its durable commit after the HTTP promise settles.
    await slot.work.catch(() => {});
    await slot.completion?.catch(() => {});
    while (slot.pending.size) await Promise.allSettled([...slot.pending]);
  };
  const prepareSlot = async (slot: Slot): Promise<string> => {
    try {
      check(slot);
      const saved = await options.persistence.load(slot.key, slot.context);
      check(slot);
      const inspection = reduce(slot.input, { type: 'Inspect', record: saved });
      slot.journal = saved === null ? null : inspection.record;
      slot.entry = inspection.entry ?? undefined;
      if (slot.entry) await save(slot, slot.entry, 'ready', { recoveryNonceBase64: slot.journal?.recoveryNonceBase64 ?? null });
      if (!slot.entry) {
        const plan = reduce(slot.input, { type: 'CreateRecording' });
        const text = await http(slot, plan.path, plan.bodyJSON, true,
          () => save(slot, undefined, 'recording_create_unknown'), () => rollback(slot));
        const entry = reduce(slot.input, { type: 'AcceptRecording', responseJson: text }).entry;
        await save(slot, entry);
      }
      check(slot);
      let response: string;
      let restoring = false;
      if (slot.entry!.sessionId) { restoring = true; response = await restore(slot); }
      else {
        const bytes = await nonce(slot);
        try {
          const plan = reduce(slot.input, { type: 'CreateSession', entry: slot.entry, nonce: Array.from(bytes) });
          const previous = { ...slot.entry! };
          response = await http(slot, plan.path, plan.bodyJSON, true,
            () => save(slot, previous, 'session_create_unknown'), () => rollback(slot, previous));
          const committed = reduce(slot.input, { type: 'AcceptPointer', recordingId: previous.recordingId, responseJson: response }).entry;
          const digest = reduce(slot.input, { type: 'NonceHash', nonce: Array.from(bytes) }).sha256;
          await save(slot, committed, 'ready', { authorizationNonceSha256: digest });
        } finally { bytes.fill(0); }
      }
      check(slot);
      const selected = reduce(slot.input, { type: 'Session', entry: slot.entry, responseJson: response!, restore: restoring });
      slot.session = selected.session; slot.uploadCiphertext = selected.uploadCiphertext; slot.needsManifest = selected.needsManifest;
      let marker: string | undefined;
      if (slot.input.recording.markersRequired) {
        const plan = reduce(slot.input, { type: 'MarkerAdmissionPlan', entry: slot.entry });
        try { marker = await retry(slot, () => http(slot, plan.path + `?owner_revision=${slot.entry!.ownerRevision}`)); }
        catch (error) {
          if (!(error instanceof HttpFailure) || !reduce(slot.input, { type: 'MarkerAdmission', status: error.status, state: slot.session!.state ?? null }).create) throw error;
          marker = await retry(slot, () => http(slot, plan.path, plan.bodyJSON));
        }
      }
      slot.authorization = Uint8Array.from(reduce(slot.input, { type: 'Authorization', responseJson: response!, markerResponseJson: marker ?? null }).bytes);
      check(slot);
      slot.registration = options.registerMaterial(slot.input.operationId, material(slot));
      check(slot);
      slot.preparing = false;
      return JSON.stringify({ profile: 'encrypted_upload_v2', uploadSessionId: slot.session!.session_id,
        ownerRevision: slot.session!.owner_revision, securityPolicy: slot.session!.policy,
        materialRegistrationId: slot.registration, recordingId: slot.entry!.recordingId });
    } catch (error) {
      slot.cancelled = true; slot.controller.abort();
      for (const controller of slot.cancellable) controller.abort();
      slot.preparing = false;
      await release(slot);
      throw error;
    }
  };
  const backend: JsEncryptedUploadV2Backend = {
    prepare(inputJSON) {
      checkScope();
      if (typeof inputJSON !== 'string' || Buffer.byteLength(inputJSON, 'utf8') > 16384) throw failure('BOTA_UPLOAD_INVALID_INPUT');
      let input: Input;
      try { input = JSON.parse(inputJSON); } catch { throw failure('BOTA_UPLOAD_INVALID_INPUT'); }
      const identity = reduce(input, { type: 'Identity' });
      if (used.has(input.operationId)) throw failure('BOTA_UPLOAD_CANCELLED');
      const key = `managed-encrypted-v2/${identity.journalKey}`;
      if (leases.has(key)) throw failure('BOTA_UPLOAD_STATE');
      used.add(input.operationId);
      const controller = new AbortController();
      const context = { ...options.context(input.operationId, controller.signal), signal: controller.signal };
      const abort = () => { void backend.cancel!(input.operationId).catch(() => {}); };
      options.signal?.addEventListener('abort', abort, { once: true });
      const slot: Slot = { input, context, controller, key, pending: new Set(), cancellable: new Set(), contexts: new Map(), ownerSignals: new Map(),
        releaseScope: () => options.signal?.removeEventListener('abort', abort), preparing: true, cancelled: false,
        work: Promise.resolve(''), journal: null, receiptDelivered: false, receiptProvided: false, uploadCiphertext: true, needsManifest: true };
      slots.set(input.operationId, slot); leases.set(key, slot);
      slot.work = prepareSlot(slot);
      void slot.work.catch(() => {});
      return slot.work;
    },
    async cancel(operationId) {
      used.add(operationId);
      const slot = slots.get(operationId);
      if (slot) await cancelSlot(slot);
    },
    async complete(operationId) {
      checkScope();
      const slot = slots.get(operationId);
      if (!slot || slot.preparing || slot.cancelled || !slot.receiptDelivered) throw failure('BOTA_UPLOAD_STATE');
      return slot.completion ??= (async () => {
        const proof = await options.persistence.load(slot.key, persistenceContext(slot));
        checkScope();
        if (slot.cancelled) throw failure('BOTA_UPLOAD_CANCELLED');
        reduce(slot.input, { type: 'CompleteJournal', record: proof, expected: slot.entry,
          receiptDelivered: slot.receiptDelivered });
        await remove(slot);
        await release(slot);
      })();
    },
    async drain(operationId) { const slot = slots.get(operationId); if (slot) await drainSlot(slot); },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      disposal = Promise.allSettled([...slots.values()].map(cancelSlot)).then(results => {
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      });
      return disposal;
    },
  };
  return backend;
}

class HttpFailure extends Error {
  constructor(readonly status: number, readonly stagingMissing: boolean) {
    super(`BOTA_UPLOAD_HTTP_${status}`);
  }
}
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('BOTA_UPLOAD_INVALID_DOCUMENT');
  return value as Record<string, any>;
}
function failure(code: string): BotaJsHostError { return new BotaJsHostError(code, 'EncryptedUploadV2'); }
function wireBytes(value: JsValue): Uint8Array {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255)) throw failure('BOTA_UPLOAD_INVALID_DOCUMENT');
  return Uint8Array.from(value as number[]);
}
function mapEvidence(value: JsValue): Record<string, unknown> {
  const fields = object(value);
  return { ciphertextLength: fields.ciphertext_length, ciphertextSha256: fields.ciphertext_sha256,
    manifestLength: fields.manifest_length, manifestSha256: fields.manifest_sha256 };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
function exactUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw failure('BOTA_UPLOAD_INVALID_DOCUMENT'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.href !== value) throw failure('BOTA_UPLOAD_INVALID_DOCUMENT');
  return value;
}
async function readBody(response: JsV2HttpResponse, maximum: number, signal: AbortSignal): Promise<string> {
  const length = response.headers?.get('content-length');
  if (length != null && (!/^(0|[1-9][0-9]*)$/.test(length) || BigInt(length) > BigInt(maximum))) throw failure('BOTA_UPLOAD_INVALID_DOCUMENT');
  if (!response.body) {
    const text = await response.text();
    if (signal.aborted) throw failure('BOTA_UPLOAD_TRANSPORT');
    if (Buffer.byteLength(text, 'utf8') > maximum) throw failure('BOTA_UPLOAD_INVALID_DOCUMENT');
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw failure('BOTA_UPLOAD_TRANSPORT');
      const part = await reader.read();
      if (signal.aborted) throw failure('BOTA_UPLOAD_TRANSPORT');
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > maximum - size) throw failure('BOTA_UPLOAD_INVALID_DOCUMENT');
      chunks.push(part.value); size += part.value.byteLength;
    }
    const bytes = Buffer.concat(chunks, size);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw failure('BOTA_UPLOAD_INVALID_DOCUMENT');
    return text;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock?.();
  }
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(failure('BOTA_UPLOAD_CANCELLED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
