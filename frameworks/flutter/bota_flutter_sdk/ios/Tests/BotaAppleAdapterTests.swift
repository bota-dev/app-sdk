import BotaAppleSDK
import Foundation
import XCTest

@testable import BotaFlutterSdk

@MainActor
final class BotaAppleAdapterTests: XCTestCase {
  private let validID = "0123456789abcdef0123456789abcdef"

  func testInvalidOperationIDFailsBeforeNativeState() async throws {
    let native = AdapterTestClient()
    let adapter = makeAdapter(native: native)

    do {
      try await adapter.configure(
        operationId: "not-an-id",
        configuration: configurationMessage()
      )
      XCTFail("expected invalid operation ID")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "invalid_operation_id")
    }

    let invocations = await native.invocations
    XCTAssertEqual(invocations, [])
  }

  func testOneShotOperationsMapToNativeManagersAndCallbacks() async throws {
    let native = AdapterTestClient()
    let flutter = AdapterTestFlutterApi()
    let adapter = makeAdapter(native: native, flutter: flutter)
    try await configure(adapter)
    try await discover(adapter, flutter: flutter, subscriptionID: id(32))
    flutter.clearEvents()

    let connected = try await adapter.connect(
      operationId: id(2),
      device: discoveredMessage(),
      serialNumber: "BP-001"
    )
    XCTAssertEqual(connected.serialNumber, "BP-001")
    _ = try await adapter.reconnect(
      operationId: id(3),
      serialNumber: "BP-001",
      hint: reconnectHint()
    )
    try await adapter.disconnect(operationId: id(4))
    _ = try await adapter.connect(
      operationId: id(5),
      device: discoveredMessage(),
      serialNumber: "BP-001"
    )
    _ = try await adapter.readDeviceStatus(operationId: id(6))
    try await adapter.cancelDeviceOperation(operationId: id(7))
    try await adapter.startRecording(
      operationId: id(8),
      device: deviceReference(),
      grantBlob: "c3RhcnQtZ3JhbnQ="
    )
    try await adapter.stopRecording(
      operationId: id(9),
      device: deviceReference(),
      grantBlob: "c3RvcC1ncmFudA=="
    )
    _ = try await adapter.readRecordingState(
      operationId: id(10),
      device: deviceReference()
    )
    try await adapter.provision(
      operationId: id(11),
      device: deviceReference()
    )
    _ = try await adapter.readConnectionSettings(
      operationId: id(12),
      device: deviceReference()
    )
    try await adapter.writeConnectionSettings(
      operationId: id(13),
      device: deviceReference(),
      settings: settingsMessage()
    )
    _ = try await adapter.deprovision(
      operationId: id(14),
      device: deviceReference(),
      grantBlob: "ZGVwcm92aXNpb24tZ3JhbnQ="
    )
    try await adapter.cancelProvisioningOperation(operationId: id(15))
    _ = try await adapter.factoryReset(
      operationId: id(16),
      device: deviceReference(),
      command: resetCommand()
    )
    _ = try await adapter.resumePendingFactoryReset(
      operationId: id(17),
      device: deviceReference(),
      currentBindingGeneration: 4
    )
    _ = try await adapter.resumeUnjournaledFactoryReset(
      operationId: id(18),
      device: deviceReference(),
      command: resetCommand(commandID: "command-2")
    )
    try await adapter.cancelFactoryResetOperation(operationId: id(19))
    _ = try await adapter.listRecordings(
      operationId: id(20),
      device: deviceReference()
    )
    _ = try await adapter.takeTransferMetadata(operationId: id(21), sinkId: "sink-1")
    try await adapter.confirmRecording(
      operationId: id(22),
      device: deviceReference(),
      recordingId: "recording-1"
    )
    try await adapter.cancelRecordingOperation(operationId: id(23))
    try await adapter.cancelOtaOperation(operationId: id(24))
    try await adapter.stopLogs(operationId: id(25))
    _ = try await adapter.configureWifi(
      operationId: id(26),
      device: deviceReference(),
      credentials: BotaWifiCredentialsMessage(ssid: "Bota", password: "secret"),
      grantBlob: "d2lmaS1ncmFudA=="
    )
    _ = try await adapter.disconnectWifi(
      operationId: id(27),
      device: deviceReference()
    )
    _ = try await adapter.readWifiStatus(
      operationId: id(28),
      device: deviceReference()
    )
    _ = try await adapter.scanWifi(
      operationId: id(29),
      device: deviceReference()
    )
    try await adapter.cancelWifiOperation(operationId: id(30))
    try await adapter.destroy(operationId: id(31))

    let invocations = await native.invocations
    XCTAssertEqual(
      Set(invocations),
      Set([
        "configure", "scanStream", "connect", "reconnect", "disconnect", "readDeviceStatus",
        "cancelDeviceOperation", "startRecording", "stopRecording", "readRecordingState",
        "provision", "readConnectionSettings", "writeConnectionSettings", "deprovision",
        "factoryReset", "resumePendingFactoryReset", "resumeUnjournaledFactoryReset",
        "listRecordings", "takeTransferMetadata", "confirmRecording", "configureWifi",
        "disconnectWifi", "readWifiStatus", "scanWifi",
        "destroy",
      ])
    )
    XCTAssertEqual(invocations.filter { $0 == "cancelDeviceOperation" }.count, 1)
    XCTAssertEqual(flutter.materialKinds, ["provisioning", "factoryReset"])
    XCTAssertEqual(flutter.persistedResetCommands, ["command-1", "durable-command", "command-2"])
    let startRecordingGrant = await native.startRecordingGrant
    let stopRecordingGrant = await native.stopRecordingGrant
    let deprovisionGrant = await native.deprovisionGrant
    let wifiGrant = await native.wifiGrant
    let recordedMaterialID = await native.provisioningMaterialID
    XCTAssertEqual(startRecordingGrant, "c3RhcnQtZ3JhbnQ=")
    XCTAssertEqual(stopRecordingGrant, "c3RvcC1ncmFudA==")
    XCTAssertEqual(deprovisionGrant, "ZGVwcm92aXNpb24tZ3JhbnQ=")
    XCTAssertEqual(wifiGrant, "d2lmaS1ncmFudA==")
    let materialID = try XCTUnwrap(recordedMaterialID)
    XCTAssertTrue(materialID.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil)
  }

  func testAllNativeStreamKindsEmitMappedEvents() async throws {
    let native = AdapterTestClient()
    let flutter = AdapterTestFlutterApi()
    let adapter = makeAdapter(native: native, flutter: flutter)
    try await configure(adapter)
    try await discover(adapter, flutter: flutter, subscriptionID: id(40))
    flutter.clearEvents()
    _ = try await adapter.connect(
      operationId: id(2),
      device: discoveredMessage(),
      serialNumber: "BP-001"
    )

    let requests: [BotaSubscriptionRequestMessage] = [
      BotaScanSubscriptionMessage(timeoutMillis: 1_000, allowDuplicates: false),
      BotaConnectionSubscriptionMessage(),
      BotaDeviceStatusSubscriptionMessage(),
      BotaRecordingStateSubscriptionMessage(device: deviceReference()),
      BotaRecordingSyncSubscriptionMessage(
        device: deviceReference(),
        recording: recordingMessage(),
        sinkId: "sink-1",
        confirmOnCompletion: false
      ),
      BotaUploadOwnershipSubscriptionMessage(
        device: deviceReference(),
        recordingId: "recording-1",
        uploadId: "upload-1",
        destinationId: "destination-1"
      ),
      BotaFirmwareUpdateSubscriptionMessage(
        device: deviceReference(),
        image: BotaFirmwareImageMessage(
          sourceId: "firmware-source",
          version: "1.2.3",
          sizeBytes: 512,
          crc32: 123
        )
      ),
      BotaLogSubscriptionMessage(device: deviceReference()),
      BotaWifiStatusSubscriptionMessage(device: deviceReference()),
    ]

    var expectedEventCount = 0
    for (offset, request) in requests.enumerated() {
      try await adapter.startSubscription(subscriptionId: id(50 + offset), request: request)
      expectedEventCount += offset == 4 || offset == 5 ? 3 : 2
      try await eventually { flutter.events.count == expectedEventCount }
    }

    XCTAssertEqual(Set(flutter.events.map(\.subscriptionId)).count, requests.count)
    XCTAssertEqual(flutter.callbackKinds, ["firmware"])
    let invocations = await native.invocations
    XCTAssertTrue(
      Set([
        "scanStream", "connectionStream", "deviceStatusStream", "recordingStateStream",
        "recordingSyncStream", "uploadOwnershipStream", "firmwareStream", "logStream",
        "wifiStatusStream",
      ]).isSubset(of: Set(invocations))
    )
  }

  func testCancellationRemovesSubscriptionBeforeStoppingNativeOwner() async throws {
    let native = AdapterTestClient(useHangingScan: true)
    let adapter = makeAdapter(native: native)
    try await configure(adapter)
    let subscriptionID = id(70)
    try await adapter.startSubscription(
      subscriptionId: subscriptionID,
      request: BotaScanSubscriptionMessage(timeoutMillis: 10_000, allowDuplicates: false)
    )

    try await adapter.cancelSubscription(subscriptionId: subscriptionID)

    let activeSubscriptionCount = adapter.activeSubscriptionCount
    let cancellationCount = await native.deviceCancellationCount
    XCTAssertEqual(activeSubscriptionCount, 0)
    XCTAssertEqual(cancellationCount, 1)
  }

  func testManualConnectRequiresThisEnginesDiscoveredHandle() async throws {
    let native = AdapterTestClient()
    let adapter = makeAdapter(native: native)
    try await configure(adapter)

    do {
      _ = try await adapter.connect(
        operationId: id(71),
        device: discoveredMessage(),
        serialNumber: "BP-001"
      )
      XCTFail("expected undiscovered handle rejection")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "device_not_found")
    }

    let invocations = await native.invocations
    XCTAssertFalse(invocations.contains("connect"))
  }

  func testOperationAndSubscriptionIDsShareTombstones() async throws {
    let native = AdapterTestClient()
    let adapter = makeAdapter(native: native)
    try await configure(adapter)

    let subscriptionID = id(72)
    try await adapter.startSubscription(
      subscriptionId: subscriptionID,
      request: BotaConnectionSubscriptionMessage()
    )
    try await eventually { adapter.activeSubscriptionCount == 0 }
    do {
      _ = try await adapter.readDeviceStatus(operationId: subscriptionID)
      XCTFail("expected subscription-to-operation reuse rejection")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "duplicate_identifier")
    }

    let operationID = id(73)
    _ = try await adapter.readDeviceStatus(operationId: operationID)
    do {
      try await adapter.startSubscription(
        subscriptionId: operationID,
        request: BotaConnectionSubscriptionMessage()
      )
      XCTFail("expected operation-to-subscription reuse rejection")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "duplicate_identifier")
    }
  }

  func testDetachDuringConfigureCannotRestoreLeaseOrConfiguration() async throws {
    let native = AdapterTestClient(suspendConfigure: true)
    let leases = NativeLeaseCoordinator(client: native)
    let adapter = makeAdapter(native: native, leases: leases)
    let configure = Task {
      try await adapter.configure(operationId: id(74), configuration: configurationMessage())
    }
    await native.waitUntilConfigureStarted()

    await adapter.detach()
    await native.resumeConfigure()

    do {
      try await configure.value
      XCTFail("expected detached configure to fail")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "engine_detached")
    }
    let leaseCount = await leases.leaseCount
    let destroyCount = await native.destroyCount
    XCTAssertEqual(leaseCount, 0)
    XCTAssertEqual(destroyCount, 1)
  }

  func testDetachRejectsSuspendedCallbackWork() async throws {
    let callbackNative = AdapterTestClient()
    let flutter = AdapterTestFlutterApi(responseMode: .suspendedMaterial)
    let callbackAdapter = makeAdapter(
      native: callbackNative,
      flutter: flutter,
      engineID: "callback-engine"
    )
    try await configure(callbackAdapter)
    _ = try await callbackAdapter.reconnect(
      operationId: id(75), serialNumber: "BP-001", hint: reconnectHint())
    let provision = Task {
      try await callbackAdapter.provision(
        operationId: self.id(76),
        device: self.deviceReference()
      )
    }
    await flutter.waitUntilMaterialRequested()
    await callbackAdapter.detach()
    flutter.resumeSuspendedMaterial()
    do {
      try await provision.value
      XCTFail("expected detached callback operation to fail")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "engine_detached")
    }
    let cancellationObservedPendingProvider =
      await callbackNative.provisioningCancellationObservedPendingProvider
    XCTAssertFalse(cancellationObservedPendingProvider)
  }

  func testProviderEnteringAfterDetachCannotRegisterFlutterCallback() async throws {
    let native = AdapterTestClient(delayProvisioningProviderUntilCancellation: true)
    let flutter = AdapterTestFlutterApi()
    let adapter = makeAdapter(native: native, flutter: flutter, engineID: "late-provider")
    try await configure(adapter)
    _ = try await adapter.reconnect(
      operationId: id(77), serialNumber: "BP-001", hint: reconnectHint())
    let provision = Task {
      try await adapter.provision(operationId: self.id(78), device: self.deviceReference())
    }
    await native.waitUntilProvisioningStarted()

    await adapter.detach()

    do {
      try await provision.value
      XCTFail("expected late provider to be rejected")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "engine_detached")
    }
    XCTAssertTrue(flutter.materialKinds.isEmpty)
  }

  func testDetachAwaitsCancelledOneShotUnwindBeforeOwnershipAndLeaseRelease() async throws {
    let native = AdapterTestClient(suspendReadStatus: true)
    let leases = NativeLeaseCoordinator(client: native)
    let adapterA = makeAdapter(native: native, leases: leases, engineID: "one-shot-owner")
    let adapterB = makeAdapter(native: native, leases: leases, engineID: "one-shot-other")
    try await configure(adapterA, operationID: id(79))
    try await configure(adapterB, operationID: id(80))
    let status = Task { try await adapterA.readDeviceStatus(operationId: self.id(81)) }
    await native.waitUntilReadStatusStarted()

    let detach = Task { await adapterA.detach() }
    await native.waitUntilReadStatusCancellationObserved()

    let leaseCountDuringUnwind = await leases.leaseCount
    XCTAssertEqual(leaseCountDuringUnwind, 2)
    do {
      _ = try await adapterB.readDeviceStatus(operationId: id(82))
      XCTFail("expected ownership to remain until the cancelled operation unwinds")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "operation_in_progress")
    }

    await native.allowReadStatusCancellationToUnwind()
    await detach.value
    do {
      _ = try await status.value
      XCTFail("expected detached one-shot operation to be cancelled")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "engine_detached")
    }

    _ = try await adapterB.readDeviceStatus(operationId: id(83))
    let finalLeaseCount = await leases.leaseCount
    XCTAssertEqual(finalLeaseCount, 1)
  }

  func testPublicCancellationAwaitsDirectReadUnwindBeforeReleasingOwnership() async throws {
    let native = AdapterTestClient(suspendReadStatus: true)
    let leases = NativeLeaseCoordinator(client: native)
    let adapterA = makeAdapter(native: native, leases: leases, engineID: "cancel-owner")
    let adapterB = makeAdapter(native: native, leases: leases, engineID: "cancel-other")
    try await configure(adapterA, operationID: id(90))
    try await configure(adapterB, operationID: id(91))
    let status = Task { try await adapterA.readDeviceStatus(operationId: self.id(92)) }
    await native.waitUntilReadStatusStarted()

    let cancel = Task { try await adapterA.cancelDeviceOperation(operationId: self.id(93)) }
    await native.waitUntilReadStatusCancellationObserved()

    do {
      _ = try await adapterB.readDeviceStatus(operationId: id(94))
      XCTFail("cancellation must retain ownership until the direct read unwinds")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "operation_in_progress")
    }

    await native.allowReadStatusCancellationToUnwind()
    try await cancel.value
    do {
      _ = try await status.value
      XCTFail("expected the direct read to be cancelled")
    } catch {}
    _ = try await adapterB.readDeviceStatus(operationId: id(95))
  }

  func testDetachRetainsOwnershipWhenNativeCancellationThrowsUntilDirectReadUnwinds() async throws {
    let native = AdapterTestClient(suspendReadStatus: true, failDeviceCancellation: true)
    let leases = NativeLeaseCoordinator(client: native)
    let adapterA = makeAdapter(native: native, leases: leases, engineID: "failed-cancel-owner")
    let adapterB = makeAdapter(native: native, leases: leases, engineID: "failed-cancel-other")
    try await configure(adapterA, operationID: id(90))
    try await configure(adapterB, operationID: id(91))
    let status = Task { try await adapterA.readDeviceStatus(operationId: self.id(92)) }
    await native.waitUntilReadStatusStarted()

    let detach = Task { await adapterA.detach() }
    await native.waitUntilReadStatusCancellationObserved()

    do {
      _ = try await adapterB.readDeviceStatus(operationId: id(93))
      XCTFail("failed native cancellation must retain ownership during unwind")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "operation_in_progress")
    }
    do {
      try await adapterB.cancelDeviceOperation(operationId: id(94))
      XCTFail("another engine must not cancel failed ownership")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "operation_not_owned")
    }
    let cancellationCountDuringUnwind = await native.deviceCancellationCount
    XCTAssertEqual(cancellationCountDuringUnwind, 1)

    await native.allowReadStatusCancellationToUnwind()
    await detach.value
    do {
      _ = try await status.value
      XCTFail("expected detached direct read to be cancelled")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "engine_detached")
    }

    _ = try await adapterB.readDeviceStatus(operationId: id(95))
    let finalLeaseCount = await leases.leaseCount
    XCTAssertEqual(finalLeaseCount, 1)
  }

  func testAnotherEngineCannotCancelOwnedNativeWork() async throws {
    let native = AdapterTestClient(useHangingScan: true)
    let leases = NativeLeaseCoordinator(client: native)
    let adapterA = makeAdapter(native: native, leases: leases, engineID: "owner")
    let adapterB = makeAdapter(native: native, leases: leases, engineID: "other")
    try await configure(adapterA, operationID: id(79))
    try await configure(adapterB, operationID: id(80))
    let subscriptionID = id(81)
    try await adapterA.startSubscription(
      subscriptionId: subscriptionID,
      request: BotaScanSubscriptionMessage(timeoutMillis: 10_000, allowDuplicates: false)
    )

    do {
      try await adapterB.cancelDeviceOperation(operationId: id(82))
      XCTFail("expected cross-engine cancellation rejection")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "operation_not_owned")
    }
    let crossEngineCancellationCount = await native.deviceCancellationCount
    XCTAssertEqual(crossEngineCancellationCount, 0)

    try await adapterA.cancelSubscription(subscriptionId: subscriptionID)
    let ownerCancellationCount = await native.deviceCancellationCount
    XCTAssertEqual(ownerCancellationCount, 1)
  }

  func testDetachRetainsOwnershipUntilSuspendedSubscriptionStartUnwinds() async throws {
    let native = AdapterTestClient(failDeviceCancellation: true, suspendScanStart: true)
    let leases = NativeLeaseCoordinator(client: native)
    let adapterA = makeAdapter(native: native, leases: leases, engineID: "starting-owner")
    let adapterB = makeAdapter(native: native, leases: leases, engineID: "starting-other")
    try await configure(adapterA, operationID: id(104))
    try await configure(adapterB, operationID: id(105))
    let subscriptionID = id(106)
    let start = Task {
      try await adapterA.startSubscription(
        subscriptionId: subscriptionID,
        request: BotaScanSubscriptionMessage(timeoutMillis: 10_000, allowDuplicates: false)
      )
    }
    await native.waitUntilScanStartSuspended()

    let detach = Task { await adapterA.detach() }
    await native.waitUntilScanStartCancellationObserved()

    do {
      _ = try await adapterB.readDeviceStatus(operationId: id(107))
      XCTFail("subscription start must retain category ownership during unwind")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "operation_in_progress")
    }
    do {
      try await adapterB.cancelDeviceOperation(operationId: id(108))
      XCTFail("another engine must not cancel a starting subscription")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "operation_not_owned")
    }

    await native.resumeScanStart()
    await detach.value
    do {
      try await start.value
      XCTFail("detached subscription start must fail")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "engine_detached")
    }
    let scanStartReturnedStream = await native.scanStartReturnedStream
    XCTAssertFalse(scanStartReturnedStream)
    let detachCancellationCount = await native.deviceCancellationCount
    XCTAssertEqual(detachCancellationCount, 0)
    _ = try await adapterB.readDeviceStatus(operationId: id(109))
  }

  func testPublicCancellationAwaitsSuspendedSubscriptionStartBeforeReleasingOwnership() async throws
  {
    let native = AdapterTestClient(suspendScanStart: true, ignoreScanStartCancellation: true)
    let leases = NativeLeaseCoordinator(client: native)
    let adapterA = makeAdapter(native: native, leases: leases, engineID: "cancel-start-owner")
    let adapterB = makeAdapter(native: native, leases: leases, engineID: "cancel-start-other")
    try await configure(adapterA, operationID: id(110))
    try await configure(adapterB, operationID: id(111))
    let subscriptionID = id(112)
    let start = Task {
      try await adapterA.startSubscription(
        subscriptionId: subscriptionID,
        request: BotaScanSubscriptionMessage(timeoutMillis: 10_000, allowDuplicates: false)
      )
    }
    await native.waitUntilScanStartSuspended()

    let cancel = Task { try await adapterA.cancelSubscription(subscriptionId: subscriptionID) }
    await native.waitUntilScanStartCancellationObserved()
    do {
      _ = try await adapterB.readDeviceStatus(operationId: id(113))
      XCTFail("public cancellation must retain ownership until start unwinds")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "operation_in_progress")
    }

    await native.resumeScanStart()
    try await cancel.value
    do {
      try await start.value
      XCTFail("cancelled subscription start must fail")
    } catch {}
    let scanStartReturnedStream = await native.scanStartReturnedStream
    let scanNativeActive = await native.scanNativeActive
    let cancellationCount = await native.deviceCancellationCount
    XCTAssertTrue(scanStartReturnedStream)
    XCTAssertFalse(scanNativeActive)
    XCTAssertEqual(cancellationCount, 1)
    _ = try await adapterB.readDeviceStatus(operationId: id(114))
  }

  func testDetachCancelsStartupTrackedBeforeCoordinatorAcquisition() async throws {
    let native = AdapterTestClient()
    let barrier = OperationAcquisitionBarrier()
    let leases = NativeLeaseCoordinator(
      client: native,
      beforeOperationAcquisition: { await barrier.wait() }
    )
    let adapter = makeAdapter(native: native, leases: leases, engineID: "pre-acquire-detach")
    try await configure(adapter, operationID: id(115))
    let start = Task {
      try await adapter.startSubscription(
        subscriptionId: id(116),
        request: BotaScanSubscriptionMessage(timeoutMillis: 10_000, allowDuplicates: false)
      )
    }
    await barrier.waitUntilEntered()

    let detach = Task { await adapter.detach() }
    await barrier.open()
    await detach.value
    do {
      try await start.value
      XCTFail("detached pre-acquisition startup must fail")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "engine_detached")
    }
    let detachStartedNativeStream = await native.scanStartReturnedStream
    XCTAssertFalse(detachStartedNativeStream)
  }

  func testPublicCancelSeesStartupTrackedBeforeCoordinatorAcquisition() async throws {
    let native = AdapterTestClient()
    let barrier = OperationAcquisitionBarrier()
    let leases = NativeLeaseCoordinator(
      client: native,
      beforeOperationAcquisition: { await barrier.wait() }
    )
    let adapter = makeAdapter(native: native, leases: leases, engineID: "pre-acquire-cancel")
    try await configure(adapter, operationID: id(117))
    let subscriptionID = id(118)
    let start = Task {
      try await adapter.startSubscription(
        subscriptionId: subscriptionID,
        request: BotaScanSubscriptionMessage(timeoutMillis: 10_000, allowDuplicates: false)
      )
    }
    await barrier.waitUntilEntered()

    let cancel = Task { try await adapter.cancelSubscription(subscriptionId: subscriptionID) }
    await barrier.open()
    try await cancel.value
    do {
      try await start.value
      XCTFail("cancelled pre-acquisition startup must fail")
    } catch {}
    let cancelStartedNativeStream = await native.scanStartReturnedStream
    XCTAssertFalse(cancelStartedNativeStream)
  }

  func testPublicCancellationPoisonsLateStartedStreamWhenPostStartStopThrows() async throws {
    let native = AdapterTestClient(
      failDeviceCancellation: true,
      suspendScanStart: true,
      ignoreScanStartCancellation: true
    )
    let leases = NativeLeaseCoordinator(client: native)
    let adapterA = makeAdapter(native: native, leases: leases, engineID: "late-cancel-owner")
    let adapterB = makeAdapter(native: native, leases: leases, engineID: "late-cancel-other")
    try await configure(adapterA, operationID: id(119))
    try await configure(adapterB, operationID: id(120))
    let subscriptionID = id(121)
    let start = Task {
      try await adapterA.startSubscription(
        subscriptionId: subscriptionID,
        request: BotaScanSubscriptionMessage(timeoutMillis: 10_000, allowDuplicates: false)
      )
    }
    await native.waitUntilScanStartSuspended()
    let cancel = Task { try await adapterA.cancelSubscription(subscriptionId: subscriptionID) }
    await native.waitUntilScanStartCancellationObserved()
    await native.resumeScanStart()
    do { try await cancel.value } catch {}
    do { try await start.value } catch {}
    let nativeActive = await native.scanNativeActive
    XCTAssertTrue(nativeActive)

    do {
      _ = try await adapterB.readDeviceStatus(operationId: id(122))
      XCTFail("late native stream must keep failed cancellation ownership poisoned")
    } catch let error as PigeonError { XCTAssertEqual(error.code, "operation_in_progress") }
    do {
      try await adapterB.cancelDeviceOperation(operationId: id(123))
      XCTFail("another engine must not cancel poisoned startup")
    } catch let error as PigeonError { XCTAssertEqual(error.code, "operation_not_owned") }

    await adapterA.detach()
    await adapterB.detach()
    let adapterC = makeAdapter(native: native, leases: leases, engineID: "late-cancel-recovery")
    try await configure(adapterC, operationID: id(124))
    _ = try await adapterC.readDeviceStatus(operationId: id(125))
  }

  func testDetachPoisonsLateStartedStreamWhenPostStartStopThrows() async throws {
    let native = AdapterTestClient(
      failDeviceCancellation: true,
      suspendScanStart: true,
      ignoreScanStartCancellation: true
    )
    let leases = NativeLeaseCoordinator(client: native)
    let adapterA = makeAdapter(native: native, leases: leases, engineID: "late-detach-owner")
    let adapterB = makeAdapter(native: native, leases: leases, engineID: "late-detach-other")
    try await configure(adapterA, operationID: id(126))
    try await configure(adapterB, operationID: id(127))
    let start = Task {
      try await adapterA.startSubscription(
        subscriptionId: id(128),
        request: BotaScanSubscriptionMessage(timeoutMillis: 10_000, allowDuplicates: false)
      )
    }
    await native.waitUntilScanStartSuspended()
    let detach = Task { await adapterA.detach() }
    await native.waitUntilScanStartCancellationObserved()
    await native.resumeScanStart()
    await detach.value
    do { try await start.value } catch {}

    do {
      _ = try await adapterB.readDeviceStatus(operationId: id(129))
      XCTFail("detach must preserve poison for a late native stream")
    } catch let error as PigeonError { XCTAssertEqual(error.code, "operation_in_progress") }
    do {
      try await adapterB.cancelDeviceOperation(operationId: id(130))
      XCTFail("another engine must not cancel detached poisoned startup")
    } catch let error as PigeonError { XCTAssertEqual(error.code, "operation_not_owned") }

    await adapterB.detach()
    let adapterC = makeAdapter(native: native, leases: leases, engineID: "late-detach-recovery")
    try await configure(adapterC, operationID: id(131))
    _ = try await adapterC.readDeviceStatus(operationId: id(132))
  }

  func testTerminalStreamCleanupRetainsOwnershipAndOwnerlessCancelIsNoOp() async throws {
    let native = AdapterTestClient(holdTerminalScanCleanup: true)
    let flutterA = AdapterTestFlutterApi()
    let leases = NativeLeaseCoordinator(client: native)
    let adapterA = makeAdapter(
      native: native, flutter: flutterA, leases: leases, engineID: "stream-owner")
    let adapterB = makeAdapter(native: native, leases: leases, engineID: "stream-other")
    try await configure(adapterA, operationID: id(84))
    try await configure(adapterB, operationID: id(85))
    let subscriptionID = id(86)
    try await adapterA.startSubscription(
      subscriptionId: subscriptionID,
      request: BotaScanSubscriptionMessage(timeoutMillis: 10_000, allowDuplicates: false)
    )

    await native.finishScanPublicStream()
    try await eventually {
      let activeSubscriptionCount = adapterA.activeSubscriptionCount
      let cancellationCount = await native.deviceCancellationCount
      return activeSubscriptionCount == 0 || cancellationCount > 0
    }

    do {
      _ = try await adapterB.readDeviceStatus(operationId: id(87))
      XCTFail("expected stream category to remain owned during native cleanup")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "operation_in_progress")
    }

    let crossEngineCancel = Task { () -> PigeonError? in
      do {
        try await adapterB.cancelDeviceOperation(operationId: self.id(88))
        return nil
      } catch {
        return error as? PigeonError
      }
    }
    try await eventually { await native.deviceCancellationCount == 1 }
    let cancellationCountDuringCleanup = await native.deviceCancellationCount
    XCTAssertEqual(cancellationCountDuringCleanup, 1)
    await native.allowTerminalScanCleanup()
    let crossEngineError = await crossEngineCancel.value
    XCTAssertEqual(crossEngineError?.code, "operation_not_owned")
    try await eventually {
      flutterA.events.contains { $0.payload is BotaSubscriptionCompleteEventMessage }
    }

    try await adapterB.cancelDeviceOperation(operationId: id(89))
    let finalCancellationCount = await native.deviceCancellationCount
    XCTAssertEqual(finalCancellationCount, 1)
  }

  func testNaturalStreamCompletionWithThrowingStopPoisonsOwnershipUntilFinalDestroy() async throws {
    let native = AdapterTestClient(
      failDeviceCancellation: true,
      holdTerminalScanCleanup: true
    )
    let leases = NativeLeaseCoordinator(client: native)
    let adapterA = makeAdapter(native: native, leases: leases, engineID: "failed-stream-owner")
    let adapterB = makeAdapter(native: native, leases: leases, engineID: "failed-stream-other")
    try await configure(adapterA, operationID: id(96))
    try await configure(adapterB, operationID: id(97))
    try await adapterA.startSubscription(
      subscriptionId: id(98),
      request: BotaScanSubscriptionMessage(timeoutMillis: 10_000, allowDuplicates: false)
    )

    await native.finishScanPublicStream()
    try await eventually {
      let cancellationCount = await native.deviceCancellationCount
      return adapterA.activeSubscriptionCount == 0 && cancellationCount == 1
    }

    do {
      _ = try await adapterB.readDeviceStatus(operationId: id(99))
      XCTFail("a terminal Flutter collector is not proof of native cleanup")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "operation_in_progress")
    }
    do {
      try await adapterB.cancelDeviceOperation(operationId: id(100))
      XCTFail("another engine must not cancel poisoned stream ownership")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "operation_not_owned")
    }

    await adapterA.detach()
    do {
      _ = try await adapterB.readDeviceStatus(operationId: id(101))
      XCTFail("a surviving lease must keep failed stream ownership poisoned")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "operation_in_progress")
    }
    await adapterB.detach()

    let adapterC = makeAdapter(native: native, leases: leases, engineID: "after-destroy")
    try await configure(adapterC, operationID: id(102))
    _ = try await adapterC.readDeviceStatus(operationId: id(103))
    let destroyCount = await native.destroyCount
    XCTAssertEqual(destroyCount, 1)
  }

  func testDurableResetResumeUsesOnlyCurrentDeviceAndGenerationAfterRestart() async throws {
    let native = AdapterTestClient()
    let first = makeAdapter(native: native, engineID: "first-lifecycle")
    try await configure(first)
    _ = try await first.reconnect(
      operationId: id(83), serialNumber: "BP-001", hint: reconnectHint())
    await first.detach()

    let flutter = AdapterTestFlutterApi()
    let second = makeAdapter(native: native, flutter: flutter, engineID: "second-lifecycle")
    try await configure(second, operationID: id(84))
    _ = try await second.reconnect(
      operationId: id(85), serialNumber: "BP-001", hint: reconnectHint())

    let completion = try await second.resumePendingFactoryReset(
      operationId: id(86),
      device: deviceReference(),
      currentBindingGeneration: 23
    )

    XCTAssertEqual(completion?.commandId, "durable-command")
    XCTAssertEqual(completion?.bindingGeneration, 23)
    let resumeBindingGeneration = await native.resumeBindingGeneration
    XCTAssertEqual(resumeBindingGeneration, 23)
    XCTAssertEqual(flutter.persistedResetCommands, ["durable-command"])
  }

  func testDetachReleasesOnlyItsEngineWork() async throws {
    let native = AdapterTestClient(useHangingScan: true)
    let flutterA = AdapterTestFlutterApi()
    let flutterB = AdapterTestFlutterApi()
    let leases = NativeLeaseCoordinator(client: native)
    let adapterA = makeAdapter(native: native, flutter: flutterA, leases: leases, engineID: "a")
    let adapterB = makeAdapter(native: native, flutter: flutterB, leases: leases, engineID: "b")
    try await configure(adapterA, operationID: id(1))
    try await configure(adapterB, operationID: id(2))
    try await adapterA.startSubscription(
      subscriptionId: id(80),
      request: BotaScanSubscriptionMessage(timeoutMillis: 10_000, allowDuplicates: false)
    )

    await adapterA.detach()

    let intermediateLeaseCount = await leases.leaseCount
    let intermediateDestroyCount = await native.destroyCount
    XCTAssertEqual(intermediateLeaseCount, 1)
    XCTAssertEqual(intermediateDestroyCount, 0)
    _ = try await adapterB.readDeviceStatus(operationId: id(81))
    await adapterB.detach()
    let finalDestroyCount = await native.destroyCount
    XCTAssertEqual(finalDestroyCount, 1)
  }

  func testConflictingEngineConfigurationUsesStableBridgeCode() async throws {
    let native = AdapterTestClient()
    let leases = NativeLeaseCoordinator(client: native)
    let first = makeAdapter(native: native, leases: leases, engineID: "first")
    let second = makeAdapter(native: native, leases: leases, engineID: "second")
    try await configure(first)

    do {
      try await second.configure(
        operationId: id(82),
        configuration: configurationMessage(namespace: "different")
      )
      XCTFail("expected configuration conflict")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "configuration_conflict")
    }

    let invocations = await native.invocations
    XCTAssertEqual(invocations.filter { $0 == "configure" }.count, 1)
  }

  func testUnknownRawValuesAndLargeValuesAreHandledExplicitly() throws {
    let unknown = try BotaAppleMapper.deviceType(.unknown(247))
    XCTAssertEqual(unknown.name, "unknown")
    XCTAssertEqual(unknown.rawValue, 247)
    XCTAssertEqual(
      try BotaAppleMapper.deviceType(
        BotaDeviceTypeMessage(name: "future", rawValue: 247)
      ),
      .unknown(247)
    )

    XCTAssertThrowsError(
      try BotaAppleMapper.recordingProgress(
        RecordingTransferProgress(
          completedBytes: UInt64(Int64.max) + 1,
          totalBytes: UInt64(Int64.max) + 1
        )
      )
    ) { error in
      XCTAssertEqual((error as? BotaSDKError)?.code, .payloadTooLarge)
    }

    let settings = try BotaAppleMapper.connectionSettings(
      DeviceConnectionSettings(
        enabledConnections: .init(wifi: true, cellular: false),
        uploadNetworkPreference: [.wifi],
        powerManagement: .init(wifiIdleTimeoutSeconds: 0, cellularIdleTimeoutSeconds: -1)
      ))
    XCTAssertEqual(settings.powerManagement.wifiIdleTimeoutMillis, 0)
    XCTAssertEqual(settings.powerManagement.cellularIdleTimeoutMillis, -1_000)

    let deprovision = BotaAppleMapper.deprovisionResult(
      DeprovisionResult(success: false, error: .invalidToken)
    )
    XCTAssertEqual(deprovision.error?.name, "invalidToken")
  }

  func testNativeErrorPreservesStableFields() async throws {
    let native = AdapterTestClient()
    await native.setReadStatusError(
      BotaSDKError(
        code: .unknown(900),
        operation: .unknown(901),
        retryable: true,
        protocolStatus: 17,
        detail: "native detail"
      )
    )
    let adapter = makeAdapter(native: native)
    try await configure(adapter)

    do {
      _ = try await adapter.readDeviceStatus(operationId: id(90))
      XCTFail("expected native error")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "bota_sdk_error")
      let details = try XCTUnwrap(error.details as? BotaErrorMessage)
      XCTAssertEqual(details.code.rawValue, 900)
      XCTAssertEqual(details.operation.rawValue, 901)
      XCTAssertTrue(details.retryable)
      XCTAssertEqual(details.protocolStatus, 17)
      XCTAssertEqual(details.detail, "native detail")
    }
  }

  func testCallbackResponseIDAndKindAreValidated() async throws {
    let native = AdapterTestClient()
    let wrongIDFlutter = AdapterTestFlutterApi(responseMode: .wrongID)
    let wrongID = makeAdapter(
      native: native,
      flutter: wrongIDFlutter,
      engineID: "wrong-id"
    )
    try await configure(wrongID)
    try await discover(wrongID, flutter: wrongIDFlutter, subscriptionID: id(96))
    _ = try await wrongID.connect(
      operationId: id(91),
      device: discoveredMessage(),
      serialNumber: "BP-001"
    )
    do {
      try await wrongID.provision(
        operationId: id(92),
        device: deviceReference()
      )
      XCTFail("expected callback ID rejection")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "callback_id_mismatch")
    }

    let wrongKindFlutter = AdapterTestFlutterApi(responseMode: .wrongMaterialKind)
    let wrongKind = makeAdapter(
      native: AdapterTestClient(),
      flutter: wrongKindFlutter,
      engineID: "wrong-kind"
    )
    try await configure(wrongKind, operationID: id(93))
    try await discover(wrongKind, flutter: wrongKindFlutter, subscriptionID: id(97))
    _ = try await wrongKind.connect(
      operationId: id(94),
      device: discoveredMessage(),
      serialNumber: "BP-001"
    )
    do {
      try await wrongKind.provision(
        operationId: id(95),
        device: deviceReference()
      )
      XCTFail("expected callback kind rejection")
    } catch let error as PigeonError {
      XCTAssertEqual(error.code, "callback_kind_mismatch")
    }
  }

  private func makeAdapter(
    native: AdapterTestClient,
    flutter: AdapterTestFlutterApi = AdapterTestFlutterApi(),
    leases: NativeLeaseCoordinator? = nil,
    engineID: String = "engine"
  ) -> BotaAppleAdapter {
    BotaAppleAdapter(
      engineID: engineID,
      client: native,
      leaseCoordinator: leases ?? NativeLeaseCoordinator(client: native),
      flutterApi: flutter,
      applicationSupportRoot: URL(fileURLWithPath: "/tmp/bota-flutter-tests")
    )
  }

  private func configure(
    _ adapter: BotaAppleAdapter,
    operationID: String = "00000000000000000000000000000001"
  ) async throws {
    try await adapter.configure(
      operationId: operationID,
      configuration: configurationMessage()
    )
  }

  private func configurationMessage(
    namespace: String = "adapter-tests"
  ) -> BotaConfigurationMessage {
    BotaConfigurationMessage(
      applicationSupportNamespace: namespace,
      hasProvisioningMaterialCallback: true,
      hasFactoryResetGrantCallback: true,
      hasFactoryResetResultCallback: true,
      hasFirmwareCallback: true
    )
  }

  private func discoveredMessage() -> BotaDiscoveredDeviceMessage {
    BotaDiscoveredDeviceMessage(
      id: "peripheral-1",
      name: "Bota Pin",
      deviceType: BotaDeviceTypeMessage(name: "botaPin", rawValue: nil),
      firmwareVersion: "1.0.0",
      macAddress: "AA:BB:CC:DD:EE:FF",
      pairingState: BotaPairingStateMessage(name: "paired", rawValue: nil),
      rssi: -42,
      discoveredAtMillis: 1_700_000_000_000
    )
  }

  private func reconnectHint() -> BotaReconnectHintMessage {
    BotaReconnectHintMessage(
      storedPeripheralId: "peripheral-1",
      advertisedAddress: nil,
      storedName: "Bota Pin",
      scanTimeoutMillis: 1_000,
      connectionTimeoutMillis: 2_000
    )
  }

  private func deviceReference() -> BotaDeviceReferenceMessage {
    BotaDeviceReferenceMessage(id: "peripheral-1")
  }

  private func resetCommand(commandID: String = "command-1") -> BotaFactoryResetCommandMessage {
    BotaFactoryResetCommandMessage(commandId: commandID, bindingGeneration: 4)
  }

  private func recordingMessage() -> BotaDeviceRecordingMessage {
    BotaDeviceRecordingMessage(
      recordingId: "recording-1",
      startedAtMillis: 1_700_000_000_000,
      durationMillis: 2_000,
      fileSizeBytes: 512,
      codec: BotaAudioCodecMessage(name: "opus16k", rawValue: nil),
      isEncrypted: true
    )
  }

  private func settingsMessage() -> BotaConnectionSettingsMessage {
    BotaConnectionSettingsMessage(
      enabledConnections: BotaEnabledConnectionsMessage(wifi: true, cellular: true),
      heartbeatEnabledConnections: BotaEnabledConnectionsMessage(wifi: true, cellular: false),
      heartbeatUnknownMask: 0,
      uploadNetworkPreference: [BotaConnectionTypeMessage(name: "wifi", rawValue: nil)],
      powerManagement: BotaPowerManagementMessage(
        wifiIdleTimeoutMillis: 180_000,
        cellularIdleTimeoutMillis: 120_000
      ),
      streamingEnabled: true,
      streamingFlushIntervalMillis: 60_000
    )
  }

  private func id(_ value: Int) -> String { String(format: "%032x", value) }

  private func discover(
    _ adapter: BotaAppleAdapter,
    flutter: AdapterTestFlutterApi,
    subscriptionID: String
  ) async throws {
    let initialEventCount = flutter.events.count
    try await adapter.startSubscription(
      subscriptionId: subscriptionID,
      request: BotaScanSubscriptionMessage(timeoutMillis: 1_000, allowDuplicates: false)
    )
    try await eventually { flutter.events.count >= initialEventCount + 2 }
  }

  private func eventually(
    timeoutNanoseconds: UInt64 = 2_000_000_000,
    _ predicate: @escaping () async -> Bool
  ) async throws {
    let start = ContinuousClock.now
    while !(await predicate()) {
      if ContinuousClock.now - start > .nanoseconds(Int64(timeoutNanoseconds)) {
        XCTFail("condition did not become true")
        return
      }
      try await Task.sleep(for: .milliseconds(10))
    }
  }
}

