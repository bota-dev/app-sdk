/** Execute the same Rust-owned app route/migration checks in Node/native and Hermes. */
export function runManagedRouteConformance(codec, success, check, same) {
  var empty = [0x42, 0x56, 0x32, 0x4c, 0, 0, 0, 1, 0, 0, 0, 0];
  function catalog(bytes) { return success(codec('isEmptyLegacyAndroidV2CheckpointCatalog', { bytes: bytes }), 'Legacy checkpoint catalog'); }
  same(catalog(empty), true, 'Exact successful-clear catalog');
  for (var length = 0; length < empty.length; length++) same(catalog(empty.slice(0, length)), false, 'Truncated catalog remains pending');
  for (var index = 0; index < empty.length; index++) {
    var changed = empty.slice(); changed[index] ^= 1;
    same(catalog(changed), false, 'Noncanonical or nonempty catalog remains pending');
  }
  same(catalog(empty.concat([0])), false, 'Trailing catalog data remains pending');
  check(codec('isEmptyLegacyAndroidV2CheckpointCatalog', { bytes: [256] }).ok === false, 'Malformed catalog bytes reject');
  check(codec('isEmptyLegacyAndroidV2CheckpointCatalog', { bytes: [], unknown: true }).ok === false, 'Unknown catalog input rejects');
  var input = { operationId: 'upload-1', scope: { apiOrigin: 'https://api.example.com', apiBasePath: '',
    accountId: 'a', projectId: 'p', organizationId: 'org', environment: 'production', endUserId: 'eu_1',
    deviceId: 'dev_1', bindingGeneration: 2, serialNumber: 'BOTA1', nativeDeviceId: 'ble-id', scopeKey: 'a:p:production' },
  recording: { uuid: '00112233-4455-6677-8899-aabbccddeeff', generation: 3, ciphertextLength: '900',
    ciphertextSha256: 'aa'.repeat(32), startedAtMs: '1704067200123', durationMs: '1000', plaintextLength: '608', storageFormat: 3 },
  capability: { rawValueHex: '00'.repeat(24), flags: 0x37f } };
  function reduce(event) {
    return success(codec('reduceManagedUpload', { input: JSON.parse(JSON.stringify(input)), event: event }), 'Managed route reduction');
  }
  ['', '/v1', '/dashboard/projects/proj_a'].forEach(function (prefix) {
    input.scope.apiBasePath = prefix;
    var plan = reduce({ type: 'CreateRecording' }).value;
    same(plan.path, prefix + '/recordings', 'Exact managed recording route');
    var body = JSON.parse(plan.bodyJSON);
    same(body.device_id, input.scope.deviceId, 'Exact managed recording device');
    same(body.recording_uuid, input.recording.uuid, 'Exact managed recording UUID');
    same(body.recording_generation, input.recording.generation, 'Exact managed recording generation');
    same(reduce({ type: 'CreateSession', entry: { recordingId: 'rec_1' }, nonce: Array(16).fill(1) }).value.path,
      prefix + '/recordings/rec_1/encrypted-upload-v2/sessions', 'Exact managed session route');
  });
  ['/', '//evil.example', 'v1', '/v1/', '/v1//nested', '/v1/../nested', '/v1?x=1', '/v1#x', '/v%31', 'https://evil.example'].forEach(function (prefix) {
    input.scope.apiBasePath = prefix;
    check(reduce({ type: 'CreateRecording' }).error.code === 'BOTA_UPLOAD_INVALID_INPUT', 'Malformed managed prefix must reject');
  });
  delete input.scope.apiBasePath;
  same(reduce({ type: 'CreateRecording' }).value.path, '/v1/recordings', 'Omitted managed prefix keeps v1');
}
