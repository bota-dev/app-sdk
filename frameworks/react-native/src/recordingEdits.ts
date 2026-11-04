/** Audio editing remains host-owned. This client only persists intent, uploads
 * unchanged files and submits authenticated save operations. */
export interface RecordingEditFile { sha256: string; size_bytes: number; content_type: string }
export type RecordingEditSource = { kind: 'cloud_recording'; recording_id: string; sha256: string; samples?: string; channels?: 1 | 2 }
  | { kind: 'local_artifact'; artifact_id: string; sha256: string; samples: string; channels: 1 | 2;
    file?: RecordingEditFile; highlights?: Array<{ id: string; start_sample: string; end_sample?: string }> };
export interface RecordingEditRequest {
  operation_id: string;
  kind: 'merge' | 'split';
  mode: 'concatenate_sources' | 'save_outputs';
  manifest: { sources: RecordingEditSource[]; outputs: Array<{ name: string; file?: RecordingEditFile;
    intervals?: Array<{ source_index: number; start_sample: string; end_sample: string }> }>;
    end_user_id?: string; metadata?: Record<string, unknown>; processing: 'transcribe_then_summarize' };
}
export interface RecordingEditStatus {
  operation_id: string; state: 'waiting_for_inputs' | 'queued' | 'processing' | 'saved' | 'failed' | 'cancelled';
  failure_code?: string | null; ai_cancelled?: boolean;
  outputs: Array<{ index: number; recording_id: string; status: string; transcription_status?: string | null; summary_status?: string | null; processing_error?: string | null }>;
  required_uploads: Array<RecordingEditFile & { target: 'input' | 'output'; index: number }>;
}
export interface RecordingEditJournal<Handle> { version: 1; scope_key: string; request: RecordingEditRequest; files: Record<string, Handle> }
export interface RecordingEditHost<Handle> {
  readonly scopeKey: string;
  readonly signal: AbortSignal;
  checkScope(): void;
  load(operationId: string): Promise<RecordingEditJournal<Handle> | undefined>;
  save(operationId: string, journal: RecordingEditJournal<Handle>): Promise<void>;
  request(method: 'GET' | 'POST', path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
  inspect(handle: Handle, signal: AbortSignal): Promise<{ sha256: string; size_bytes: number }>;
  upload(handle: Handle, grant: { upload_url: string; headers: Record<string, string> }, signal: AbortSignal): Promise<void>;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const canonical = (value: unknown): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}' : JSON.stringify(value);
function validate(request: RecordingEditRequest) {
  if (!uuid.test(request.operation_id) || !['merge', 'split'].includes(request.kind) || !['concatenate_sources', 'save_outputs'].includes(request.mode)) throw new Error('Invalid edit intent');
  const m = request.manifest;
  if (!m || m.processing !== 'transcribe_then_summarize' || m.sources.length < 1 || m.sources.length > 20 || m.outputs.length < 1 || m.outputs.length > 20
    || (m.metadata && Object.prototype.hasOwnProperty.call(m.metadata, 'derivation'))) throw new Error('Invalid edit manifest');
  if (request.kind === 'merge' ? m.sources.length < 2 || m.outputs.length !== 1 : m.sources.length !== 1 || m.outputs.length < 2 || request.mode !== 'save_outputs') throw new Error('Invalid edit counts');
  const ids = m.sources.map(s => s.kind === 'cloud_recording' ? s.recording_id : s.artifact_id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate edit source');
  for (const s of m.sources) if (!/^[a-f0-9]{64}$/.test(s.sha256)) throw new Error('Invalid source identity');
  if (request.mode === 'save_outputs') {
    let splitEnd = 0;
    for (const o of m.outputs) {
      if (!o.file || !o.intervals?.length || o.intervals.length > 20) throw new Error('Finished files and intervals are required');
      for (const interval of o.intervals) {
        const start = Number(interval.start_sample), end = Number(interval.end_sample), source = m.sources[interval.source_index];
        if (!source?.samples || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > Number(source.samples)) throw new Error('Invalid edit interval');
        if (request.kind === 'split') {
          if (o.intervals.length !== 1 || interval.source_index !== 0 || start !== splitEnd) throw new Error('Invalid split partition');
          splitEnd = end;
        }
      }
    }
    if (request.kind === 'split' && splitEnd !== Number(m.sources[0].samples)) throw new Error('Incomplete split partition');
  }
}

export function createRecordingEditClient<Handle = string>(host: RecordingEditHost<Handle>) {
  const scope = host.scopeKey;
  const active = new Map<string, { intent: string; promise: Promise<RecordingEditStatus> }>();
  const check = () => { host.checkScope(); if (host.scopeKey !== scope) throw new Error('Recording edit scope changed'); if (host.signal.aborted) throw new Error('Recording edit cancelled'); };
  async function send(method: 'GET' | 'POST', path: string, body?: unknown) {
    check(); const value = await host.request(method, path, body, host.signal); check(); return value;
  }
  function status(value: unknown, id: string): RecordingEditStatus {
    const s = value as RecordingEditStatus;
    if (!s || s.operation_id !== id || !['waiting_for_inputs', 'queued', 'processing', 'saved', 'failed', 'cancelled'].includes(s.state)
      || !Array.isArray(s.outputs) || s.outputs.length < 1 || s.outputs.length > 20 || !Array.isArray(s.required_uploads) || s.required_uploads.length > 20
      || s.outputs.some((o, i) => o.index !== i || !/^rec_[A-Za-z0-9_-]+$/.test(o.recording_id))
      || new Set(s.outputs.map(o => o.recording_id)).size !== s.outputs.length) throw new Error('Invalid edit response');
    return s;
  }
  const get = async (id: string) => { if (!uuid.test(id)) throw new Error('Invalid operation ID'); return status(await send('GET', '/' + id), id); };
  async function perform(request: RecordingEditRequest, files: Record<string, Handle>) {
    check(); validate(request);
    const previous = await host.load(request.operation_id); check();
    if (previous && previous.scope_key !== scope) throw new Error('Recording edit scope changed');
    if (previous && canonical(previous.request) !== canonical(request)) throw new Error('Operation ID belongs to different content');
    const journal: RecordingEditJournal<Handle> = previous ?? { version: 1, scope_key: scope, request, files };
    // Replay the exact persisted intent first: publication may have succeeded
    // even if its response or the local files were subsequently lost.
    let admitted = previous ? status(await send('POST', '', request), request.operation_id) : undefined;
    if (admitted && admitted.state !== 'waiting_for_inputs') return admitted;
    const expected = request.mode === 'save_outputs' ? request.manifest.outputs.map((o, index) => ({ slot: `output_${index}`, identity: o.file! }))
      : request.manifest.sources.flatMap((s, index) => s.kind === 'local_artifact' ? [{ slot: `input_${index}`, identity: s.file! }] : []);
    // Validate the entire local set before admitting or uploading any subset.
    for (const { slot, identity } of expected) {
      const handle = journal.files[slot];
      if (handle === undefined || !identity) throw new Error('Recording edit file is unavailable');
      const actual = await host.inspect(handle, host.signal); check();
      if (actual.sha256 !== identity.sha256 || actual.size_bytes !== identity.size_bytes) throw new Error('Recording edit file changed');
    }
    await host.save(request.operation_id, journal); check();
    admitted ??= status(await send('POST', '', request), request.operation_id);
    if (admitted.outputs.length !== request.manifest.outputs.length) throw new Error('Invalid output reservation');
    if (['queued', 'processing', 'saved', 'cancelled', 'failed'].includes(admitted.state)) return admitted;
    if (admitted.required_uploads.length !== expected.length || new Set(admitted.required_uploads.map(u => `${u.target}_${u.index}`)).size !== expected.length) throw new Error('Invalid upload reservation');
    for (const upload of admitted.required_uploads) {
      const slot = `${upload.target}_${upload.index}`, original = expected.find(e => e.slot === slot);
      if (!original || upload.sha256 !== original.identity.sha256 || upload.size_bytes !== original.identity.size_bytes || upload.content_type !== original.identity.content_type) throw new Error('Upload identity changed');
      const grant = await send('POST', `/${request.operation_id}/upload-attempts`, { target: upload.target, index: upload.index }) as { upload_url: string; headers: Record<string, string> };
      if (!grant || !/^https:\/\//.test(grant.upload_url) || !grant.headers || typeof grant.headers !== 'object') throw new Error('Invalid upload grant');
      check(); await host.upload(journal.files[slot], grant, host.signal); check();
    }
    return status(await send('POST', `/${request.operation_id}/finalize`, {}), request.operation_id);
  }
  function saveEdit(input: RecordingEditRequest, files: Record<string, Handle> = {}): Promise<RecordingEditStatus> {
    const request = JSON.parse(JSON.stringify(input)) as RecordingEditRequest, intent = canonical(request), current = active.get(request.operation_id);
    if (current) return current.intent === intent ? current.promise : Promise.reject(new Error('Operation ID belongs to different content'));
    const promise = perform(request, { ...files }).finally(() => active.delete(request.operation_id));
    active.set(request.operation_id, { intent, promise }); return promise;
  }
  return { saveEdit, get,
    async resume(id: string) {
      check(); const journal = await host.load(id); check();
      if (!journal || journal.version !== 1) throw new Error('Recording edit journal is unavailable');
      if (journal.scope_key !== scope) throw new Error('Recording edit scope changed');
      return saveEdit(journal.request, journal.files);
    },
    async retry(id: string) { if (!uuid.test(id)) throw new Error('Invalid operation ID'); return status(await send('POST', `/${id}/retry`, {}), id); },
    async cancel(id: string) { if (!uuid.test(id)) throw new Error('Invalid operation ID'); return status(await send('POST', `/${id}/cancel`, {}), id); },
  };
}