private final class AdapterTestFlutterApi: BotaFlutterApiProtocol, @unchecked Sendable {
  enum ResponseMode: Equatable {
    case valid
    case wrongID
    case wrongMaterialKind
    case suspendedMaterial
  }

  private let lock = NSLock()
  private let responseMode: ResponseMode
  private var storedEvents: [BotaEventMessage] = []
  private var storedMaterialKinds: [String] = []
  private var storedCallbackKinds: [String] = []
  private var storedPersistedResetCommands: [String] = []
  private var suspendedMaterialCompletion:
    ((Result<BotaMaterialResponseMessage, PigeonError>) -> Void)?

  var events: [BotaEventMessage] { lock.withLock { storedEvents } }
  var materialKinds: [String] { lock.withLock { storedMaterialKinds } }
  var callbackKinds: [String] { lock.withLock { storedCallbackKinds } }
  var persistedResetCommands: [String] { lock.withLock { storedPersistedResetCommands } }

  func clearEvents() { lock.withLock { storedEvents.removeAll() } }

  func waitUntilMaterialRequested() async {
    while lock.withLock({ suspendedMaterialCompletion == nil }) { await Task.yield() }
  }

  func resumeSuspendedMaterial() {
    let completion = lock.withLock {
      let completion = suspendedMaterialCompletion
      suspendedMaterialCompletion = nil
      return completion
    }
    completion?(
      .success(
        BotaProvisioningMaterialResponseMessage(
          requestId: String(repeating: "f", count: 32),
          apiEndpoint: .init(bytes: Data("https://api.bota.dev".utf8)),
          deviceToken: .init(bytes: Data("token".utf8)),
          mtu: 247
        )))
  }

