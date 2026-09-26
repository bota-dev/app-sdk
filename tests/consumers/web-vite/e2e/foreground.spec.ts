import { expect, test, type Page } from '@playwright/test'

const SERIAL = 'GDPPSBZJN6'
const OTHER_SERIAL = 'OTHERDEVICE1'
const UUID = {
  serial: 'b07a0008-0001-1000-8000-00805f9b34fb',
  transferControl: 'b07a0004-0004-1000-8000-00805f9b34fb',
  recordingList: 'b07a0004-0002-1000-8000-00805f9b34fb',
  recordingTransfer: 'b07a0004-0003-1000-8000-00805f9b34fb',
  wifiStatus: 'b07a0006-0003-1000-8000-00805f9b34fb',
  logData: 'b07a0007-0002-1000-8000-00805f9b34fb',
} as const

interface FakeOptions {
  bluetooth?: boolean
  durableStorage?: boolean
}

test('picker connection requires a real click and the exact serial', async ({ page }) => {
  await installBrowserFakes(page)
  await page.goto('/')
  await expect.poll(() => state(page, 'ready')).toBe(true)

  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('#connect')?.click()
  })
  await expect.poll(() => state(page, 'error')).toBe('permission_denied')

  await page.locator('#serial').fill(OTHER_SERIAL)
  await page.locator('#connect').click()
  await expect.poll(() => state(page, 'error')).toBe('identity_mismatch')

  await page.locator('#serial').fill(SERIAL)
  await page.locator('#connect').click()
  await expect.poll(() => state(page, 'connectedSerial')).toBe(SERIAL)
  expect(await fakeMetric(page, 'requestDeviceCalls')).toBe(3)
})

test('selected-device picker learns the serial without manual entry', async ({ page }) => {
  await installBrowserFakes(page)
  await page.goto('/')
  await expect.poll(() => state(page, 'ready')).toBe(true)
  await page.locator('#serial').fill('')
  expect(await page.locator('#connect-selected').count()).toBe(1)

  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('#connect-selected')?.click()
  })
  await expect.poll(() => state(page, 'error')).toBe('permission_denied')

  await page.locator('#connect-selected').click()
  await expect.poll(() => state(page, 'connectedSerial')).toBe(SERIAL)
  expect(await fakeMetric(page, 'requestDeviceCalls')).toBe(2)
})

test('authorized reconnect uses the persisted exact device without a picker', async ({ page }) => {
  await installBrowserFakes(page)
  await page.goto('/')
  await expect.poll(() => state(page, 'ready')).toBe(true)
  await page.locator('#connect').click()
  await expect.poll(() => state(page, 'connectedSerial')).toBe(SERIAL)
  const pickerCalls = await fakeMetric(page, 'requestDeviceCalls')

  await page.locator('#disconnect').click()
  await expect.poll(() => state(page, 'connection')).toBe('disconnected')
  await page.locator('#reconnect').click()
  await expect.poll(() => state(page, 'connectedSerial')).toBe(SERIAL)

  expect(await fakeMetric(page, 'requestDeviceCalls')).toBe(pickerCalls)
  expect(await fakeMetric(page, 'getDevicesCalls')).toBe(1)
})

test('GATT notifications produce exactly one WiFi update and one log line', async ({ page }) => {
  await installBrowserFakes(page)
  await page.goto('/')
  await expect.poll(() => state(page, 'ready')).toBe(true)
  await page.locator('#connect').click()
  await expect.poll(() => state(page, 'connectedSerial')).toBe(SERIAL)
  await page.locator('#subscribe-events').click()
  await expect.poll(() => state(page, 'subscriptions')).toBe('ready')

  await page.evaluate(({ wifi, logs }) => {
    const fake = (window as any).__botaFake
    fake.emit(wifi, [0x02, 0x57, 0x04, 0x42, 0x6f, 0x74, 0x61])
    fake.emit(logs, [0x01, 0x00, 0x00, 0x66, 0x6f, 0x72, 0x65, 0x67, 0x72, 0x6f, 0x75, 0x6e, 0x64, 0x0a])
  }, { wifi: UUID.wifiStatus, logs: UUID.logData })

  await expect.poll(() => state(page, 'wifiUpdates')).toEqual([{
    status: 'connected',
    statusRaw: 2,
    signalStrength: 87,
    ssid: 'Bota',
  }])
  await expect.poll(() => state(page, 'logLines')).toEqual([{
    message: 'foreground',
    isBacklog: false,
  }])
})

