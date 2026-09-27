import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createWasmCore } from '../wasmCore.ts'
import { exchangeUploadContext } from '../uploadContext.ts'

const core = await createWasmCore(await readFile(new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url)))
function snapshot(state: number) {
  const payload = state === 1 ? new Uint8Array(16).fill(17) : state === 2 ? new Uint8Array(116).fill(34) : new Uint8Array()
  const result = new Uint8Array(12 + payload.length)
  result.set([0x66,2,state,0,1,0,0,0,0,0,payload.length,0]); result.set(payload,12)
  return result
}
function document(kind: number) {
  const value = new Uint8Array(kind === 3 ? 196 : 264)
  value.set(new TextEncoder().encode(kind === 3 ? 'BOTACTXQ' : 'BOTACTXR'))
  value[8] = 1; new DataView(value.buffer).setUint16(10,value.length,true)
  return value
}
test('context exchange relays exact opaque bytes and requires physical completion', async () => {
  let state = 1
  const events: string[] = []
  await exchangeUploadContext(core, {
    begin: async bytes => { assert.deepEqual(bytes,Uint8Array.of(0x65,2,0,0,1,0,0,0)); events.push('begin') },
    read: async () => { events.push(`read:${state}`); return snapshot(state) },
    sendDocument: async (kind,bytes) => { assert.deepEqual(bytes,document(kind)); events.push(`document:${kind}`); state++ },
    uncertain: () => assert.fail('unexpected uncertain ownership'),
  }, async (nonce) => {
    assert.deepEqual(nonce,new Uint8Array(16).fill(17)); events.push('challenge')
    return { challenge: document(3), exchangeProof: async proof => {
      assert.deepEqual(proof,new Uint8Array(116).fill(34)); events.push('proof'); return document(4)
    } }
  }, 1, new AbortController().signal)
  assert.deepEqual(events,['begin','read:1','challenge','document:3','read:2','proof','document:4','read:3'])
})
test('aborted in-flight GATT context work poisons ownership and sends no later document', async () => {
  const controller = new AbortController()
  let uncertain = 0, documents = 0
  const pending = exchangeUploadContext(core, {
    begin: async () => { controller.abort(); await new Promise(() => {}) },
    read: async () => snapshot(1),
    sendDocument: async () => { documents++ }, uncertain: () => { uncertain++ },
  }, async () => { throw new Error('provider must not run') },1,controller.signal)
  await assert.rejects(pending)
  assert.equal(documents,0); assert.equal(uncertain,1)
})
