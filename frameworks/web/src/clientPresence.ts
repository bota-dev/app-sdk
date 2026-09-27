import { SDK_PACKAGE, SDK_VERSION } from './sdkIdentity.ts'

/** Self-reported diagnostics, not identity attestation or command authority. */
export interface SdkClientContext {
  schema_version: 1
  session_id: string
  sequence: number
  platform: 'web'
  sdk_package: string
  sdk_version: string
}

export interface ClientPresence {
  /** Local-only. deviceId is the SDK handle, not a backend dev_* identifier. */
  nextReport(deviceId: string): Promise<SdkClientContext | null>
}

/** Internal passive owner. Only verified connection lifecycle calls connected. */
export class ConnectionClientPresence implements ClientPresence {
  private session: { deviceId: string; id: string; sequence: number } | null = null
  private destroyed = false
  private readonly uuid: () => string

  constructor(uuid: () => string = () => globalThis.crypto.randomUUID()) {
    this.uuid = uuid
  }

  connected(deviceId: string): () => void {
    if (this.destroyed) return () => {}
    const session = { deviceId, id: this.uuid(), sequence: 0 }
    this.session = session
    return () => { if (this.session === session) this.session = null }
  }

  async nextReport(deviceId: string): Promise<SdkClientContext | null> {
    const session = this.session
    if (!session || session.deviceId !== deviceId || this.destroyed) return null
    return {
      schema_version: 1, session_id: session.id, sequence: ++session.sequence,
      platform: 'web', sdk_package: SDK_PACKAGE, sdk_version: SDK_VERSION,
    }
  }

  destroy(): void {
    this.destroyed = true
    this.session = null
  }
}
