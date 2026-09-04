import 'package:bota_flutter_sdk/bota_flutter_sdk.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('unknown wire values', () {
    test('preserve their raw values and compare by value', () {
      expect(BotaDeviceType.unknown(0xfe), BotaDeviceType.unknown(0xfe));
      expect(BotaDeviceType.unknown(0xfe).rawValue, 0xfe);
      expect(BotaPairingState.unknown(0xfd).rawValue, 0xfd);
      expect(BotaWifiState.unknown(0xfc).rawValue, 0xfc);
      expect(
        BotaRecordingState(
          active: true,
          initiatedBy: BotaRecordingInitiator.unknown(0xfb),
        ).initiatedBy.rawValue,
        0xfb,
      );
      expect(BotaFirmwarePhase.unknown(0xfa).rawValue, 0xfa);
      expect(BotaErrorCode.unknown(0xffff).rawValue, 0xffff);
      expect(BotaOperation.unknown(0xfffe).rawValue, 0xfffe);
    });
  });

  group('value equality', () {
    test('models compare and hash by value', () {
      final discoveredAt = DateTime.utc(2026, 9, 3);
      final first = BotaDiscoveredDevice(
        id: 'peripheral-1',
        name: 'Bota Pin',
        deviceType: BotaDeviceType.botaPin,
        pairingState: BotaPairingState.paired,
        rssi: -42,
        manufacturerData: const [1, 2, 3],
        discoveredAt: discoveredAt,
      );
      final second = BotaDiscoveredDevice(
        id: 'peripheral-1',
        name: 'Bota Pin',
        deviceType: BotaDeviceType.botaPin,
        pairingState: BotaPairingState.paired,
        rssi: -42,
        manufacturerData: const [1, 2, 3],
        discoveredAt: discoveredAt,
      );

      expect(first, second);
      expect(first.hashCode, second.hashCode);
      expect(
        BotaConnectionSettings(
          enabledConnections: const BotaEnabledConnections(
            wifi: true,
            cellular: false,
          ),
          uploadNetworkPreference: [BotaConnectionType.wifi],
        ),
        BotaConnectionSettings(
          enabledConnections: const BotaEnabledConnections(
            wifi: true,
            cellular: false,
          ),
          uploadNetworkPreference: [BotaConnectionType.wifi],
        ),
      );
      expect(
        BotaWifiScanResult(
          networks: const [
            BotaWifiNetwork(
              ssid: 'lab',
              quality: 80,
              isCurrent: true,
              isOpen: false,
            ),
          ],
          currentSsid: 'lab',
        ),
        BotaWifiScanResult(
          networks: const [
            BotaWifiNetwork(
              ssid: 'lab',
              quality: 80,
              isCurrent: true,
              isOpen: false,
            ),
          ],
          currentSsid: 'lab',
        ),
      );
    });

    test('errors compare by value while keeping detail out of toString', () {
      const first = BotaSdkException(
        code: BotaErrorCode.invalidInput,
        operation: BotaOperation.provision,
        retryable: false,
        protocolStatus: 7,
        detail: 'material bytes: [1, 2, 3]',
      );
      const second = BotaSdkException(
        code: BotaErrorCode.invalidInput,
        operation: BotaOperation.provision,
        retryable: false,
        protocolStatus: 7,
        detail: 'material bytes: [1, 2, 3]',
      );

      expect(first, second);
      expect(first.hashCode, second.hashCode);
      expect(first.toString(), isNot(contains('material')));
      expect(first.toString(), isNot(contains('[1, 2, 3]')));
      expect(first.toString(), contains('invalidInput'));
    });

    test('configuration and callback bundles compare by value', () {
      final firstCallbacks = BotaApplicationCallbacks();
      final secondCallbacks = BotaApplicationCallbacks();
      final first = BotaConfiguration(
        applicationSupportNamespace: 'dev.bota.test',
        callbacks: firstCallbacks,
      );
      final second = BotaConfiguration(
        applicationSupportNamespace: 'dev.bota.test',
        callbacks: secondCallbacks,
      );

      expect(first, second);
      expect(first.hashCode, second.hashCode);
      expect(firstCallbacks, secondCallbacks);
    });

    test('firmware sources hash separately allocated headers by content', () {
      final first = BotaFirmwareSource(
        requestId: 'request',
        url: Uri.parse('https://download.example/firmware'),
        headers: {'Authorization': 'Bearer token', 'Accept': 'application/bin'},
      );
      final second = BotaFirmwareSource(
        requestId: 'request',
        url: Uri.parse('https://download.example/firmware'),
        headers: {'Accept': 'application/bin', 'Authorization': 'Bearer token'},
      );

      expect(first, second);
      expect(first.hashCode, second.hashCode);
    });
  });

  group('byte-list ownership', () {
    test('discovered device copies manufacturer data on input and output', () {
      final bytes = <int>[1, 2, 3];
      final device = BotaDiscoveredDevice(
        id: 'device',
        rssi: -50,
        manufacturerData: bytes,
        discoveredAt: DateTime.utc(2026),
      );
      bytes[0] = 9;
      final exposed = device.manufacturerData!;
      exposed[1] = 9;

      expect(device.manufacturerData, [1, 2, 3]);
    });

    test('provisioning request copies nonce and device public key', () {
      final nonce = <int>[1, 2];
      final publicKey = <int>[3, 4];
      final request = BotaProvisioningMaterialRequest(
        requestId: 'request',
        serialNumber: 'serial',
        nonce: nonce,
        devicePublicKey: publicKey,
      );
      nonce[0] = 9;
      publicKey[0] = 9;
      request.nonce[1] = 9;
      request.devicePublicKey[1] = 9;

      expect(request.nonce, [1, 2]);
      expect(request.devicePublicKey, [3, 4]);
    });

    test('provisioning material copies endpoint and token', () {
      final endpoint = <int>[1, 2];
      final token = <int>[3, 4];
      final material = BotaProvisioningMaterial(
        requestId: 'request',
        apiEndpoint: endpoint,
        deviceToken: token,
        mtu: 256,
      );
      endpoint[0] = 9;
      token[0] = 9;
      material.apiEndpoint[1] = 9;
      material.deviceToken[1] = 9;

      expect(material.apiEndpoint, [1, 2]);
      expect(material.deviceToken, [3, 4]);
    });

    test('factory-reset values copy nonce and grant bytes', () {
      final nonce = <int>[1, 2];
      final grant = <int>[3, 4];
      final request = BotaFactoryResetGrantRequest(
        requestId: 'request',
        serialNumber: 'serial',
        nonce: nonce,
        commandId: 'command',
        bindingGeneration: 2,
      );
      final response = BotaFactoryResetGrant(
        requestId: 'request',
        grant: grant,
      );
      nonce[0] = 9;
      grant[0] = 9;
      request.nonce[1] = 9;
      response.grant[1] = 9;

      expect(request.nonce, [1, 2]);
      expect(response.grant, [3, 4]);
    });
  });
}
