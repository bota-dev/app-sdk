import type { CoreIntegrityHasher } from './core.ts'
import {
  BrowserStorageError,
  mapBrowserStorageError,
  validateStorageIdentifier,
  validateStorageNamespace,
} from './indexedDbWorkflowStore.ts'
import type { BrowserBlobHandle } from './storage.ts'

const DEFAULT_STREAM_CHUNK_SIZE = 64 * 1024
const SDK_DIRECTORY = 'bota-app-sdk'
const SCHEMA_DIRECTORY = 'v1'
const inProcessBlobLocks = new Map<string, Promise<void>>()

export class OpfsBlobStore {
  private readonly root: FileSystemDirectoryHandle
  private readonly createIntegrityHasher: () => CoreIntegrityHasher
  private readonly namespaceDirectoryName: string

  constructor(
    namespace: string,
    root: FileSystemDirectoryHandle,
    createIntegrityHasher: () => CoreIntegrityHasher,
  ) {
    validateStorageNamespace(namespace)
    this.root = root
    this.createIntegrityHasher = createIntegrityHasher
    this.namespaceDirectoryName = this.hashName(namespace)
  }

  async open(blobId: string): Promise<BrowserBlobHandle> {
    validateStorageIdentifier(blobId)
    const fileName = this.hashName(blobId)
    const lockName = [
      SDK_DIRECTORY,
      SCHEMA_DIRECTORY,
      this.namespaceDirectoryName,
      fileName,
    ].join(':')
    return new OpfsBlobHandle(
      blobId,
      fileName,
      async () => await this.namespaceDirectory(),
      async <T>(action: () => Promise<T>) =>
        await withBlobLock(lockName, action),
    )
  }

  async clear(): Promise<void> {
    try {
      const sdk = await this.root.getDirectoryHandle(SDK_DIRECTORY)
      const version = await sdk.getDirectoryHandle(SCHEMA_DIRECTORY)
      await version.removeEntry(this.namespaceDirectoryName, { recursive: true })
    } catch (error) {
      if (domExceptionName(error) === 'NotFoundError') return
      throw mapBrowserStorageError(error)
    }
  }

  private async namespaceDirectory(): Promise<FileSystemDirectoryHandle> {
    try {
      const sdk = await this.root.getDirectoryHandle(SDK_DIRECTORY, { create: true })
      const version = await sdk.getDirectoryHandle(SCHEMA_DIRECTORY, { create: true })
      return await version.getDirectoryHandle(this.namespaceDirectoryName, {
        create: true,
      })
    } catch (error) {
      throw mapBrowserStorageError(error)
    }
  }

  private hashName(value: string): string {
    try {
      const hasher = this.createIntegrityHasher()
      hasher.update(new TextEncoder().encode(value))
      const digest = hasher.sha256Snapshot()
      if (digest.byteLength !== 32) {
        throw new BrowserStorageError('storage_unavailable')
      }
      return Array.from(
        digest,
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('')
    } catch (error) {
      throw mapBrowserStorageError(error)
    }
  }
}

class OpfsBlobHandle implements BrowserBlobHandle {
  readonly id: string

  private readonly fileName: string
  private readonly directory: () => Promise<FileSystemDirectoryHandle>
  private readonly withLock: <T>(action: () => Promise<T>) => Promise<T>

  constructor(
    id: string,
    fileName: string,
    directory: () => Promise<FileSystemDirectoryHandle>,
    withLock: <T>(action: () => Promise<T>) => Promise<T>,
  ) {
    this.id = id
    this.fileName = fileName
    this.directory = directory
    this.withLock = withLock
  }

  async size(): Promise<number> {
    try {
      return validFileSize((await (await this.fileHandle()).getFile()).size)
    } catch (error) {
      throw mapBrowserStorageError(error)
    }
  }

  async truncate(size: number): Promise<void> {
    validateOffset(size)
    await this.withLock(async () => {
      const currentSize = await this.size()
      if (size > currentSize) throw new BrowserStorageError('resume_rejected')
      if (size === currentSize) return

      await this.withWritable(async (writable) => {
        await writable.truncate(size)
      })
    })
  }

