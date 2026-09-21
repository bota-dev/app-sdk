# Task 10 Report: Recoverable Web Firmware Update

## Status

DONE

- Starting HEAD: `2c6256e2be283b9caf42ffecf268de52c4cc5970` (verified clean).
- Commit subject: `feat(web): add recoverable firmware update`
- Trailer: `Co-Authored-By: OpenAI Codex <noreply@openai.com>`
- Scope stopped at Task 10. Task 11 was not started.

## Implementation

- Added `OTAManager` with `updateFirmware`, `resumeFirmwareUpdate`,
  `cancelFirmwareUpdate`, monotonic typed progress, and client composition.
- Added stable firmware image/provider contracts. Only image identity, integrity
  metadata, opaque blob/download identity, and workflow checkpoints are durable;
  provider URLs and headers remain operation-local.
- Streams response bodies directly to OPFS in at most 64 KiB writes. HTTP
  status, optional `Content-Length`, exact final length, Rust-backed SHA-256,
  and CRC32 are checked before Rust can issue a GATT write. Firmware reads are
  one bounded, safe-integer OPFS read per Rust effect.
- Revalidates and reuses compatible verified blobs after reload. Incomplete
  artifacts restart at byte zero with a fresh provider request. Incompatible
  journal/checkpoint identity fails before provider or GATT work.
- Reboot recovery uses `getDevices()` and only the browser device ID captured by
  the verified connection. It never opens the picker or probes a same-name
  device, including after a fresh runtime/manager reload.
- Cancellation joins provider, fetch, reader, storage, GATT, subscription, and
  authorized-device enumeration work before releasing mutation ownership. It
  rereads latest durable state and preserves a compatible verified artifact.
- Successful cleanup deletes the Rust checkpoint, OPFS blob, then firmware
  journal. Integrity failure removes the untrusted blob while retaining stable
  journal identity for fail-closed recovery.
- `firmwareUpdate` now requires authorized-device reconnect in addition to Web
  Bluetooth, durable storage, and fetch.

## Files Changed

- `.superpowers/sdd/2026-09-17-web-sdk-foreground-workflows/task-10-report.md`
- `AGENTS.md`
- `ARCHITECTURE.md`
- `docs/superpowers/specs/2026-09-17-web-sdk-foreground-workflows-design.md`
- `frameworks/web/README.md`
- `frameworks/web/src/otaManager.ts`
- `frameworks/web/src/__tests__/otaManager.test.ts`
- `frameworks/web/src/workflowRuntime.ts`
- `frameworks/web/src/deviceManager.ts`
- `frameworks/web/src/__tests__/deviceManager.test.ts`
- `frameworks/web/src/capabilities.ts`
- `frameworks/web/src/__tests__/transport.test.ts`
- `frameworks/web/src/providers.ts`
- `frameworks/web/src/models.ts`
- `frameworks/web/src/client.ts`
- `frameworks/web/src/index.ts`

## RED Evidence

The OTA test suite was added before production implementation:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test frameworks/web/src/__tests__/otaManager.test.ts
Result: expected failure, ERR_MODULE_NOT_FOUND for
frameworks/web/src/otaManager.ts.
```

## GREEN Evidence

All Node commands used Node `v22.23.2`.

```text
node --test frameworks/web/src/__tests__/otaManager.test.ts
Result: PASS, 29 passed, 0 failed, 0 cancelled, 0 skipped after the final
provider-error normalization change.

npm test --prefix frameworks/web
Result: PASS, 318 passed, 0 failed, 0 cancelled, 0 skipped.

npm run type-check --prefix frameworks/web
Result: PASS, TypeScript completed without errors.

npm run build --prefix frameworks/web
Result: PASS, ESM JavaScript, declarations, and WASM asset emitted.

git diff --check
Result: PASS, no whitespace errors.
```

## Coverage

Automated tests cover capability-first failure; ephemeral provider secrets;
HTTPS and deterministic loopback policy; status, size, SHA-256, and CRC32
validation; bounded OPFS streaming and reads; verified reuse and incomplete
restart; Rust-owned device rejection and CRC errors; live and reload reboot
reconnect; exact authorized-device selection; success cleanup order; late
provider, durable-save, subscription, and `getDevices()` cancellation races;
late-progress rejection; and incompatible image/checkpoint rejection before
GATT.

## Documentation Impact

Changed-token searches covered `internal-docs/`, public `docs/`, the approved
plan/spec, and repository `AGENTS.md`, `ARCHITECTURE.md`, and `README.md` files.
Tokens included `OTAManager`, `updateFirmware`, `resumeFirmwareUpdate`,
`cancelFirmwareUpdate`, `FirmwareDownloadProvider`, `firmwareUpdate`,
`network_download`, and `firmware_blob_read_chunk`. The Web README,
architecture, agent guidance, and capability design text now describe the
implemented foreground OTA surface and exact reconnect requirement.

## Deferred Evidence And Caveat

- No physical Chromium/Web Bluetooth transfer, device reboot/reconnect, or
  firmware-version readback was performed. No physical-device claim is made.
- No real backend firmware resolver, presigned URL, CDN redirect, or production
  OPFS/IndexedDB browser profile was exercised. Tests use deterministic external
  boundaries and the real Rust/WASM workflow and integrity helper.
- The implementation is foreground/page-owned only. It deliberately adds no
  worker, service-worker, closed-tab, or picker-fallback behavior.
- No push, merge, tag, publish, or Task 11 work was performed.