test('destroy owns log cleanup and suppresses a historical late notification', async ({ page }) => {
  await installBrowserFakes(page)
  await page.goto('/')
  await expect.poll(() => state(page, 'ready')).toBe(true)
  await page.locator('#connect').click()
  await expect.poll(() => state(page, 'connectedSerial')).toBe(SERIAL)
  await page.locator('#subscribe-events').click()
  await expect.poll(() => state(page, 'subscriptions')).toBe('ready')
  expect(await fakeMetric(page, 'activeLogListeners')).toBe(1)

  const logsBeforeDestroy = await state(page, 'logLines')
  await page.locator('#destroy').click()
  await expect.poll(() => state(page, 'destroyed')).toBe(true)
  expect(await fakeMetric(page, 'activeLogListeners')).toBe(0)
  await page.evaluate((logs) => {
    ;(window as any).__botaFake.emitLate(
      logs,
      [0x02, 0x00, 0x00, 0x6c, 0x61, 0x74, 0x65, 0x0a],
    )
  }, UUID.logData)
  await page.waitForTimeout(50)

  expect(await state(page, 'logLines')).toEqual(logsBeforeDestroy)
})

test('reload resumes staged IndexedDB and OPFS state while destroy suppresses late work', async ({ page }) => {
  await installBrowserFakes(page)
  await page.goto('/')
  await expect.poll(() => state(page, 'ready')).toBe(true)
  await page.locator('#connect').click()
  await expect.poll(() => state(page, 'connectedSerial')).toBe(SERIAL)
  await page.evaluate(() => {
    ;(window as any).__botaConsumerTest.holdProvider()
  })
  await page.locator('#start-sync').click()
  await expect.poll(() => state(page, 'syncPhase')).toBe('provider_pending')

  await page.locator('#destroy').click()
  await expect.poll(() => state(page, 'destroyed')).toBe(true)
  await page.evaluate(() => {
    ;(window as any).__botaConsumerTest.resolveProvider()
  })
  await page.waitForTimeout(50)

  expect(await state(page, 'syncResult')).toBeNull()
  expect(await fakeMetric(page, 'uploadBytes')).toBe(0)
  expect(await fakeMetric(page, 'confirmWrites')).toBe(0)

  await page.reload()
  await expect.poll(() => state(page, 'pendingOperations')).toEqual([{
    operationId: 'browser-staged-upload',
    phase: 'staged',
  }])
  await page.locator('#reconnect').click()
  await expect.poll(() => state(page, 'connectedSerial')).toBe(SERIAL)
  expect(await fakeMetric(page, 'requestDeviceCalls')).toBe(0)
  await page.locator('#resume-sync').click()
  await expect.poll(() => state(page, 'syncPhase')).toBe('complete')

  expect(await state(page, 'syncResult')).toEqual({
    operationId: 'browser-staged-upload',
    recordingUuid: 'a1b2c3d4-0000-0000-0000-000000000000',
    profile: 'legacy',
    cloudCompletionId: 'browser-cloud-complete',
  })
  expect(await fakeMetric(page, 'uploadBytes')).toBe(9)
  expect(await fakeMetric(page, 'confirmWrites')).toBe(1)
})

test('absent Bluetooth exposes the exact storage-only capability matrix', async ({ page }) => {
  await installBrowserFakes(page, { bluetooth: false })
  await page.goto('/?capabilities=1')
  await expect.poll(() => state(page, 'ready')).toBe(true)
  await expect.poll(() => state(page, 'capabilities')).toEqual({
    bluetooth: false,
    authorizedDeviceReconnect: false,
    durableStorage: true,
    largeRecordingSync: false,
    firmwareUpdate: false,
  })
})

test('absent durable storage exposes the exact Bluetooth-only capability matrix', async ({ page }) => {
  await installBrowserFakes(page, { durableStorage: false })
  await page.goto('/?capabilities=1')
  await expect.poll(() => state(page, 'ready')).toBe(true)
  await expect.poll(() => state(page, 'capabilities')).toEqual({
    bluetooth: true,
    authorizedDeviceReconnect: true,
    durableStorage: false,
    largeRecordingSync: false,
    firmwareUpdate: false,
  })
})

async function state(page: Page, key: string): Promise<unknown> {
  const value = await page.locator('#result').textContent()
  try {
    return JSON.parse(value ?? '{}')[key]
  } catch {
    return undefined
  }
}

async function fakeMetric(page: Page, key: string): Promise<number> {
  return await page.evaluate((metric) =>
    Number((window as any).__botaFake.snapshot()[metric]), key)
}

