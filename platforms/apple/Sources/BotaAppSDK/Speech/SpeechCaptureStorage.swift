import CryptoKit
import Darwin
import Foundation
import Security
import SQLite3

protocol SpeechCaptureKeys: Sendable {
    func read(_ id: String) throws -> Data?
    func write(_ id: String, value: Data) throws
    func delete(_ id: String) throws
}
struct SpeechCaptureKeychain: SpeechCaptureKeys {
    private func query(_ id: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "dev.bota.speech.capture.v1", kSecAttrAccount as String: id]
    }
    func read(_ id: String) throws -> Data? {
        var query = query(id); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let bytes = result as? Data else { throw SpeechCaptureFailure.unavailable }
        return bytes
    }
    func write(_ id: String, value: Data) throws {
        // Never replace a surviving capture key after an interrupted create.
        if let old = try read(id) { guard old == value else { throw SpeechCaptureFailure.invalidInput }; return }
        var item = query(id); item[kSecValueData as String] = value
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw SpeechCaptureFailure.unavailable }
    }
    func delete(_ id: String) throws {
        let status = SecItemDelete(query(id) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw SpeechCaptureFailure.unavailable }
    }
}

/// One actor exclusively owns this connection and its process-wide file lock.
/// PCM and keys never enter SQLite; one FULL transaction commits the encrypted
/// journal and ciphertext chunk. A receipt tombstone survives audio deletion.
final class SpeechCaptureStorage: @unchecked Sendable {
    private static func scopeHash(_ scope: String) throws -> String {
        guard !scope.isEmpty, scope.utf8.count <= 512 else { throw SpeechCaptureFailure.invalidInput }
        return SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func list(scope: String, directory: URL) throws -> [String] {
        let root = directory.appendingPathComponent("speech-capture-v1").appendingPathComponent(try scopeHash(scope))
        guard FileManager.default.fileExists(atPath: root.path) else { return [] }
        let files = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        let names = try files.filter { file in
            guard file.pathExtension == "sqlite" else { return false }
            let attributes = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            return attributes.isRegularFile == true && attributes.isSymbolicLink == false
        }.map { $0.deletingPathExtension().lastPathComponent }.sorted()
        guard names.count <= 256, names.allSatisfy({ UUID(uuidString: $0)?.uuidString.lowercased() == $0 }) else { throw SpeechCaptureFailure.invalidInput }
        return names
    }
    enum Value { case text(String), bytes(Data), integer(Int64) }
    let keyId: String
    private var db: OpaquePointer?
    private var lockFile: Int32 = -1
    private var revision: Int64 = 0
    init(scope: String, captureId: String, directory: URL) throws {
        let scopeId = try Self.scopeHash(scope)
        keyId = scopeId + ":" + captureId
        var root = directory.appendingPathComponent("speech-capture-v1", isDirectory: true).appendingPathComponent(scopeId, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var attributes = URLResourceValues(); attributes.isExcludedFromBackup = true; try root.setResourceValues(attributes)
        let path = root.appendingPathComponent(captureId + ".sqlite").path
        lockFile = Darwin.open(path + ".lock", O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard lockFile >= 0 else { throw SpeechCaptureFailure.unavailable }
        guard flock(lockFile, LOCK_EX | LOCK_NB) == 0 else { Darwin.close(lockFile); lockFile = -1; throw SpeechCaptureFailure.busy }
        do {
            if let type = try? FileManager.default.attributesOfItem(atPath: path)[.type], type as? FileAttributeType == .typeSymbolicLink {
                throw SpeechCaptureFailure.invalidInput
            }
            guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
                throw SpeechCaptureFailure.unavailable
            }
            try execute("PRAGMA journal_mode=WAL"); try execute("PRAGMA synchronous=FULL"); try execute("PRAGMA busy_timeout=1000")
            try execute("CREATE TABLE IF NOT EXISTS capture(id INTEGER PRIMARY KEY CHECK(id=1),journal BLOB,receipt BLOB,revision INTEGER NOT NULL)")
            try execute("CREATE TABLE IF NOT EXISTS chunks(sequence INTEGER PRIMARY KEY,packet BLOB NOT NULL,sha256 TEXT NOT NULL,uploaded INTEGER NOT NULL DEFAULT 0)")
            revision = try integer("SELECT revision FROM capture WHERE id=1") ?? 0
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: root.path)
            #endif
        } catch { close(); throw error }
    }
    private func statement<T>(_ sql: String, _ values: [Value] = [], _ body: (OpaquePointer) throws -> T) throws -> T {
        guard let db else { throw SpeechCaptureFailure.closed }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw SpeechCaptureFailure.unavailable }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1), status: Int32
            switch value {
            case let .text(text): status = text.withCString { sqlite3_bind_text(statement, index, $0, -1, transient) }
            case let .bytes(bytes): status = bytes.withUnsafeBytes { sqlite3_bind_blob(statement, index, $0.baseAddress, Int32($0.count), transient) }
            case let .integer(number): status = sqlite3_bind_int64(statement, index, number)
            }
            guard status == SQLITE_OK else { throw SpeechCaptureFailure.unavailable }
        }
        return try body(statement)
    }
    private func execute(_ sql: String, _ values: [Value] = []) throws {
        try statement(sql, values) { statement in
            var status = sqlite3_step(statement)
            while status == SQLITE_ROW { status = sqlite3_step(statement) }
            guard status == SQLITE_DONE else { throw SpeechCaptureFailure.unavailable }
        }
    }
    private func integer(_ sql: String, _ values: [Value] = []) throws -> Int64? {
        try statement(sql, values) { statement in
            let status = sqlite3_step(statement)
            if status == SQLITE_DONE { return nil }
            guard status == SQLITE_ROW else { throw SpeechCaptureFailure.unavailable }
            return sqlite3_column_int64(statement, 0)
        }
    }
    private func bytes(_ sql: String, _ values: [Value] = [], maximum: Int = 140000) throws -> Data? {
        try statement(sql, values) { statement in
            let status = sqlite3_step(statement)
            if status == SQLITE_DONE { return nil }
            guard status == SQLITE_ROW else { throw SpeechCaptureFailure.unavailable }
            if sqlite3_column_type(statement, 0) == SQLITE_NULL { return nil }
            let count = Int(sqlite3_column_bytes(statement, 0))
            guard count > 0, count <= maximum, let pointer = sqlite3_column_blob(statement, 0) else { throw SpeechCaptureFailure.invalidInput }
            return Data(bytes: pointer, count: count)
        }
    }
    func journal() throws -> Data? { try bytes("SELECT journal FROM capture WHERE id=1", maximum: 100000) }
    func receipt() throws -> Data? { try bytes("SELECT receipt FROM capture WHERE id=1", maximum: 524288) }
    func packet(_ sequence: Int) throws -> Data? { try bytes("SELECT packet FROM chunks WHERE sequence=?", [.integer(Int64(sequence))]) }
    func uploaded(_ sequence: Int) throws -> Bool { try integer("SELECT uploaded FROM chunks WHERE sequence=?", [.integer(Int64(sequence))]) == 1 }
    func acknowledge(_ sequence: Int, sha256: String) throws {
        try execute("UPDATE chunks SET uploaded=1 WHERE sequence=? AND sha256=?", [.integer(Int64(sequence)), .text(sha256)])
        guard sqlite3_changes(db) == 1 else { throw SpeechCaptureFailure.invalidInput }
    }
    func save(_ journal: Data, chunk: (sequence: Int, packet: Data, sha256: String)? = nil) throws {
        try execute("BEGIN IMMEDIATE")
        do {
            let old = try integer("SELECT revision FROM capture WHERE id=1")
            guard old == nil && revision == 0 || old == revision else { throw SpeechCaptureFailure.busy }
            if let chunk {
                try execute("INSERT INTO chunks(sequence,packet,sha256) VALUES(?,?,?)", [.integer(Int64(chunk.sequence)), .bytes(chunk.packet), .text(chunk.sha256)])
            }
            try execute("INSERT INTO capture(id,journal,revision) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET journal=excluded.journal,revision=excluded.revision",
                        [.bytes(journal), .integer(revision + 1)])
            try execute("COMMIT"); revision += 1
        } catch { try? execute("ROLLBACK"); throw error }
    }
    func publish(_ receipt: Data) throws {
        try execute("BEGIN IMMEDIATE")
        do {
            try execute("UPDATE capture SET journal=NULL,receipt=?,revision=revision+1 WHERE id=1", [.bytes(receipt)])
            guard sqlite3_changes(db) == 1 else { throw SpeechCaptureFailure.invalidInput }
            try execute("DELETE FROM chunks"); try execute("COMMIT"); revision += 1
        } catch { try? execute("ROLLBACK"); throw error }
    }
    func close() {
        if let db { sqlite3_close_v2(db); self.db = nil }
        if lockFile >= 0 { _ = flock(lockFile, LOCK_UN); Darwin.close(lockFile); lockFile = -1 }
    }
    deinit { close() }
}