  init(responseMode: ResponseMode = .valid) {
    self.responseMode = responseMode
  }

  func onEvent(event: BotaEventMessage) async throws {
    lock.withLock { storedEvents.append(event) }
  }

  func requestMaterial(
    request: BotaMaterialRequestMessage,
    completion: @escaping (Result<BotaMaterialResponseMessage, PigeonError>) -> Void
  ) {
    switch request {
    case let request as BotaProvisioningMaterialRequestMessage:
      lock.withLock { storedMaterialKinds.append("provisioning") }
      if responseMode == .suspendedMaterial {
        lock.withLock { suspendedMaterialCompletion = completion }
        return
      }
      if responseMode == .wrongMaterialKind {
        completion(
          .success(
            BotaFactoryResetGrantResponseMessage(
              requestId: request.requestId,
              encodedGrant: .init(bytes: Data([1]))
            )))
        return
      }
      completion(
        .success(
          BotaProvisioningMaterialResponseMessage(
            requestId: responseID(request.requestId),
            apiEndpoint: .init(bytes: Data("https://api.bota.dev".utf8)),
            deviceToken: .init(bytes: Data("token".utf8)),
            mtu: 247
          )))
    case let request as BotaFactoryResetGrantRequestMessage:
      lock.withLock { storedMaterialKinds.append("factoryReset") }
      completion(
        .success(
          BotaFactoryResetGrantResponseMessage(
            requestId: responseID(request.requestId),
            encodedGrant: .init(bytes: Data([1, 2, 3]))
          )))
    default:
      completion(
        .failure(
          PigeonError(
            code: "wrong_kind",
            message: nil,
            details: nil
          )))
    }
  }

