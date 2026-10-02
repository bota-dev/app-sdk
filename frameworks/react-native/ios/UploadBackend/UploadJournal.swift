import Darwin
import Foundation

final class UploadJournal {
  private struct Record: Codable {
    let version: Int
    let identity: String
    let phase: String
    let entry: UploadJournalEntry?
    let importedPriorSHA256: String?
    let authorizationNonceSHA256: String?
    let recoveryNonceBase64: String?
  }
  private let root: URL
  private let synchronize: (Int32) -> Int32

  init(root: URL, synchronize: @escaping (Int32) -> Int32 = { fsync($0) }) {
    self.root = root
    self.synchronize = synchronize
  }

  private func rootFD() throws -> Int32 {
    let manager = FileManager.default
    do {
      try manager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      let fd = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
      guard fd >= 0 else { throw UploadFailure.journal }
      do {
        guard fchmod(fd, 0o700) == 0 else { throw UploadFailure.journal }
        var url = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
        guard synchronize(fd) == 0 else { throw UploadFailure.journal }
        let parent = open(root.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard parent >= 0 else { throw UploadFailure.journal }
        defer { close(parent) }
        guard synchronize(parent) == 0 else { throw UploadFailure.journal }
        return fd
      } catch { close(fd); throw error }
    } catch { throw UploadFailure.journal }
  }

  private func name(_ input: UploadInput) throws -> String {
    guard UploadValidation.hex(input.journalKey, bytes: 32) else { throw UploadFailure.invalidInput }
    return input.journalKey + ".json"
  }

  func load(_ input: UploadInput) throws -> UploadJournalEntry? {
    guard let record = try read(input) else { return nil }
    guard record.phase == "ready" else { throw UploadFailure.pending }
    guard let entry = record.entry else { throw UploadFailure.journal }
    if let prior = input.priorJournalEntry {
      let priorIdentity = try prior.identity()
      guard prior.agrees(with: entry) || record.importedPriorSHA256 == priorIdentity else {
        throw UploadFailure.identityConflict
      }
    }
    return entry
  }

  func authorizationNonceSHA256(_ input: UploadInput) throws -> String? {
    try read(input)?.authorizationNonceSHA256
  }

  func recoveryNonceBase64(_ input: UploadInput) throws -> String? {
    try read(input)?.recoveryNonceBase64
  }

  private func read(_ input: UploadInput) throws -> Record? {
    let name = try name(input)
    let directory = try rootFD()
    defer { close(directory) }
    let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    if fd < 0 {
      if errno == ENOENT { return nil }
      throw UploadFailure.journal
    }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size <= 16_384 else {
      throw UploadFailure.journal
    }
    do {
      let data = try FileHandle(fileDescriptor: fd, closeOnDealloc: false).readToEnd() ?? Data()
      let record = try JSONDecoder().decode(Record.self, from: data)
      guard (1...2).contains(record.version),
            record.identity == (try input.identity(includeTransport: record.version == 1)) else {
        throw UploadFailure.identityConflict
      }
      guard ["ready", "recording_create_unknown", "session_create_unknown"].contains(record.phase),
            record.importedPriorSHA256 == nil || UploadValidation.hex(record.importedPriorSHA256!, bytes: 32) else {
        throw UploadFailure.journal
      }
      try record.entry?.validate()
      guard record.authorizationNonceSHA256 == nil ||
        (record.entry?.sessionId != nil && UploadValidation.hex(record.authorizationNonceSHA256!, bytes: 32)) else {
        throw UploadFailure.journal
      }
      if let nonce = record.recoveryNonceBase64 {
        guard record.phase == "ready", record.entry?.sessionId != nil else { throw UploadFailure.journal }
        _ = try UploadValidation.document(nonce, size: 16)
      }
      if record.version == 1 {
        let migrated = Record(version: 2, identity: try input.identity(), phase: record.phase,
          entry: record.entry, importedPriorSHA256: record.importedPriorSHA256,
          authorizationNonceSHA256: record.authorizationNonceSHA256, recoveryNonceBase64: record.recoveryNonceBase64)
        try persist(input, record: migrated)
        return migrated
      }
      return record
    } catch { throw (error as? UploadFailure) ?? .journal }
  }

  func save(_ input: UploadInput, entry: UploadJournalEntry, authorizationNonceSHA256: String? = nil,
            recoveryNonceBase64: String? = nil) throws {
    try entry.validate()
    try write(input, entry: entry, phase: "ready", authorizationNonceSHA256: authorizationNonceSHA256,
      recoveryNonceBase64: recoveryNonceBase64)
  }

  func markUnknown(_ input: UploadInput, entry: UploadJournalEntry?) throws {
    try entry?.validate()
    try write(input, entry: entry, phase: entry == nil ? "recording_create_unknown" : "session_create_unknown")
  }

  func rollbackRejectedCreate(_ input: UploadInput, entry: UploadJournalEntry?) throws {
    let phase = entry == nil ? "recording_create_unknown" : "session_create_unknown"
    guard let record = try read(input), record.phase == phase, record.entry == entry else {
      throw UploadFailure.identityConflict
    }
    if let entry {
      try save(input, entry: entry)
    } else {
      let directory = try rootFD()
      defer { close(directory) }
      guard unlinkat(directory, try name(input), 0) == 0, synchronize(directory) == 0 else { throw UploadFailure.journal }
    }
  }

  private func write(_ input: UploadInput, entry: UploadJournalEntry?, phase: String,
                     authorizationNonceSHA256: String? = nil, recoveryNonceBase64: String? = nil) throws {
    let previous = try read(input)
    let imported = try previous?.importedPriorSHA256 ?? input.priorJournalEntry?.identity()
    try persist(input, record: Record(version: 2, identity: try input.identity(), phase: phase,
      entry: entry, importedPriorSHA256: imported,
      authorizationNonceSHA256: authorizationNonceSHA256 ??
        (previous?.entry?.sessionId == entry?.sessionId ? previous?.authorizationNonceSHA256 : nil),
      recoveryNonceBase64: recoveryNonceBase64))
  }

  private func persist(_ input: UploadInput, record: Record) throws {
    let name = try name(input)
    let directory = try rootFD()
    defer { close(directory) }
    let temporary = UUID().uuidString.lowercased() + ".tmp"
    var fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw UploadFailure.journal }
    defer {
      if fd >= 0 { close(fd) }
      unlinkat(directory, temporary, 0)
    }
    do {
      let data = try JSONEncoder().encode(record)
      try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: data)
      var url = root.appendingPathComponent(temporary)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)
      #if os(iOS)
      try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
      #endif
      guard synchronize(fd) == 0 else { throw UploadFailure.journal }
      let result = close(fd)
      fd = -1
      guard result == 0, renameat(directory, temporary, directory, name) == 0,
            synchronize(directory) == 0 else { throw UploadFailure.journal }
    } catch { throw UploadFailure.journal }
  }

  func remove(_ input: UploadInput, expected: UploadJournalEntry) throws {
    guard try load(input) == expected else { throw UploadFailure.identityConflict }
    let directory = try rootFD()
    defer { close(directory) }
    guard unlinkat(directory, try name(input), 0) == 0, synchronize(directory) == 0 else { throw UploadFailure.journal }
  }
}
