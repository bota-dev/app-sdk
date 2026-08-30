@preconcurrency import CoreBluetooth
import Foundation

final class CoreBluetoothDriver: NSObject, CentralDriver, @unchecked Sendable {
    private struct CharacteristicKey: Hashable {
        let peripheralID: UUID
        let characteristicUUID: CBUUID
    }

    private struct CharacteristicDiscovery {
        var remainingServices: Set<CBUUID>
        let continuation: CheckedContinuation<Void, Error>
    }

    private struct NotificationSetup {
        let enabling: Bool
        let continuation: CheckedContinuation<Void, Error>
    }

    private let queue: DispatchQueue
    private var manager: CBCentralManager!
    private var peripherals: [UUID: CBPeripheral] = [:]
    private var characteristics: [CharacteristicKey: CBCharacteristic] = [:]
    private var scanContinuation: AsyncThrowingStream<CentralAdvertisement, Error>.Continuation?
    private var connectContinuations: [UUID: CheckedContinuation<Void, Error>] = [:]
    private var serviceContinuations: [UUID: CheckedContinuation<[String], Error>] = [:]
    private var characteristicDiscoveries: [UUID: CharacteristicDiscovery] = [:]
    private var disconnectContinuations: [UUID: CheckedContinuation<Void, Error>] = [:]
    private var readContinuations: [CharacteristicKey: CheckedContinuation<Data, Error>] = [:]
    private var writeContinuations: [CharacteristicKey: CheckedContinuation<Void, Error>] = [:]
    private var notificationSetups: [CharacteristicKey: NotificationSetup] = [:]
    private var subscriptions: [CharacteristicKey: AsyncThrowingStream<Data, Error>.Continuation] = [:]

    init(queue: DispatchQueue = DispatchQueue(label: "dev.bota.device-sdk.bluetooth")) {
        self.queue = queue
        super.init()
        manager = CBCentralManager(delegate: self, queue: queue)
    }

    func connectedPeripherals(serviceUUIDs: [String]) async -> [CentralAdvertisement] {
        await withCheckedContinuation { continuation in
            queue.async {
                guard self.manager.state == .poweredOn else {
                    continuation.resume(returning: [])
                    return
                }
                let values = self.manager.retrieveConnectedPeripherals(
                    withServices: serviceUUIDs.map(CBUUID.init(string:))
                ).map { peripheral in
                    self.peripherals[peripheral.identifier] = peripheral
                    peripheral.delegate = self
                    return CentralAdvertisement(id: peripheral.identifier.uuidString, name: peripheral.name, rssi: 0)
                }
                continuation.resume(returning: values)
            }
        }
    }

