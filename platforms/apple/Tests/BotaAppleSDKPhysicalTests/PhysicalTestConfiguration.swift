import BotaAppleSDK
import Foundation
import XCTest

enum PhysicalDeviceModel: String, Sendable {
    case botaPin = "bota_pin"
    case botaPin4G = "bota_pin_4g"
    case botaNote = "bota_note"

    var deviceType: DeviceType {
        switch self {
        case .botaPin: .botaPin
        case .botaPin4G: .botaPin4G
        case .botaNote: .botaNote
        }
    }
}

struct PhysicalTestConfiguration: Sendable {
    let serialNumber: String
    let model: PhysicalDeviceModel
    let scanTimeoutMilliseconds: UInt64
    let operationTimeoutSeconds: UInt64
    let environment: [String: String]

    static func load() throws -> Self {
        let environment = ProcessInfo.processInfo.environment
        guard environment["BOTA_PHYSICAL_TESTS"] == "1" else {
            throw XCTSkip("Set BOTA_PHYSICAL_TESTS=1 to run supervised physical-device tests")
        }
        let serialNumber = try required("BOTA_DEVICE_SERIAL", in: environment)
        guard serialNumber.range(of: "^[A-Za-z0-9]+$", options: .regularExpression) != nil else {
            throw ConfigurationError.invalid("BOTA_DEVICE_SERIAL")
        }
        let rawModel = try required("BOTA_DEVICE_MODEL", in: environment)
        guard let model = PhysicalDeviceModel(rawValue: rawModel) else {
            throw ConfigurationError.invalid("BOTA_DEVICE_MODEL")
        }
        return Self(
            serialNumber: serialNumber,
            model: model,
            scanTimeoutMilliseconds: try unsigned(
                "BOTA_SCAN_TIMEOUT_MS",
                default: 10_000,
                in: environment
            ),
            operationTimeoutSeconds: try unsigned(
                "BOTA_OPERATION_TIMEOUT_SECONDS",
                default: 600,
                in: environment
            ),
            environment: environment
        )
    }

    var applicationSupportDirectory: URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("BotaAppleSDKPhysicalTests", isDirectory: true)
            .appendingPathComponent(serialNumber, isDirectory: true)
    }

    func requireGate(_ name: String) throws {
        guard environment[name] == "1" else { throw XCTSkip("Set \(name)=1 for this supervised test") }
    }

    func value(_ name: String) throws -> String {
        try Self.required(name, in: environment)
    }

    func uint64(_ name: String) throws -> UInt64 {
        guard let value = UInt64(try value(name)) else { throw ConfigurationError.invalid(name) }
        return value
    }

    func uint32(_ name: String) throws -> UInt32 {
        let value = try value(name)
        let parsed: UInt32?
        if value.lowercased().hasPrefix("0x") {
            parsed = UInt32(value.dropFirst(2), radix: 16)
        } else {
            parsed = UInt32(value)
        }
        guard let parsed else { throw ConfigurationError.invalid(name) }
        return parsed
    }

    func data(_ name: String) throws -> Data {
        guard let value = Data(base64Encoded: try value(name)) else {
            throw ConfigurationError.invalid(name)
        }
        return value
    }

    func provisioningMaterial() throws -> ProvisioningMaterial {
        ProvisioningMaterial(
            apiEndpoint: Data(try value("BOTA_PROVISIONING_ENDPOINT").utf8),
            deviceToken: try data("BOTA_PROVISIONING_TOKEN_BASE64"),
            mtu: try Self.unsigned("BOTA_PROVISIONING_MTU", default: 180, in: environment)
        )
    }

    func firmwareImage() throws -> FirmwareImage {
        guard let url = URL(string: try value("BOTA_FIRMWARE_URL")) else {
            throw ConfigurationError.invalid("BOTA_FIRMWARE_URL")
        }
        return FirmwareImage(
            version: try value("BOTA_FIRMWARE_VERSION"),
            sizeBytes: try uint32("BOTA_FIRMWARE_SIZE_BYTES"),
            crc32: try uint32("BOTA_FIRMWARE_CRC32"),
            downloadID: try uint64("BOTA_FIRMWARE_DOWNLOAD_ID"),
            request: URLRequest(url: url)
        )
    }

    func expectedResetNonce() throws -> Data {
        let value = try self.value("BOTA_FACTORY_RESET_NONCE_HEX")
        guard value.count.isMultiple(of: 2) else {
            throw ConfigurationError.invalid("BOTA_FACTORY_RESET_NONCE_HEX")
        }
        var data = Data()
        var index = value.startIndex
        while index < value.endIndex {
            let end = value.index(index, offsetBy: 2)
            guard let byte = UInt8(value[index..<end], radix: 16) else {
                throw ConfigurationError.invalid("BOTA_FACTORY_RESET_NONCE_HEX")
            }
            data.append(byte)
            index = end
        }
        return data
    }

    private static func required(_ name: String, in environment: [String: String]) throws -> String {
        guard let value = environment[name], !value.isEmpty else {
            throw XCTSkip("Set \(name) for this supervised test")
        }
        return value
    }

    private static func unsigned(
        _ name: String,
        default defaultValue: UInt64,
        in environment: [String: String]
    ) throws -> UInt64 {
        guard let raw = environment[name] else { return defaultValue }
        guard let value = UInt64(raw), value > 0 else { throw ConfigurationError.invalid(name) }
        return value
    }
}

enum ConfigurationError: Error, CustomStringConvertible {
    case invalid(String)

    var description: String {
        switch self {
        case let .invalid(name): "Invalid physical-test value for \(name)"
        }
    }
}
