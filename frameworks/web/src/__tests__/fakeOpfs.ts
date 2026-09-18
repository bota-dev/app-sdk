type FakeEntry = FakeDirectory | FakeFile

export class FakeOpfs {
  readonly root: FileSystemDirectoryHandle

  private readonly rootDirectory: FakeDirectory
  private quotaFailurePending = false

  constructor() {
    this.rootDirectory = new FakeDirectory('', null, this)
    this.root = this.rootDirectory as unknown as FileSystemDirectoryHandle
  }

  failNextWriteWithQuota(): void {
    this.quotaFailurePending = true
  }

  consumeQuotaFailure(): void {
    if (!this.quotaFailurePending) return
    this.quotaFailurePending = false
    throw new DOMException('private quota detail', 'QuotaExceededError')
  }

  paths(): string[] {
    return this.rootDirectory.paths('')
  }
}

class FakeDirectory {
  readonly kind = 'directory' as const
  readonly name: string
  readonly entries = new Map<string, FakeEntry>()
  private readonly parent: FakeDirectory | null
  private readonly owner: FakeOpfs

  constructor(
    name: string,
    parent: FakeDirectory | null,
    owner: FakeOpfs,
  ) {
    this.name = name
    this.parent = parent
    this.owner = owner
  }

  async getDirectoryHandle(
    name: string,
    options: FileSystemGetDirectoryOptions = {},
  ): Promise<FileSystemDirectoryHandle> {
    const existing = this.entries.get(name)
    if (existing instanceof FakeDirectory) {
      return existing as unknown as FileSystemDirectoryHandle
    }
    if (existing || !options.create) throw notFound()

    const directory = new FakeDirectory(name, this, this.owner)
    this.entries.set(name, directory)
    return directory as unknown as FileSystemDirectoryHandle
  }

  async getFileHandle(
    name: string,
    options: FileSystemGetFileOptions = {},
  ): Promise<FileSystemFileHandle> {
    const existing = this.entries.get(name)
    if (existing instanceof FakeFile) {
      return existing as unknown as FileSystemFileHandle
    }
    if (existing || !options.create) throw notFound()

    const file = new FakeFile(name, this.owner)
    this.entries.set(name, file)
    return file as unknown as FileSystemFileHandle
  }

  async removeEntry(
    name: string,
    options: FileSystemRemoveOptions = {},
  ): Promise<void> {
    const existing = this.entries.get(name)
    if (!existing) throw notFound()
    if (
      existing instanceof FakeDirectory
      && existing.entries.size > 0
      && !options.recursive
    ) {
      throw new DOMException('Directory is not empty.', 'InvalidModificationError')
    }
    this.entries.delete(name)
  }

  async resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null> {
    const target = possibleDescendant as unknown as FakeEntry
    const path = target.pathFrom(this)
    return path
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return this === (other as unknown)
  }

  pathFrom(ancestor: FakeDirectory): string[] | null {
    const path: string[] = []
    let current: FakeDirectory | null = this
    while (current && current !== ancestor) {
      path.unshift(current.name)
      current = current.parent
    }
    return current === ancestor ? path : null
  }

  paths(prefix: string): string[] {
    const result: string[] = []
    for (const [name, entry] of this.entries) {
      const path = prefix ? `${prefix}/${name}` : name
      result.push(path)
      if (entry instanceof FakeDirectory) result.push(...entry.paths(path))
    }
    return result.sort()
  }
}

class FakeFile {
  readonly kind = 'file' as const
  readonly name: string
  bytes = new Uint8Array()
  private readonly owner: FakeOpfs

  constructor(
    name: string,
    owner: FakeOpfs,
  ) {
    this.name = name
    this.owner = owner
  }

  async getFile(): Promise<File> {
    const copy = new Uint8Array(this.bytes)
    return new File([copy.buffer], this.name)
  }

  async createWritable(
    options: FileSystemCreateWritableOptions = {},
  ): Promise<FileSystemWritableFileStream> {
    const initial = options.keepExistingData
      ? new Uint8Array(this.bytes)
      : new Uint8Array()
    return new FakeWritable(
      this,
      this.owner,
      initial,
    ) as unknown as FileSystemWritableFileStream
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return this === (other as unknown)
  }

  pathFrom(ancestor: FakeDirectory): string[] | null {
    for (const [name, entry] of ancestor.entries) {
      if (entry === this) return [name]
      if (entry instanceof FakeDirectory) {
        const nested = this.pathFrom(entry)
        if (nested) return [name, ...nested]
      }
    }
    return null
  }
}

class FakeWritable {
  private position = 0
  private closed = false
  private readonly file: FakeFile
  private readonly owner: FakeOpfs
  private working: Uint8Array

  constructor(
    file: FakeFile,
    owner: FakeOpfs,
    working: Uint8Array,
  ) {
    this.file = file
    this.owner = owner
    this.working = working
  }

  async seek(position: number): Promise<void> {
    this.ensureOpen()
    this.position = position
  }

  async truncate(size: number): Promise<void> {
    this.ensureOpen()
    const resized = new Uint8Array(size)
    resized.set(this.working.subarray(0, size))
    this.working = resized
    if (this.position > size) this.position = size
  }

  async write(data: FileSystemWriteChunkType): Promise<void> {
    this.ensureOpen()
    this.owner.consumeQuotaFailure()
    if (!(data instanceof Uint8Array)) {
      throw new TypeError('Fake OPFS accepts Uint8Array writes only.')
    }

    const end = this.position + data.byteLength
    if (end > this.working.byteLength) {
      const extended = new Uint8Array(end)
      extended.set(this.working)
      this.working = extended
    }
    this.working.set(data, this.position)
    this.position = end
  }

  async close(): Promise<void> {
    this.ensureOpen()
    this.file.bytes = new Uint8Array(this.working)
    this.closed = true
  }

  async abort(): Promise<void> {
    this.closed = true
  }

  private ensureOpen(): void {
    if (this.closed) throw new DOMException('The stream is closed.', 'InvalidStateError')
  }
}

function notFound(): DOMException {
  return new DOMException('Entry was not found.', 'NotFoundError')
}