  async write(offset: number, bytes: Uint8Array): Promise<void> {
    validateOffset(offset)
    if (!(bytes instanceof Uint8Array)) {
      throw new BrowserStorageError('invalid_input')
    }
    validateRange(offset, bytes.byteLength)

    const copy = new Uint8Array(bytes)
    await this.withLock(async () => {
      const currentSize = await this.size()
      if (offset !== currentSize) {
        throw new BrowserStorageError('resume_rejected')
      }
      if (copy.byteLength === 0) return

      await this.withWritable(async (writable) => {
        await writable.seek(offset)
        await writable.write(copy)
      })
    })
  }

  async read(offset: number, maximumLength: number): Promise<Uint8Array> {
    validateOffset(offset)
    validateLength(maximumLength, true)
    validateRange(offset, maximumLength)
    if (maximumLength === 0) return new Uint8Array()

    try {
      const file = await (await this.fileHandle()).getFile()
      const size = validFileSize(file.size)
      if (offset >= size) return new Uint8Array()
      const end = Math.min(size, offset + maximumLength)
      return new Uint8Array(await file.slice(offset, end).arrayBuffer())
    } catch (error) {
      throw mapBrowserStorageError(error)
    }
  }

  async *stream(
    chunkSize: number = DEFAULT_STREAM_CHUNK_SIZE,
  ): AsyncIterable<Uint8Array> {
    validateLength(chunkSize, false)
    const size = await this.size()
    let offset = 0
    while (offset < size) {
      const length = Math.min(chunkSize, size - offset)
      yield await this.read(offset, length)
      offset += length
    }
  }

  async delete(): Promise<void> {
    await this.withLock(async () => {
      try {
        const directory = await this.directory()
        await directory.removeEntry(this.fileName)
      } catch (error) {
        if (domExceptionName(error) === 'NotFoundError') return
        throw mapBrowserStorageError(error)
      }
    })
  }

  private async fileHandle(): Promise<FileSystemFileHandle> {
    const directory = await this.directory()
    return await directory.getFileHandle(this.fileName, { create: true })
  }

  private async withWritable(
    action: (writable: FileSystemWritableFileStream) => Promise<void>,
  ): Promise<void> {
    let writable: FileSystemWritableFileStream | null = null
    try {
      writable = await (await this.fileHandle()).createWritable({
        keepExistingData: true,
      })
      await action(writable)
      await writable.close()
    } catch (error) {
      if (writable) {
        try {
          await writable.abort()
        } catch {
          // Preserve the original storage failure.
        }
      }
      throw mapBrowserStorageError(error)
    }
  }
}

async function withBlobLock<T>(
  name: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockManager = browserLockManager()
  if (lockManager) {
    try {
      return await lockManager.request(name, action)
    } catch (error) {
      throw mapBrowserStorageError(error)
    }
  }

  return await withInProcessBlobLock(name, action)
}

async function withInProcessBlobLock<T>(
  name: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = inProcessBlobLocks.get(name) ?? Promise.resolve()
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => gate)
  inProcessBlobLocks.set(name, tail)

  await previous
  try {
    return await action()
  } finally {
    release()
    if (inProcessBlobLocks.get(name) === tail) inProcessBlobLocks.delete(name)
  }
}

function browserLockManager(): LockManager | null {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) return null
  const lockManager = Reflect.get(navigator, 'locks') as LockManager | null
  return lockManager && typeof lockManager.request === 'function'
    ? lockManager
    : null
}

function validateOffset(value: number): void {
  validateLength(value, true)
}

function validateLength(value: number, allowZero: boolean): void {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || (!allowZero && value === 0)
  ) {
    throw new BrowserStorageError('invalid_input')
  }
}

function validateRange(offset: number, length: number): void {
  validateOffset(offset)
  validateLength(length, true)
  if (length > Number.MAX_SAFE_INTEGER - offset) {
    throw new BrowserStorageError('invalid_input')
  }
}

function validFileSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new BrowserStorageError('resume_rejected')
  }
  return size
}

function domExceptionName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('name' in error)) return null
  return typeof error.name === 'string' ? error.name : null
}