    func startScan(allowDuplicates: Bool) async throws -> AsyncThrowingStream<CentralAdvertisement, Error> {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<AsyncThrowingStream<CentralAdvertisement, Error>, Error>) in
            queue.async {
                guard self.manager.state == .poweredOn else {
                    continuation.resume(throwing: CentralDriverError.bluetoothUnavailable)
                    return
                }
                self.scanContinuation?.finish()
                let pair = AsyncThrowingStream<CentralAdvertisement, Error>.makeStream()
                self.scanContinuation = pair.continuation
                self.manager.scanForPeripherals(
                    withServices: nil,
                    options: [CBCentralManagerScanOptionAllowDuplicatesKey: allowDuplicates]
                )
                continuation.resume(returning: pair.stream)
            }
        }
    }

    func stopScan() async throws {
        await withCheckedContinuation { continuation in
            queue.async {
                self.manager.stopScan()
                self.scanContinuation?.finish()
                self.scanContinuation = nil
                continuation.resume()
            }
        }
    }

    func connect(peripheralID: String) async throws {
        let id = try uuid(peripheralID)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                guard self.manager.state == .poweredOn else {
                    continuation.resume(throwing: CentralDriverError.bluetoothUnavailable)
                    return
                }
                guard let peripheral = self.peripheral(id) else {
                    continuation.resume(throwing: CentralDriverError.peripheralNotFound(peripheralID))
                    return
                }
                if peripheral.state == .connected {
                    continuation.resume()
                    return
                }
                self.connectContinuations[id]?.resume(throwing: CentralDriverError.disconnected(peripheralID))
                self.connectContinuations[id] = continuation
                self.manager.connect(peripheral)
            }
        }
    }

    func discoverServices(peripheralID: String, serviceUUIDs: [String]) async throws -> [String] {
        let id = try uuid(peripheralID)
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                guard let peripheral = self.peripheral(id) else {
                    continuation.resume(throwing: CentralDriverError.peripheralNotFound(peripheralID))
                    return
                }
                peripheral.delegate = self
                self.serviceContinuations[id] = continuation
                peripheral.discoverServices(serviceUUIDs.map(CBUUID.init(string:)))
            }
        }
    }

    func discoverCharacteristics(peripheralID: String, serviceUUIDs: [String]) async throws {
        let id = try uuid(peripheralID)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                guard let peripheral = self.peripheral(id) else {
                    continuation.resume(throwing: CentralDriverError.peripheralNotFound(peripheralID))
                    return
                }
                let requested = Set(serviceUUIDs.map(CBUUID.init(string:)))
                let services = (peripheral.services ?? []).filter { requested.contains($0.uuid) }
                guard !services.isEmpty else {
                    continuation.resume(throwing: CentralDriverError.serviceNotFound(serviceUUIDs.joined(separator: ",")))
                    return
                }
                self.characteristicDiscoveries[id] = CharacteristicDiscovery(
                    remainingServices: Set(services.map(\.uuid)),
                    continuation: continuation
                )
                services.forEach { peripheral.discoverCharacteristics(nil, for: $0) }
            }
        }
    }

    func disconnect(peripheralID: String) async throws {
        let id = try uuid(peripheralID)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                guard let peripheral = self.peripheral(id) else {
                    continuation.resume(throwing: CentralDriverError.peripheralNotFound(peripheralID))
                    return
                }
                guard peripheral.state != .disconnected else {
                    self.failPending(id, error: CentralDriverError.disconnected(peripheralID))
                    continuation.resume()
                    return
                }
                self.disconnectContinuations[id] = continuation
                self.manager.cancelPeripheralConnection(peripheral)
            }
        }
    }

    func read(peripheralID: String, serviceUUID: String, characteristicUUID: String) async throws -> Data {
        let id = try uuid(peripheralID)
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    let (peripheral, characteristic, key) = try self.characteristic(
                        peripheralID: id,
                        characteristicUUID: characteristicUUID
                    )
                    self.readContinuations[key] = continuation
                    peripheral.readValue(for: characteristic)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func write(
        peripheralID: String,
        serviceUUID: String,
        characteristicUUID: String,
        data: Data,
        withResponse: Bool
    ) async throws {
        let id = try uuid(peripheralID)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                do {
                    let (peripheral, characteristic, key) = try self.characteristic(
                        peripheralID: id,
                        characteristicUUID: characteristicUUID
                    )
                    guard withResponse else {
                        peripheral.writeValue(data, for: characteristic, type: .withoutResponse)
                        continuation.resume()
                        return
                    }
                    self.writeContinuations[key] = continuation
                    peripheral.writeValue(data, for: characteristic, type: .withResponse)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func subscribe(
        peripheralID: String,
        serviceUUID: String,
        characteristicUUID: String
    ) async throws -> AsyncThrowingStream<Data, Error> {
        let id = try uuid(peripheralID)
        let pair = AsyncThrowingStream<Data, Error>.makeStream()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                do {
                    let (peripheral, characteristic, key) = try self.characteristic(
                        peripheralID: id,
                        characteristicUUID: characteristicUUID
                    )
                    self.subscriptions[key]?.finish()
                    self.subscriptions[key] = pair.continuation
                    self.notificationSetups[key] = NotificationSetup(enabling: true, continuation: continuation)
                    peripheral.setNotifyValue(true, for: characteristic)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
        return pair.stream
    }

    func unsubscribe(peripheralID: String, serviceUUID: String, characteristicUUID: String) async throws {
        let id = try uuid(peripheralID)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                do {
                    let (peripheral, characteristic, key) = try self.characteristic(
                        peripheralID: id,
                        characteristicUUID: characteristicUUID
                    )
                    self.notificationSetups[key] = NotificationSetup(enabling: false, continuation: continuation)
                    peripheral.setNotifyValue(false, for: characteristic)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func uuid(_ value: String) throws -> UUID {
        guard let id = UUID(uuidString: value) else { throw CentralDriverError.peripheralNotFound(value) }
        return id
    }

    private func peripheral(_ id: UUID) -> CBPeripheral? {
        if let known = peripherals[id] { return known }
        let retrieved = manager.retrievePeripherals(withIdentifiers: [id]).first
        if let retrieved {
            peripherals[id] = retrieved
            retrieved.delegate = self
        }
        return retrieved
    }

    private func characteristic(
        peripheralID: UUID,
        characteristicUUID: String
    ) throws -> (CBPeripheral, CBCharacteristic, CharacteristicKey) {
        guard let peripheral = peripheral(peripheralID) else {
            throw CentralDriverError.peripheralNotFound(peripheralID.uuidString)
        }
        let key = CharacteristicKey(
            peripheralID: peripheralID,
            characteristicUUID: CBUUID(string: characteristicUUID)
        )
        guard let characteristic = characteristics[key] else {
            throw CentralDriverError.characteristicNotFound(characteristicUUID)
        }
        return (peripheral, characteristic, key)
    }

    private func failPending(_ id: UUID, error: Error) {
        connectContinuations.removeValue(forKey: id)?.resume(throwing: error)
        serviceContinuations.removeValue(forKey: id)?.resume(throwing: error)
        characteristicDiscoveries.removeValue(forKey: id)?.continuation.resume(throwing: error)
        for key in readContinuations.keys.filter({ $0.peripheralID == id }) {
            readContinuations.removeValue(forKey: key)?.resume(throwing: error)
        }
        for key in writeContinuations.keys.filter({ $0.peripheralID == id }) {
            writeContinuations.removeValue(forKey: key)?.resume(throwing: error)
        }
        for key in notificationSetups.keys.filter({ $0.peripheralID == id }) {
            notificationSetups.removeValue(forKey: key)?.continuation.resume(throwing: error)
        }
        for key in subscriptions.keys.filter({ $0.peripheralID == id }) {
            subscriptions.removeValue(forKey: key)?.finish(throwing: error)
        }
    }
}

extension CoreBluetoothDriver: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state != .poweredOn else { return }
        scanContinuation?.finish(throwing: CentralDriverError.bluetoothUnavailable)
        scanContinuation = nil
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        peripherals[peripheral.identifier] = peripheral
        peripheral.delegate = self
        let serviceUUIDs = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? [])
            .map(\.uuidString)
        let rawRSSI = RSSI.intValue
        scanContinuation?.yield(CentralAdvertisement(
            id: peripheral.identifier.uuidString,
            name: advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name,
            rssi: Int16(clamping: rawRSSI),
            manufacturerData: advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data,
            serviceUUIDs: serviceUUIDs
        ))
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.delegate = self
        connectContinuations.removeValue(forKey: peripheral.identifier)?.resume()
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        let failure = error ?? CentralDriverError.disconnected(peripheral.identifier.uuidString)
        connectContinuations.removeValue(forKey: peripheral.identifier)?.resume(throwing: failure)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        let id = peripheral.identifier
        disconnectContinuations.removeValue(forKey: id)?.resume()
        failPending(id, error: error ?? CentralDriverError.disconnected(id.uuidString))
    }
}

extension CoreBluetoothDriver: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let continuation = serviceContinuations.removeValue(forKey: peripheral.identifier) else { return }
        if let error {
            continuation.resume(throwing: error)
        } else {
            continuation.resume(returning: (peripheral.services ?? []).map { $0.uuid.uuidString })
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        let id = peripheral.identifier
        guard var discovery = characteristicDiscoveries[id] else { return }
        if let error {
            characteristicDiscoveries[id] = nil
            discovery.continuation.resume(throwing: error)
            return
        }
        for characteristic in service.characteristics ?? [] {
            characteristics[CharacteristicKey(peripheralID: id, characteristicUUID: characteristic.uuid)] = characteristic
        }
        discovery.remainingServices.remove(service.uuid)
        if discovery.remainingServices.isEmpty {
            characteristicDiscoveries[id] = nil
            discovery.continuation.resume()
        } else {
            characteristicDiscoveries[id] = discovery
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        let key = CharacteristicKey(peripheralID: peripheral.identifier, characteristicUUID: characteristic.uuid)
        if let continuation = readContinuations.removeValue(forKey: key) {
            if let error {
                continuation.resume(throwing: error)
            } else {
                continuation.resume(returning: characteristic.value ?? Data())
            }
            return
        }
        if let error {
            subscriptions.removeValue(forKey: key)?.finish(throwing: error)
        } else if let value = characteristic.value {
            subscriptions[key]?.yield(value)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        let key = CharacteristicKey(peripheralID: peripheral.identifier, characteristicUUID: characteristic.uuid)
        guard let continuation = writeContinuations.removeValue(forKey: key) else { return }
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        let key = CharacteristicKey(peripheralID: peripheral.identifier, characteristicUUID: characteristic.uuid)
        guard let setup = notificationSetups.removeValue(forKey: key) else { return }
        if let error {
            subscriptions.removeValue(forKey: key)?.finish(throwing: error)
            setup.continuation.resume(throwing: error)
            return
        }
        if !setup.enabling { subscriptions.removeValue(forKey: key)?.finish() }
        setup.continuation.resume()
    }
}
