import Darwin
import Foundation

/// App-private opaque documents/checkpoints; no URL or manifest enters JS/Dart.
final class ByoDurableStore: @unchecked Sendable {
    let root: URL
    private var lease: Int32 = -1
    private let synchronize: (Int32) -> Int32
    init(root: URL, synchronize: @escaping (Int32) -> Int32 = { fsync($0) }) throws {
        self.root = root; self.synchronize = synchronize
        var created: [URL] = []; var ancestor = root
        while !FileManager.default.fileExists(atPath: ancestor.path) {
            created.append(ancestor); let parent = ancestor.deletingLastPathComponent()
            guard parent != ancestor else { throw ByoFailure.persistence }; ancestor = parent
        }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        var url = root; var values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
        let fd = try directory(); defer { close(fd) }
        let parent = open(root.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard parent >= 0 else { throw ByoFailure.persistence }; defer { close(parent) }
        guard fchmod(fd, 0o700) == 0, synchronize(fd) == 0, synchronize(parent) == 0 else { throw ByoFailure.persistence }
        // Persist every newly created ancestor entry, not only the leaf.
        for directory in created.reversed() {
            let parent = open(directory.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            guard parent >= 0 else { throw ByoFailure.persistence }
            let result = synchronize(parent); close(parent)
            guard result == 0 else { throw ByoFailure.persistence }
        }
        let ownership = openat(fd, "lease", O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard ownership >= 0 else { throw ByoFailure.persistence }
        guard flock(ownership, LOCK_EX | LOCK_NB) == 0 else { close(ownership); throw ByoFailure.persistence }
        lease = ownership
    }
    deinit { if lease >= 0 { _ = flock(lease, LOCK_UN); close(lease) } }
    private func directory() throws -> Int32 {
        let fd = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw ByoFailure.persistence }; return fd
    }
    private func valid(_ name: String) throws {
        guard ["state", "documents", "ciphertext"].contains(name) else { throw ByoFailure.persistence }
    }
    func load(_ name: String) throws -> Data? {
        try valid(name); let dir = try directory(); defer { close(dir) }
        let fd = openat(dir, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        if fd < 0 { if errno == ENOENT { return nil }; throw ByoFailure.persistence }
        defer { close(fd) }; var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size <= 32768 else { throw ByoFailure.persistence }
        return try FileHandle(fileDescriptor: fd, closeOnDealloc: false).readToEnd() ?? Data()
    }
    func save(_ name: String, _ bytes: Data) throws {
        try valid(name); guard bytes.count <= 32768 else { throw ByoFailure.persistence }
        let dir = try directory(); defer { close(dir) }
        let temporary = UUID().uuidString + ".tmp"
        let fd = openat(dir, temporary, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw ByoFailure.persistence }
        defer { close(fd); unlinkat(dir, temporary, 0) }
        try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: bytes)
        guard synchronize(fd) == 0, renameat(dir, temporary, dir, name) == 0, synchronize(dir) == 0,
              try load(name) == bytes else { throw ByoFailure.persistence }
    }
    func createCiphertext() throws -> FileHandle {
        let dir = try directory(); defer { close(dir) }
        // A partial local copy is never recovery authority; the device retains
        // its complete source until signed receipt/CONFIRM.
        let fd = openat(dir, "ciphertext", O_CREAT | O_WRONLY | O_TRUNC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw ByoFailure.persistence }
        return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }
    func removeCiphertext() throws {
        let dir = try directory(); defer { close(dir) }
        guard unlinkat(dir, "ciphertext", 0) == 0 || errno == ENOENT else { throw ByoFailure.persistence }
        guard synchronize(dir) == 0 else { throw ByoFailure.persistence }
    }
}