  func requestFirmware(
    request: BotaFirmwareRequestMessage,
    completion: @escaping (Result<BotaFirmwareSourceMessage, PigeonError>) -> Void
  ) {
    lock.withLock { storedCallbackKinds.append("firmware") }
    completion(
      .success(
        BotaFirmwareSourceMessage(
          requestId: responseID(request.requestId),
          url: "https://example.com/firmware.bin",
          headers: ["Authorization": "redacted"]
        )))
  }

  func persistFactoryResetResult(
    request: BotaFactoryResetResultRequestMessage,
    completion:
      @escaping (Result<BotaFactoryResetResultAcknowledgementMessage, PigeonError>) -> Void
  ) {
    lock.withLock { storedPersistedResetCommands.append(request.commandId) }
    completion(
      .success(
        BotaFactoryResetResultAcknowledgementMessage(
          requestId: responseID(request.requestId)
        )))
  }

  private func responseID(_ requestID: String) -> String {
    responseMode == .wrongID ? String(repeating: "f", count: 32) : requestID
  }
}

private enum AdapterCancellationFailure: Error {
  case expected
}

private actor OperationAcquisitionBarrier {
  private var entered = false
  private var continuation: CheckedContinuation<Void, Never>?

  func wait() async {
    entered = true
    await withCheckedContinuation { continuation = $0 }
  }

  func waitUntilEntered() async {
    while !entered { await Task.yield() }
  }

  func open() {
    continuation?.resume()
    continuation = nil
  }
}