async function installBrowserFakes(
  page: Page,
  options: FakeOptions = {},
): Promise<void> {
  await page.addInitScript(({ bluetooth, durableStorage, serialNumber, uuids }) => {
    const canonical = (uuid: string): string => {
      const value = uuid.toLowerCase()
      if (/^[0-9a-f]{4}$/.test(value)) {
        return `0000${value}-0000-1000-8000-00805f9b34fb`
      }
      if (/^[0-9a-f]{8}$/.test(value)) {
        return `${value}-0000-1000-8000-00805f9b34fb`
      }
      return value
    }
    const bytes = (value: BufferSource): Uint8Array => {
      if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
      return new Uint8Array(
        value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
      )
    }
    const view = (value: Uint8Array): DataView =>
      new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
    const missing = (): DOMException => new DOMException('missing', 'NotFoundError')
    const encodeBase64 = (value: Uint8Array): string => {
      let binary = ''
      for (const byte of value) binary += String.fromCharCode(byte)
      return btoa(binary)
    }
    const decodeBase64 = (value: string | null): Uint8Array => {
      if (!value) return new Uint8Array()
      const binary = atob(value)
      return Uint8Array.from(binary, (character) => character.charCodeAt(0))
    }

    class FakeTarget {
      protected readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
      protected readonly history = new Map<string, Set<EventListenerOrEventListenerObject>>()

      addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
        if (!listener) return
        const current = this.listeners.get(type) ?? new Set()
        current.add(listener)
        this.listeners.set(type, current)
        const all = this.history.get(type) ?? new Set()
        all.add(listener)
        this.history.set(type, all)
      }

      removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
        if (listener) this.listeners.get(type)?.delete(listener)
      }

      listenerCount(type: string): number {
        return this.listeners.get(type)?.size ?? 0
      }

      protected dispatch(type: string, late = false): void {
        const listeners = late ? this.history.get(type) : this.listeners.get(type)
        for (const listener of [...(listeners ?? [])]) {
          const event = { type, target: this, currentTarget: this } as unknown as Event
          if (typeof listener === 'function') listener.call(this, event)
          else listener.handleEvent(event)
        }
      }
    }

    const metric = {
      requestDeviceCalls: 0,
      getDevicesCalls: 0,
      uploadBytes: 0,
      confirmWrites: 0,
      writes: [] as Array<{ uuid: string; hex: string }>,
    }

    class FakeCharacteristic extends FakeTarget {
      readonly uuid: string
      value: DataView | null = null

      constructor(uuid: string) {
        super()
        this.uuid = canonical(uuid)
      }

      async readValue(): Promise<DataView> {
        if (this.uuid === uuids.serial) {
          return view(new TextEncoder().encode(serialNumber))
        }
        throw missing()
      }

      async writeValueWithResponse(value: BufferSource): Promise<void> {
        this.written(bytes(value))
      }

      async writeValueWithoutResponse(value: BufferSource): Promise<void> {
        this.written(bytes(value))
      }

      async startNotifications(): Promise<this> {
        return this
      }

      async stopNotifications(): Promise<this> {
        return this
      }

      emit(value: number[], late = false): void {
        this.value = view(Uint8Array.from(value))
        this.dispatch('characteristicvaluechanged', late)
      }

      private written(value: Uint8Array): void {
        metric.writes.push({
          uuid: this.uuid,
          hex: [...value].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
        })
        if (this.uuid !== canonical(uuids.transferControl)) return
        if (value[0] === 0x01) {
          setTimeout(() => characteristic(uuids.recordingList).emit([
            0xa1, 0xb2, 0xc3, 0xd4, 0x01, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0xf1, 0x53, 0x65,
            0x0c, 0x00, 0x04, 0x00,
          ]), 0)
        } else if (value[0] === 0x02) {
          setTimeout(() => characteristic(uuids.recordingTransfer).emit([
            0x01, 0x00, 0x00, 0x09, 0x00,
            0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
          ]), 0)
          setTimeout(() => characteristic(uuids.recordingTransfer).emit([
            0x02, 0x01, 0x00, 0x26, 0x39, 0xf4, 0xcb,
          ]), 30)
          setTimeout(() => characteristic(uuids.recordingTransfer).emit([
            0x04, ...Array.from({ length: 32 }, (_, index) => index),
          ]), 40)
        } else if (value[0] === 0x07) {
          metric.confirmWrites += 1
        }
      }
    }

    const characteristics = new Map<string, FakeCharacteristic>()
    const characteristic = (uuid: string): FakeCharacteristic => {
      const key = canonical(uuid)
      const existing = characteristics.get(key)
      if (existing) return existing
      const created = new FakeCharacteristic(key)
      characteristics.set(key, created)
      return created
    }
    class FakeService {
      readonly uuid: string
      constructor(uuid: string) {
        this.uuid = canonical(uuid)
      }
      async getCharacteristic(uuid: string): Promise<FakeCharacteristic> {
        const canonicalUuid = BluetoothUUID.getCharacteristic(uuid)
        if (canonicalUuid === canonical('2a25')) {
          throw new DOMException('blocklisted UUID', 'SecurityError')
        }
        if (canonicalUuid === uuids.serial && this.uuid !== canonical('b07a0008-0000-1000-8000-00805f9b34fb')) {
          throw missing()
        }
        return characteristic(canonicalUuid)
      }
    }
    class FakeGattServer {
      connected = false
      async connect(): Promise<this> {
        this.connected = true
        return this
      }
      disconnect(): void {
        this.connected = false
      }
      async getPrimaryServices(): Promise<FakeService[]> {
        return []
      }
      async getPrimaryService(uuid: string): Promise<FakeService> {
        return new FakeService(BluetoothUUID.getService(uuid))
      }
    }
    class FakeDevice extends FakeTarget {
      readonly id = 'browser-peripheral-1'
      readonly name = 'Bota Pin'
      readonly gatt = new FakeGattServer()
    }
    const device = new FakeDevice()

    if (bluetooth) {
      Object.defineProperty(navigator, 'bluetooth', {
        configurable: true,
        value: {
          requestDevice: async () => {
            metric.requestDeviceCalls += 1
            if (!navigator.userActivation?.isActive || window.event?.isTrusted !== true) {
              throw new DOMException('user activation required', 'NotAllowedError')
            }
            localStorage.setItem('bota-browser-authorized', 'true')
            return device
          },
          getDevices: async () => {
            metric.getDevicesCalls += 1
            return localStorage.getItem('bota-browser-authorized') === 'true'
              ? [device]
              : []
          },
        },
      })
    } else {
      Object.defineProperty(navigator, 'bluetooth', {
        configurable: true,
        value: undefined,
      })
    }

    class FakeFileHandle {
      constructor(private readonly key: string) {}
      async getFile(): Promise<Blob> {
        return new Blob([decodeBase64(localStorage.getItem(this.key))])
      }
      async createWritable(): Promise<{
        seek(offset: number): Promise<void>
        write(value: BufferSource): Promise<void>
        truncate(size: number): Promise<void>
        close(): Promise<void>
        abort(): Promise<void>
      }> {
        let contents = decodeBase64(localStorage.getItem(this.key))
        let offset = 0
        return {
          seek: async (next) => { offset = next },
          write: async (value) => {
            const addition = bytes(value)
            const next = new Uint8Array(Math.max(contents.byteLength, offset + addition.byteLength))
            next.set(contents)
            next.set(addition, offset)
            contents = next
            offset += addition.byteLength
          },
          truncate: async (size) => { contents = contents.slice(0, size) },
          close: async () => { localStorage.setItem(this.key, encodeBase64(contents)) },
          abort: async () => undefined,
        }
      }
    }
    class FakeDirectoryHandle {
      constructor(private readonly path: string) {}
      async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectoryHandle> {
        const child = `${this.path}/${name}`
        if (!options?.create && !hasPath(child)) throw missing()
        localStorage.setItem(`opfs-dir:${child}`, '1')
        return new FakeDirectoryHandle(child)
      }
      async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
        const key = `opfs-file:${this.path}/${name}`
        if (!options?.create && localStorage.getItem(key) === null) throw missing()
        if (localStorage.getItem(key) === null) localStorage.setItem(key, '')
        return new FakeFileHandle(key)
      }
      async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
        const child = `${this.path}/${name}`
        const fileKey = `opfs-file:${child}`
        if (localStorage.getItem(fileKey) !== null) {
          localStorage.removeItem(fileKey)
          return
        }
        const keys = Object.keys(localStorage).filter((key) =>
          key.startsWith(`opfs-dir:${child}`) || key.startsWith(`opfs-file:${child}`))
        if (keys.length === 0) throw missing()
        if (!options?.recursive && keys.some((key) => key !== `opfs-dir:${child}`)) {
          throw new DOMException('not empty', 'InvalidModificationError')
        }
        for (const key of keys) localStorage.removeItem(key)
      }
    }
    const hasPath = (path: string): boolean => Object.keys(localStorage).some((key) =>
      key.startsWith(`opfs-dir:${path}`) || key.startsWith(`opfs-file:${path}`))

    Object.defineProperty(navigator.storage, 'getDirectory', {
      configurable: true,
      value: durableStorage
        ? async () => {
            localStorage.setItem('opfs-dir:root', '1')
            return new FakeDirectoryHandle('root')
          }
        : undefined,
    })

    ;(window as any).__botaFake = {
      emit: (uuid: string, value: number[]) => characteristic(uuid).emit(value),
      emitLate: (uuid: string, value: number[]) => characteristic(uuid).emit(value, true),
      recordUpload: (count: number) => { metric.uploadBytes += count },
      snapshot: () => structuredClone({
        ...metric,
        activeLogListeners: characteristic(uuids.logData)
          .listenerCount('characteristicvaluechanged'),
      }),
    }
  }, {
    bluetooth: options.bluetooth ?? true,
    durableStorage: options.durableStorage ?? true,
    serialNumber: SERIAL,
    uuids: UUID,
  })
}
