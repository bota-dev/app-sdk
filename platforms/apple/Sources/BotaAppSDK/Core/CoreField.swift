import Foundation

enum CoreField: Equatable, Sendable {
    case unsigned(id: UInt32, value: UInt64)
    case signed(id: UInt32, value: Int64)
    case bool(id: UInt32, value: Bool)
    case text(id: UInt32, value: String)
    case bytes(id: UInt32, value: Data)
}
