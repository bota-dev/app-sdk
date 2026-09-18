import type { CoreIntegrityHasher } from './core.ts'
import {
  BrowserStorageError,
  mapBrowserStorageError,
} from './indexedDbWorkflowStore.ts'
import type { BrowserBlobHandle } from './storage.ts'

const DEFAULT_STREAM_CHUNK_SIZE = 64 * 1024
const SDK_DIRECTORY = 'bota-app-sdk'
const SCHEMA_DIRECTORY = 'v1'

export class OpfsBlobStore {
  private readonly root: FileSystemDirectoryHandle
  private readonly createIntegrityHasher: () => CoreIntegrityHasher
  private readonly namespaceDirectoryName: string

  constructor(
    namespace: string,
    root: FileSystemDirectoryHandle,
    createIntegrityHasher: () => CoreIntegrityHasher,
  ) {
    this.root = root
    this.createIntegrityHasher = createIntegrityHasher
    this.namespaceDirectoryName = this.hashName(namespace)
  }

  async open(blobId: string): Promise<BrowserBlobHandle> {
    validateBlobId(blobId)
    return new OpfsBlobHandle(
      blobId,
      this.hashName(blobId),
      async () => await this.namespaceDirectory(),
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

  constructor(
    id: string,
    fileName: string,
    directory: () => Promise<FileSystemDirectoryHandle>,
  ) {
    this.id = id
    this.fileName = fileName
    this.directory = directory
  }

  async size(): Promise<number> {
    try {
      return (await (await this.fileHandle()).getFile()).size
    } catch (error) {
      throw mapBrowserStorageError(error)
    }
  }

  async truncate(size: number): Promise<void> {
    validateOffset(size)
    const currentSize = await this.size()
    if (size > currentSize) throw new BrowserStorageError('resume_rejected')
    if (size === currentSize) return

    await this.withWritable(async (writable) => {
      await writable.truncate(size)
    })
  }

  async write(offset: number, bytes: Uint8Array): Promise<void> {
    validateOffset(offset)
    if (!(bytes instanceof Uint8Array)) {
      throw new BrowserStorageError('invalid_input')
    }
    const currentSize = await this.size()
    if (offset !== currentSize) {
      throw new BrowserStorageError('resume_rejected')
    }
    if (bytes.byteLength === 0) return

    const copy = new Uint8Array(bytes)
    await this.withWritable(async (writable) => {
      await writable.seek(offset)
      await writable.write(copy)
    })
  }

  async read(offset: number, maximumLength: number): Promise<Uint8Array> {
    validateOffset(offset)
    validateLength(maximumLength, true)
    if (maximumLength === 0) return new Uint8Array()

    try {
      const file = await (await this.fileHandle()).getFile()
      if (offset >= file.size) return new Uint8Array()
      const end = Math.min(file.size, offset + maximumLength)
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
    for (let offset = 0; offset < size; offset += chunkSize) {
      yield await this.read(offset, Math.min(chunkSize, size - offset))
    }
  }

  async delete(): Promise<void> {
    try {
      const directory = await this.directory()
      await directory.removeEntry(this.fileName)
    } catch (error) {
      if (domExceptionName(error) === 'NotFoundError') return
      throw mapBrowserStorageError(error)
    }
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

function validateBlobId(blobId: string): void {
  if (typeof blobId !== 'string' || blobId.length === 0) {
    throw new BrowserStorageError('invalid_input')
  }
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

function domExceptionName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('name' in error)) return null
  return typeof error.name === 'string' ? error.name : null
}
