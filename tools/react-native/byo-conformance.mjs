/** One portable trace used by Node/native differential and the Hermes VM. */
export function runByoConformance(codec, success, check, same, encode) {
  var uuid = '01234567-89ab-cdef-0123-456789abcdef';
  var session = '11111111-2222-3333-4444-555555555555';
  var sourceHash = '4d589f89bf33fb54046b592c71fd621ba0c80f192151f4b1d08b0ee0baafd2eb';
  var input = { operationId: 'byo-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', mode: 'sync',
    device: { id: 'ble-1', serialNumber: 'BOTA1', connectionState: 'connected', mtu: 247 },
    recording: { uuid: uuid, generation: 1 }, scope: { baseUrl: 'https://proxy.example/v1/',
      scopeKey: 'account/project/\u4e2d', organizationId: 'org_1', projectId: 'prj_1',
      environment: 'production', deviceId: 'dev_1', bindingGeneration: 1 } };
  var context = { organization_id: 'org_1', project_id: 'prj_1', device_id: 'dev_1', environment: 'production',
    binding_generation: 1, device_assignment_generation: 1, policy_revision: '1', recording_uuid: uuid,
    recording_generation: 1, channel: 'ble', upload_session_id: session, recording_id: 'rec_1',
    configuration_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', configuration_revision: 1,
    destination_ref: 'dest_1', owner_revision: 1, ciphertext_length: 300, ciphertext_sha256: sourceHash };
  function encoded(value) { return Array.prototype.slice.call(encode(JSON.stringify(value))); }
  function filled(length, value) { var result = []; for (var index = 0; index < length; index++) result.push(value); return result; }
  function next(step, event) {
    return codec('advanceByoMachine', { state: step.state, event: event, nowMs: '2',
      randomUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  }
  ['readAuthNonce', 'requestStopRecording', 'readRecordingState', 'requestStartRecording', 'deleteAllRecordings'].forEach(function (control) {
    var policy = success(codec('byoHostPolicy', { mode: 'sync', selectedLive: true, control: control }), 'BYO live control policy');
    same(policy.allowControl, ['readAuthNonce', 'requestStopRecording', 'readRecordingState'].indexOf(control) !== -1,
      'BYO concurrent controls must retain the exact live allowlist');
    same(success(codec('byoHostPolicy', { mode: 'stream', selectedLive: false, control: control }), 'BYO inactive control policy').allowControl,
      false, 'BYO inactive owner cannot borrow a control');
    same(policy.releaseOperation, 7, 'BYO release must remain non-destructive ABORT');
  });
  var plan = success(codec('planByoBleRequest', { operation: 8, requestId: 41, capacity: 20, bytes: [1, 2, 3, 4], offset: 0 }), 'BYO framing');
  same(plan.bytes, [112, 3, 8, 0, 41, 0, 0, 0, 0, 0, 4, 0, 1, 2, 3, 4], 'BYO canonical BLE request bytes');
  same(plan.expectedOffset, 0, 'BYO final request response starts at zero');
  same(success(codec('acceptByoBleReply', { bytes: [113, 3, 8, 0, 41, 0, 0, 0, 0, 0, 1, 0, 77],
    requestId: 41, operation: 8, expectedOffset: 0, requestBytes: [1, 2, 3, 4] }), 'BYO reply'),
    { payload: [77], offset: 0, total: 1 }, 'BYO exact framed reply');
  same(success(codec('acceptByoBleReply', { bytes: [113, 3, 8, 0, 40, 0, 0, 0, 0, 0, 0, 0],
    requestId: 41, operation: 8, expectedOffset: 0, requestBytes: [] }), 'BYO stale reply'), null, 'BYO ignores retired request replies');
  check(codec('acceptByoBleReply', { bytes: [113, 3, 8, 0, 42, 0, 0, 0, 0, 0, 0, 0],
    requestId: 41, operation: 8, expectedOffset: 0, requestBytes: [] }).ok === false, 'BYO future request reply must reject');

  var step = success(codec('startByoMachine', { input: input, nowMs: '1' }), 'BYO action machine start');
  same(step.action.kind, 'refresh', 'BYO starts with fresh physical context');
  var stages = [];
  for (var iteration = 0; iteration < 80; iteration++) {
    var stage = step.state.stage;
    var action = step.action;
    stages.push(stage);
    if (action.kind === 'result') break;
    var value;
    if (stage === 'saved' && step.state.next === 'receipt_persisted') {
      check(next(step, { error: { code: 'persistence_failed' } }).ok === false, 'Failed BYO receipt journal cannot authorize cleanup');
    }
    switch (action.kind) {
      case 'refresh': case 'save': case 'load': case 'file_start': case 'file_finish':
      case 'put': case 'file_remove': case 'wait': value = null; break;
      case 'file_append': value = '300'; break;
      case 'ble':
        if (stage === 'capabilities') value = encoded({ upload_modes: ['whole_file'] });
        else if (stage === 'select_source') value = encoded({ recording_uuid: uuid, recording_generation: 1, ciphertext_length: 300, ciphertext_sha256: sourceHash });
        else if (stage === 'open') value = encoded({ manifest: { ciphertext_length: 300, ciphertext_sha256: sourceHash } });
        else if (stage === 'download') value = filled(300, 3);
        else if (stage === 'receipt') value = filled(32, 4);
        else if (stage === 'confirm') {
          same(step.state.recovery.phase, 'CleanupPending', 'BYO CONFIRM requires durable verified receipt');
          value = [];
        } else throw new Error('Unexpected BYO BLE conformance action ' + stage);
        break;
      case 'http':
        if (stage === 'selection') value = encoded({ data: { destination: { kind: 'customer' } } });
        else if (stage === 'create_context') value = encoded({ data: { context: context } });
        else if (stage === 'prepare') value = encoded({ data: { authorization: { configuration_sha256: 'abababababababababababababababababababababababababababababababab' }, status: {} } });
        else if (stage === 'upload') value = encoded({ data: { status: {}, upload: { method: 'PUT', url: 'https://storage.example/key', headers: { 'content-type': 'application/octet-stream' } } } });
        else if (stage === 'complete') value = encoded({ data: { receipt: { signature: 'device-verifies' } } });
        else throw new Error('Unexpected BYO HTTP conformance action ' + stage);
        break;
      default: throw new Error('Unexpected BYO conformance action ' + action.kind);
    }
    step = success(next(step, { ok: value }), 'BYO action machine advance ' + stage);
  }
  same(step.action.kind, 'result', 'BYO action trace must reach verified completion');
  same(step.action.value, { recordingId: 'rec_1', uploadSessionId: session }, 'BYO public result is metadata only');
  same(step.state.recovery.phase, 'Complete', 'BYO complete checkpoint');
  check(stages.indexOf('select_source') < stages.indexOf('create_context'), 'BYO device selection must precede CREATE');
  check(stages.indexOf('confirm') > stages.indexOf('receipt') + 2, 'BYO receipt and checkpoint persistence must precede CONFIRM');
}
