import EventEmitter from 'eventemitter3';

import type {
  BotaStreamingFinalizeRequest,
  BotaStreamingProgress,
} from '../client';
import { getCompatibilityClient } from '../compatibility/runtime';
import type { ConnectedDevice } from '../models/Device';
import type {
  StreamingSessionEvents,
  StreamingState,
  StreamingUploadProvider,
} from '../models/Recording';

type ProtocolHandler = unknown;
type StorageManager = unknown;

const terminalHandlers = new WeakMap<StreamingSession, () => void>();

export const setStreamingSessionTerminalHandler = (
  session: StreamingSession,
  handler: () => void
): void => {
  terminalHandlers.set(session, handler);
};

const createOpaqueId = (): string =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (value) => {
    const random = Math.floor(Math.random() * 16);
    const nibble = value === 'x' ? random : (random & 0x3) | 0x8;
    return nibble.toString(16);
  });

export class StreamingSession extends EventEmitter<StreamingSessionEvents> {
  private readonly client = getCompatibilityClient();
  private readonly sessionId = createOpaqueId();
  private currentState: StreamingState = 'idle';
  private receivedBytes = 0;
  private uploadedChunks = 0;
  private backendRecordingId?: string;
  private relay?: Awaited<
    ReturnType<StreamingUploadProvider['createRecording']>
  >['relay'];
  private started = false;
  private terminal = false;

  constructor(
    protocolHandler: ProtocolHandler,
    _storageManager: StorageManager,
    private readonly device: ConnectedDevice,
    private readonly recordingUuid: string,
    private readonly uploadProvider: StreamingUploadProvider,
    private readonly chunkSizeKb = 256,
    private readonly flushIntervalMs = 60_000
  ) {
    super();
    void protocolHandler;
  }

  get state(): StreamingState {
    return this.currentState;
  }

  get bytesReceived(): number {
    return this.receivedBytes;
  }

  get chunksUploaded(): number {
    return this.uploadedChunks;
  }

  get recordingId(): string | undefined {
    return this.backendRecordingId;
  }

  get isActive(): boolean {
    return this.started && !this.terminal;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('StreamingSession has already started');
    this.started = true;
    try {
      const created = await this.uploadProvider.createRecording({
        startedAt: new Date(),
      });
      this.backendRecordingId = created.recordingId;
      this.relay = created.relay;
      const result = await this.client.streaming.startStreaming(
        this.device,
        {
          sessionId: this.sessionId,
          recordingUuid: this.recordingUuid,
          recordingId: created.recordingId,
          chunkSizeBytes:
            Math.min(1024, Math.max(64, this.chunkSizeKb)) * 1024,
          flushIntervalMs: Math.max(0, this.flushIntervalMs),
        },
        {
          onProgress: (progress) => this.handleProgress(progress),
          resolveChunkDestination: async ({ sequence, encrypted }) => {
            if (encrypted) {
              if (!this.relay) {
                throw new Error(
                  'Device delivered encrypted streaming data without an upload relay'
                );
              }
              return {
                url: this.relay.chunkUrl(sequence),
                method: 'POST',
                contentType: 'application/octet-stream',
                bearerToken: this.relay.bearerToken,
              };
            }
            return {
              url: await this.uploadProvider.getChunkUrl(
                created.recordingId,
                sequence
              ),
              method: 'PUT',
              contentType: 'audio/ogg',
            };
          },
          finalize: (metadata) => this.finalize(metadata),
        }
      );
      this.receivedBytes = result.totalBytes;
      this.currentState = 'completed';
      this.terminal = true;
      this.emit('completed', {
        recordingId: created.recordingId,
        totalBytes: result.totalBytes,
      });
      this.releaseTerminal();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.terminal = true;
      if (/disconnect|not connected/i.test(failure.message)) {
        this.currentState = 'disconnected';
        this.emit('disconnected');
      } else {
        this.currentState = 'failed';
        this.emit('error', failure);
      }
      this.releaseTerminal();
      throw failure;
    }
  }

  abort(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.currentState = 'failed';
    void this.client.streaming.abortStreaming(this.sessionId).catch(() => undefined);
    this.releaseTerminal();
  }

  private handleProgress(progress: BotaStreamingProgress): void {
    const previousState = this.currentState;
    this.currentState = progress.state as StreamingState;
    this.receivedBytes = progress.bytesReceived;
    this.uploadedChunks = progress.chunksUploaded;
    this.emit('chunk', {
      state: this.currentState,
      bytesReceived: this.receivedBytes,
      chunksUploaded: this.uploadedChunks,
      ...(this.backendRecordingId
        ? { recordingId: this.backendRecordingId }
        : {}),
    });
    if (this.currentState === 'paused') this.emit('paused');
    if (previousState === 'paused' && this.currentState === 'streaming') {
      this.emit('resumed');
    }
  }

  private async finalize(metadata: BotaStreamingFinalizeRequest): Promise<void> {
    if (!this.backendRecordingId) {
      throw new Error('Streaming recording has not been created');
    }
    if (metadata.encrypted) {
      if (!this.relay) throw new Error('Encrypted stream is missing relay metadata');
      const response = await fetch(this.relay.finalizeUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.relay.bearerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          total_chunks: metadata.totalChunks,
          duration_ms: metadata.durationMs,
          file_size_bytes: metadata.fileSizeBytes,
        }),
      });
      if (!response.ok) {
        throw new Error(`Streaming relay finalize failed (${response.status})`);
      }
      return;
    }
    await this.uploadProvider.finalizeRecording(this.backendRecordingId, {
      totalChunks: metadata.totalChunks,
      durationMs: metadata.durationMs,
      fileSizeBytes: metadata.fileSizeBytes,
    });
  }

  private releaseTerminal(): void {
    const handler = terminalHandlers.get(this);
    terminalHandlers.delete(this);
    handler?.();
  }
}
