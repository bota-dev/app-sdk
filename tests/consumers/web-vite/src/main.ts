import {
  BotaDeviceClient,
  BotaSDKError,
  type BrowserCapabilities,
  type DeviceLogLine,
  type DeviceRecording,
  type RecordingSyncResult,
  type SdkClientContext,
  type WiFiStatusInfo,
} from '@bota.dev/web-app-sdk'

const OPERATION_ID = 'browser-staged-upload'
const RECORDING_UUID = 'a1b2c3d4-0000-0000-0000-000000000000'
const UPLOAD_URL = 'https://upload.invalid/browser-gate'

interface ConsumerState {
  ready: boolean
  capabilities: BrowserCapabilities | null
  connection: 'connected' | 'disconnected'
  connectedSerial: string | null
  subscriptions: 'idle' | 'ready'
  wifiUpdates: WiFiStatusInfo[]
  logLines: DeviceLogLine[]
  syncPhase: string | null
  syncResult: RecordingSyncResult | null
  pendingOperations: Array<{ operationId: string; phase: string }>
  destroyed: boolean
  error: string | null
}

interface BrowserGate {
  recordUpload(count: number): void
}

declare global {
  interface Window {
    __botaFake?: BrowserGate
    __botaConsumerTest: {
      holdProvider(): void
      resolveProvider(): void
      nextPresence(): Promise<SdkClientContext | null>
    }
  }
}

const result = requiredElement<HTMLPreElement>('#result')
const serial = requiredElement<HTMLInputElement>('#serial')
const state: ConsumerState = {
  ready: false,
  capabilities: null,
  connection: 'disconnected',
  connectedSerial: null,
  subscriptions: 'idle',
  wifiUpdates: [],
  logLines: [],
  syncPhase: null,
  syncResult: null,
  pendingOperations: [],
  destroyed: false,
  error: null,
}
let providerGate: Promise<void> | null = null
let resolveProviderGate: (() => void) | null = null

window.__botaConsumerTest = {
  nextPresence() {
    return client.clientPresence.nextReport(client.devices.connectedDevice?.id ?? '')
  },
  holdProvider() {
    providerGate = new Promise<void>((resolve) => {
      resolveProviderGate = resolve
    })
  },
  resolveProvider() {
    resolveProviderGate?.()
    resolveProviderGate = null
    providerGate = null
  },
}

const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  if (String(input) !== UPLOAD_URL) {
    return await nativeFetch(input, init)
  }
  state.syncPhase = 'uploading'
  render()
  const body = init?.body
  if (!(body instanceof ReadableStream)) return new Response(null, { status: 400 })
  const reader = body.getReader()
  let uploaded = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    uploaded += next.value.byteLength
  }
  window.__botaFake?.recordUpload(uploaded)
  state.syncPhase = 'uploaded'
  render()
  return new Response(null, { status: 200 })
}

const capabilityOnly = new URLSearchParams(location.search).has('capabilities')
const client = await BotaDeviceClient.create({
  ...(capabilityOnly ? {} : { storageNamespace: 'browser-gate-tenant' }),
  providers: {
    recordingUpload: {
      async prepareLegacyUpload() {
        state.syncPhase = 'provider_pending'
        render()
        if (providerGate) await providerGate
        state.syncPhase = 'provider_ready'
        render()
        return {
          uploadId: 'browser-upload',
          request: {
            method: 'PUT',
            url: UPLOAD_URL,
            headers: {},
          },
        }
      },
      async completeLegacyUpload() {
        state.syncPhase = 'provider_complete'
        render()
        return { cloudCompletionId: 'browser-cloud-complete' }
      },
      async reconcileLegacyUpload() {
        return { state: 'not_uploaded' as const }
      },
      async prepareEncryptedUploadV2() {
        throw new Error('encrypted upload is outside this consumer gate')
      },
    },
  },
})
state.capabilities = client.devices.getCapabilities()
if (!capabilityOnly) {
  state.pendingOperations = (await client.recordings.listPendingOperations())
    .map(({ operationId, phase }) => ({ operationId, phase }))
}
state.ready = true
render()

onClick('#connect', async () => {
  const connected = await client.devices.connect({
    expectedSerialNumber: serial.value,
  })
  state.connection = 'connected'
  state.connectedSerial = connected.serialNumber
})

onClick('#connect-selected', async () => {
  const connected = await client.devices.connectSelected()
  state.connection = 'connected'
  state.connectedSerial = connected.serialNumber
})

onClick('#disconnect', async () => {
  await client.devices.disconnect()
  state.connection = 'disconnected'
  state.connectedSerial = null
})

onClick('#reconnect', async () => {
  const connected = await client.devices.reconnect({
    expectedSerialNumber: serial.value,
  })
  state.connection = 'connected'
  state.connectedSerial = connected.serialNumber
})

onClick('#subscribe-events', async () => {
  await client.wifi.subscribeToStatus((status) => {
    state.wifiUpdates.push(status)
    render()
  })
  await client.logs.subscribe((line) => {
    state.logLines.push(line)
    render()
  })
  state.subscriptions = 'ready'
})

onClick('#start-sync', async () => {
  state.syncResult = await client.recordings.sync(recording(), {
    profile: 'legacy',
    operationId: OPERATION_ID,
    onProgress: (progress) => {
      state.syncPhase = progress.phase
      render()
    },
  })
  state.syncPhase = 'complete'
})

onClick('#resume-sync', async () => {
  state.syncResult = await client.recordings.resume(OPERATION_ID, {
    onProgress: (progress) => {
      state.syncPhase = progress.phase
      render()
    },
  })
  state.syncPhase = 'complete'
})

onClick('#destroy', async () => {
  await client.destroy()
  state.destroyed = true
})

function onClick(selector: string, action: () => Promise<void>): void {
  requiredElement<HTMLButtonElement>(selector).addEventListener('click', () => {
    state.error = null
    void action().then(render, (error: unknown) => {
      state.error = error instanceof BotaSDKError ? error.code : 'unexpected_error'
      render()
    })
  })
}

function recording(): DeviceRecording {
  return {
    uuid: RECORDING_UUID,
    startedAtTimestampSeconds: 1_700_000_000,
    durationMilliseconds: 12_000n,
    fileSizeBytes: 9n,
    codec: 'opus_16k',
    encrypted: false,
    encryptedUploadV2: null,
  }
}

function render(): void {
  result.textContent = JSON.stringify(state)
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`missing consumer element ${selector}`)
  return element
}
