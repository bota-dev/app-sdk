/** Shared native/generated/Hermes fixtures for the legacy generic-model boundary. */
export function runBoundModelConformance(codec, success, check, same) {
  var settings = { enabledConnections: { wifi: true, cellular: true },
    heartbeatEnabledConnections: { wifi: true, cellular: true },
    uploadNetworkPreference: ['wifi', 'ble', 'cellular'],
    powerManagement: { cellularIdleTimeoutSeconds: 180, wifiIdleTimeoutSeconds: 180 },
    streamingEnabled: false, streamingFlushIntervalSeconds: 60 };
  var hint = { serialNumber: '4KF6NOHWX0', model: 'pin', bindingGeneration: 3 };
  function request(model, boundModel) {
    return { settings: settings, model: model, serialNumber: '4KF6NOHWX0', boundModel: boundModel };
  }
  same(success(codec('encodeConnectionSettings', request('pin', null)), 'Known Pin settings'),
    [2, 3, 1, 2, 3, 18, 18, 0, 60, 131, 0, 0], 'Known model bytes unchanged');
  same(success(codec('encodeConnectionSettings', request('BOTA_DEV', hint)), 'Bound generic Pin settings'),
    [2, 3, 1, 2, 3, 18, 18, 0, 60, 131, 0, 0], 'Exact bound Pin fallback');
  same(success(codec('encodeConnectionSettings', request('BOTA_DEV', {
    serialNumber: '4KF6NOHWX0', model: 'note', bindingGeneration: 3,
  })), 'Bound generic Note settings'), [2, 1, 1, 2, 0, 18, 18, 0, 60, 129, 0, 0],
  'Note normalization never enables cellular');
  [request('BOTA_DEV', null), request('unknown', hint), request('note', hint),
    request('BOTA_DEV', { serialNumber: 'OTHERDEVICE', model: 'pin', bindingGeneration: 3 }),
    request('BOTA_DEV', { serialNumber: '4KF6NOHWX0', model: 'pin', bindingGeneration: 0 }),
    request('BOTA_DEV', { serialNumber: '4KF6NOHWX0', model: 'pin', bindingGeneration: 9007199254740992 }),
    request('BOTA_DEV', { serialNumber: '4KF6NOHWX0', model: 'BOTA_DEV', bindingGeneration: 3 }),
  ].forEach(function (input) {
    check(codec('encodeConnectionSettings', input).ok === false, 'Unsafe or unbound model must reject');
  });
}
