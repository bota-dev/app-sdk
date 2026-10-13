/** Execute the same Rust-owned root route checks in Node/native and Hermes. */
export function runManagedRouteConformance(codec, success, check, same) {
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
    same(reduce({ type: 'CreateRecording' }).value.path, prefix + '/recordings', 'Exact managed recording route');
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