private actor AdapterTestClient: BotaAppleClientProtocol {
  private(set) var invocations: [String] = []
  private(set) var destroyCount = 0
  private(set) var deviceCancellationCount = 0
  private(set) var startRecordingGrant: String?
  private(set) var stopRecordingGrant: String?
  private(set) var provisioningMaterialID: String?
  private(set) var provisioningCancellationObservedPendingProvider = false
  private(set) var deprovisionGrant: String?
  private(set) var wifiGrant: String?
  private(set) var resumeBindingGeneration: UInt64?
  private var readStatusError: Error?
  private let useHangingScan: Bool
  private let suspendConfigure: Bool
  private let suspendReadStatus: Bool
  private let failDeviceCancellation: Bool
  private let delayProvisioningProviderUntilCancellation: Bool
  private let holdTerminalScanCleanup: Bool
  private let suspendScanStart: Bool
  private let ignoreScanStartCancellation: Bool
  private var configureStarted = false
  private var configureContinuation: CheckedContinuation<Void, Never>?
  private var readStatusStarted = false
  private var readStatusDidSuspend = false
  private var readStatusCancellationObserved = false
  private var readStatusContinuation: CheckedContinuation<DeviceStatus, Error>?
  private var readStatusUnwindContinuation: CheckedContinuation<Void, Never>?
  private var provisioningProviderPending = false
  private var provisioningStarted = false
  private var provisioningProviderContinuation: CheckedContinuation<Void, Never>?
  private var scanContinuation: AsyncThrowingStream<DiscoveredDevice, Error>.Continuation?
  private var terminalScanCleanupContinuation: CheckedContinuation<Void, Never>?
  private var terminalScanCleanupReleased = false
  private var scanStartSuspended = false
  private var scanStartCancellationObserved = false
  private(set) var scanStartReturnedStream = false
  private(set) var scanNativeActive = false
  private var scanStartContinuation: CheckedContinuation<Void, Never>?

  init(
    useHangingScan: Bool = false,
    suspendConfigure: Bool = false,
    suspendReadStatus: Bool = false,
    failDeviceCancellation: Bool = false,
    delayProvisioningProviderUntilCancellation: Bool = false,
    holdTerminalScanCleanup: Bool = false,
    suspendScanStart: Bool = false,
    ignoreScanStartCancellation: Bool = false
  ) {
    self.useHangingScan = useHangingScan
    self.suspendConfigure = suspendConfigure
    self.suspendReadStatus = suspendReadStatus
    self.failDeviceCancellation = failDeviceCancellation
    self.delayProvisioningProviderUntilCancellation =
      delayProvisioningProviderUntilCancellation
    self.holdTerminalScanCleanup = holdTerminalScanCleanup
    self.suspendScanStart = suspendScanStart
    self.ignoreScanStartCancellation = ignoreScanStartCancellation
  }

  func setReadStatusError(_ error: Error) { readStatusError = error }
  func configure(applicationSupportDirectory: URL) async throws {
    invocations.append("configure")
    configureStarted = true
    if suspendConfigure {
      await withCheckedContinuation { configureContinuation = $0 }
    }
  }
  func waitUntilConfigureStarted() async {
    while !configureStarted { await Task.yield() }
  }
  func resumeConfigure() {
    configureContinuation?.resume()
    configureContinuation = nil
  }
  func destroy() async {
    destroyCount += 1
    invocations.append("destroy")
  }

  func connect(_ device: DiscoveredDevice, serialNumber: String?) async throws -> ConnectedDevice {
    invocations.append("connect")
    return connected(serialNumber: serialNumber ?? "BP-001")
  }

  func reconnect(serialNumber: String, hint: DeviceReconnectHint) async throws -> ConnectedDevice {
    invocations.append("reconnect")
    return connected(serialNumber: serialNumber)
  }

  func disconnect() async throws { invocations.append("disconnect") }
  func readDeviceStatus() async throws -> DeviceStatus {
    invocations.append("readDeviceStatus")
    readStatusStarted = true
    if suspendReadStatus, !readStatusDidSuspend {
      readStatusDidSuspend = true
      do {
        return try await withTaskCancellationHandler {
          try await withCheckedThrowingContinuation { readStatusContinuation = $0 }
        } onCancel: {
          Task { await self.cancelSuspendedReadStatusFromTask() }
        }
      } catch is CancellationError {
        readStatusCancellationObserved = true
        await withCheckedContinuation { readStatusUnwindContinuation = $0 }
        throw CancellationError()
      }
    }
    if let readStatusError { throw readStatusError }
    return status()
  }
  func waitUntilReadStatusStarted() async {
    while !readStatusStarted { await Task.yield() }
  }
  func waitUntilReadStatusCancellationObserved() async {
    while !readStatusCancellationObserved { await Task.yield() }
  }
  func allowReadStatusCancellationToUnwind() {
    readStatusUnwindContinuation?.resume()
    readStatusUnwindContinuation = nil
  }
  private func cancelSuspendedReadStatusFromTask() {
    readStatusContinuation?.resume(throwing: CancellationError())
    readStatusContinuation = nil
  }
  func cancelDeviceOperation() async throws {
    deviceCancellationCount += 1
    invocations.append("cancelDeviceOperation")
    if failDeviceCancellation { throw AdapterCancellationFailure.expected }
    scanNativeActive = false
    if holdTerminalScanCleanup, !terminalScanCleanupReleased {
      await withCheckedContinuation { terminalScanCleanupContinuation = $0 }
    }
  }
  func startRecording(_ device: ConnectedDevice, grantBlob: String) async throws {
    startRecordingGrant = grantBlob
    invocations.append("startRecording")
  }
  func stopRecording(_ device: ConnectedDevice, grantBlob: String) async throws {
    stopRecordingGrant = grantBlob
    invocations.append("stopRecording")
  }
  func readRecordingState(_ device: ConnectedDevice) async throws -> RecordingState {
    invocations.append("readRecordingState")
    return RecordingState(active: true, recordingID: "recording-1", initiatedBy: .remote)
  }
  func provision(
    _ device: ConnectedDevice,
    materialID: String,
    using provider: @escaping ProvisioningMaterialProvider
  ) async throws {
    provisioningMaterialID = materialID
    invocations.append("provision")
    provisioningStarted = true
    if delayProvisioningProviderUntilCancellation {
      await withCheckedContinuation { provisioningProviderContinuation = $0 }
    }
    provisioningProviderPending = true
    defer { provisioningProviderPending = false }
    _ = try await provider(
      ProvisioningMaterialRequest(
        serialNumber: device.serialNumber,
        nonce: Data([1]),
        devicePublicKey: Data([2])
      ))
  }
  func readConnectionSettings(_ device: ConnectedDevice) async throws -> DeviceConnectionSettings {
    invocations.append("readConnectionSettings")
    return settings()
  }
  func writeConnectionSettings(_ settings: DeviceConnectionSettings, to device: ConnectedDevice)
    async throws
  {
    invocations.append("writeConnectionSettings")
  }
  func deprovision(_ device: ConnectedDevice, grantBlob: String) async throws -> DeprovisionResult {
    deprovisionGrant = grantBlob
    invocations.append("deprovision")
    return DeprovisionResult(success: true)
  }
  func cancelProvisioningOperation() async throws {
    provisioningCancellationObservedPendingProvider = provisioningProviderPending
    invocations.append("cancelProvisioningOperation")
    provisioningProviderContinuation?.resume()
    provisioningProviderContinuation = nil
  }
  func waitUntilProvisioningStarted() async {
    while !provisioningStarted { await Task.yield() }
  }
  func factoryReset(
    _ device: ConnectedDevice,
    commandID: String,
    grantID: String,
    bindingGeneration: UInt64,
    persistResult: @escaping FactoryResetResultPersister,
    using provider: @escaping FactoryResetGrantProvider
  ) async throws -> FactoryResetCompletion {
    invocations.append("factoryReset")
    _ = try await provider(
      FactoryResetGrantRequest(
        serialNumber: device.serialNumber,
        nonce: Data([3]),
        commandID: commandID,
        bindingGeneration: bindingGeneration
      ))
    try await persistResult(
      .init(
        commandID: commandID,
        bindingGeneration: bindingGeneration,
        localRecordingsDeleted: 2
      ))
    return FactoryResetCompletion(commandID: commandID, bindingGeneration: bindingGeneration)
  }
  func resumePendingFactoryReset(
    _ device: ConnectedDevice,
    currentBindingGeneration: UInt64,
    persistResult: @escaping FactoryResetResultPersister
  ) async throws -> FactoryResetCompletion? {
    invocations.append("resumePendingFactoryReset")
    resumeBindingGeneration = currentBindingGeneration
    try await persistResult(
      .init(
        commandID: "durable-command",
        bindingGeneration: currentBindingGeneration,
        localRecordingsDeleted: 2
      ))
    return FactoryResetCompletion(
      commandID: "durable-command", bindingGeneration: currentBindingGeneration)
  }
  func resumeUnjournaledFactoryReset(
    _ device: ConnectedDevice,
    commandID: String,
    bindingGeneration: UInt64,
    persistResult: @escaping FactoryResetResultPersister
  ) async throws -> FactoryResetCompletion {
    invocations.append("resumeUnjournaledFactoryReset")
    try await persistResult(
      .init(
        commandID: commandID,
        bindingGeneration: bindingGeneration,
        localRecordingsDeleted: 2
      ))
    return FactoryResetCompletion(commandID: commandID, bindingGeneration: bindingGeneration)
  }
  func cancelFactoryResetOperation() async throws {
    invocations.append("cancelFactoryResetOperation")
  }
  func listRecordings(_ device: ConnectedDevice) async throws -> [DeviceRecording] {
    invocations.append("listRecordings")
    return [recording()]
  }
  func takeTransferMetadata(sinkID: String) async -> RecordingTransferMetadata? {
    invocations.append("takeTransferMetadata")
    return RecordingTransferMetadata(isE2EEncrypted: true, contentSHA256Hex: "abc")
  }
  func confirmRecording(_ device: ConnectedDevice, recordingUUID: String) async throws {
    invocations.append("confirmRecording")
  }
  func cancelRecordingOperation() async throws { invocations.append("cancelRecordingOperation") }
  func cancelOtaOperation() async throws { invocations.append("cancelOtaOperation") }
  func stopLogs() async throws { invocations.append("stopLogs") }
  func configureWifi(
    _ device: ConnectedDevice,
    ssid: String,
    password: String,
    grantBlob: String
  ) async throws -> WiFiConfigResult {
    wifiGrant = grantBlob
    invocations.append("configureWifi")
    return .success
  }
  func disconnectWifi(_ device: ConnectedDevice) async throws -> WiFiConfigResult {
    invocations.append("disconnectWifi")
    return .success
  }
  func readWifiStatus(_ device: ConnectedDevice) async throws -> WiFiStatusInfo {
    invocations.append("readWifiStatus")
    return wifiStatus()
  }
  func scanWifi(_ device: ConnectedDevice) async throws -> DeviceWiFiScanResult {
    invocations.append("scanWifi")
    return DeviceWiFiScanResult(
      networks: [.init(ssid: "Bota", quality: 80, isCurrent: true, isOpen: false)],
      currentSSID: "Bota"
    )
  }
  func cancelWifiOperation() async { invocations.append("cancelWifiOperation") }

  func scanStream(timeoutMilliseconds: UInt64, allowDuplicates: Bool) async throws
    -> AsyncThrowingStream<DiscoveredDevice, Error>
  {
    invocations.append("scanStream")
    if suspendScanStart {
      scanStartSuspended = true
      await withTaskCancellationHandler {
        await withCheckedContinuation { scanStartContinuation = $0 }
      } onCancel: {
        Task { await self.recordScanStartCancellation() }
      }
      if !ignoreScanStartCancellation { try Task.checkCancellation() }
      scanStartReturnedStream = true
      scanNativeActive = true
    }
    if useHangingScan { return AsyncThrowingStream { _ in } }
    if holdTerminalScanCleanup {
      let pair = AsyncThrowingStream<DiscoveredDevice, Error>.makeStream()
      scanContinuation = pair.continuation
      return pair.stream
    }
    return throwingStream(discovered())
  }
  func waitUntilScanStartSuspended() async {
    while !scanStartSuspended { await Task.yield() }
  }
  func waitUntilScanStartCancellationObserved() async {
    while !scanStartCancellationObserved { await Task.yield() }
  }
  private func recordScanStartCancellation() { scanStartCancellationObserved = true }
  func resumeScanStart() {
    scanStartContinuation?.resume()
    scanStartContinuation = nil
  }
  func finishScanPublicStream() {
    scanContinuation?.finish()
    scanContinuation = nil
  }
  func allowTerminalScanCleanup() {
    terminalScanCleanupReleased = true
    terminalScanCleanupContinuation?.resume()
    terminalScanCleanupContinuation = nil
  }
  func connectionStream() async -> AsyncStream<ConnectedDevice?> {
    invocations.append("connectionStream")
    return AsyncStream { continuation in
      continuation.yield(connected())
      continuation.finish()
    }
  }
  func deviceStatusStream() async throws -> AsyncThrowingStream<DeviceStatus, Error> {
    invocations.append("deviceStatusStream")
    return throwingStream(status())
  }
  func recordingStateStream(_ device: ConnectedDevice) async throws
    -> AsyncThrowingStream<RecordingState, Error>
  {
    invocations.append("recordingStateStream")
    return throwingStream(
      RecordingState(active: true, recordingID: "recording-1", initiatedBy: .remote))
  }
  func recordingSyncStream(
    _ device: ConnectedDevice,
    recording: DeviceRecording,
    sinkID: String,
    confirmOnCompletion: Bool
  ) async throws -> AsyncThrowingStream<RecordingSyncEvent, Error> {
    invocations.append("recordingSyncStream")
    return AsyncThrowingStream { continuation in
      continuation.yield(.progress(.init(completedBytes: 256, totalBytes: 512)))
      continuation.yield(.completed(URL(fileURLWithPath: "/tmp/recording.ogg")))
      continuation.finish()
    }
  }
  func uploadOwnershipStream(
    _ device: ConnectedDevice,
    recordingUUID: String,
    uploadID: String,
    destinationID: String
  ) async throws -> AsyncThrowingStream<UploadOwnershipEvent, Error> {
    invocations.append("uploadOwnershipStream")
    return AsyncThrowingStream { continuation in
      continuation.yield(.progress(.init(completedBytes: 512, totalBytes: 512)))
      continuation.yield(.result(.deviceUploadCompleted))
      continuation.finish()
    }
  }
  func firmwareStream(_ device: ConnectedDevice, image: FirmwareImage) async throws
    -> AsyncThrowingStream<FirmwareUpdateProgress, Error>
  {
    invocations.append("firmwareStream")
    return throwingStream(.init(phase: .complete, completedBytes: 512, totalBytes: 512))
  }
  func logStream(_ device: ConnectedDevice) async throws -> AsyncThrowingStream<
    DeviceLogLine, Error
  > {
    invocations.append("logStream")
    return throwingStream(.init(message: "ready", isBacklog: false))
  }
  func wifiStatusStream(_ device: ConnectedDevice) async throws
    -> AsyncThrowingStream<WiFiStatusInfo, Error>
  {
    invocations.append("wifiStatusStream")
    return throwingStream(wifiStatus())
  }

  private func connected(serialNumber: String = "BP-001") -> ConnectedDevice {
    ConnectedDevice(
      id: "peripheral-1",
      serialNumber: serialNumber,
      deviceType: .botaPin,
      firmwareVersion: "1.0.0",
      isProvisioned: true,
      connectionState: .connected,
      mtu: 247
    )
  }
  private func discovered() -> DiscoveredDevice {
    DiscoveredDevice(
      id: "peripheral-1",
      name: "Bota Pin",
      deviceType: .botaPin,
      firmwareVersion: "1.0.0",
      macAddress: "AA:BB:CC:DD:EE:FF",
      pairingState: .paired,
      rssi: -42,
      discoveredAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
  }
  private func status() -> DeviceStatus {
    DeviceStatus(
      batteryLevel: 80,
      storageTotalMb: 8_192,
      storageUsedMb: 256,
      state: .known(.idle),
      pendingRecordings: 1,
      lastTimeSyncAt: Date(timeIntervalSince1970: 1_700_000_000),
      signalStrength: -50,
      flags: .init(
        charging: false,
        lowBattery: false,
        storageFull: false,
        wifiConnected: true,
        lteConnected: false,
        syncActive: false
      ),
      timestamp: 123,
      lteStatus: .unknown(99),
      wifiStatus: .known(.connected)
    )
  }
  private func settings() -> DeviceConnectionSettings {
    DeviceConnectionSettings(
      enabledConnections: .init(wifi: true, cellular: true),
      heartbeatEnabledConnections: .init(wifi: true, cellular: false),
      uploadNetworkPreference: [.wifi],
      powerManagement: .init(wifiIdleTimeoutSeconds: 180, cellularIdleTimeoutSeconds: 120),
      streamingEnabled: true,
      streamingFlushIntervalSeconds: 60
    )
  }
  private func recording() -> DeviceRecording {
    DeviceRecording(
      uuid: "recording-1",
      startedAt: Date(timeIntervalSince1970: 1_700_000_000),
      durationMs: 2_000,
      fileSizeBytes: 512,
      codec: .known(.opus16k),
      isEncrypted: true
    )
  }
  private func wifiStatus() -> WiFiStatusInfo {
    WiFiStatusInfo(status: .connected, signalStrength: 80, ssid: "Bota")
  }
}

private func throwingStream<Element: Sendable>(_ element: Element) -> AsyncThrowingStream<
  Element, Error
> {
  AsyncThrowingStream { continuation in
    continuation.yield(element)
    continuation.finish()
  }
}
