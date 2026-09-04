import Foundation

struct CentralAdvertisement: Equatable, Sendable {
    let id: String
    let name: String?
    let advertisedAddress: String?
    let rssi: Int16
    let manufacturerData: Data?
    let serviceUUIDs: [String]

    init(
        id: String,
        name: String? = nil,
        advertisedAddress: String? = nil,
        rssi: Int16,
        manufacturerData: Data? = nil,
        serviceUUIDs: [String] = []
    ) {
        self.id = id
        self.name = name
        self.advertisedAddress = advertisedAddress
        self.rssi = rssi
        self.manufacturerData = manufacturerData
        self.serviceUUIDs = serviceUUIDs
    }
}

protocol CentralDriver: Sendable {
    func connectedPeripherals(serviceUUIDs: [String]) async -> [CentralAdvertisement]
    func startScan(allowDuplicates: Bool) async throws -> AsyncThrowingStream<CentralAdvertisement, Error>
    func stopScan() async throws
    func connect(peripheralID: String) async throws
    func discoverServices(peripheralID: String, serviceUUIDs: [String]) async throws -> [String]
    func discoverCharacteristics(peripheralID: String, serviceUUIDs: [String]) async throws
    func disconnect(peripheralID: String) async throws
    func read(peripheralID: String, serviceUUID: String, characteristicUUID: String) async throws -> Data
    func maximumWriteValueLength(peripheralID: String, withResponse: Bool) async throws -> Int
    func write(
        peripheralID: String,
        serviceUUID: String,
        characteristicUUID: String,
        data: Data,
        withResponse: Bool
    ) async throws
    func subscribe(
        peripheralID: String,
        serviceUUID: String,
        characteristicUUID: String
    ) async throws -> AsyncThrowingStream<Data, Error>
    func unsubscribe(peripheralID: String, serviceUUID: String, characteristicUUID: String) async throws
}

enum CentralDriverError: Error, Equatable, Sendable {
    case bluetoothUnavailable
    case peripheralNotFound(String)
    case serviceNotFound(String)
    case characteristicNotFound(String)
    case disconnected(String)
    case serviceDiscoveryTimedOut(String)
}
