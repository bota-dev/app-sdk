# Task 13 Report: Real Chromium And Web Package Release Gates

## Status

DONE

- Starting HEAD: `8acb4564721ac5158a62ec14ff984c943ad90b6e`.
- Fix round 1 reviewed HEAD: `afcf17a0cc05bd2c64f428374f983d7c0c4cc236`.
- Branch: `codex/web-foreground-workflows`.
- Commit subject: `test(web): gate foreground browser package`.
- Fix round 1 commit subject: `fix(web): harden packed release gate`.
- Commit trailer: `Co-Authored-By: OpenAI Codex <noreply@openai.com>`.
- Scope stopped at Task 13. Task 14 was not started.

## RED Evidence

Package inventory tests were added before their implementation and run with:

```bash
env PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test tools/web/verify-package.test.mjs
```

Result: FAIL as expected. Five of ten tests failed because the verifier did
not yet reject source/test leakage, unsafe archive paths, sensitive values,
SDK version drift, or npm CLI drift.

The six Playwright cases were then run against the unchanged Task 12 smoke
consumer. Result: 6 failed because the consumer did not yet expose the packed
foreground workflows and browser-test state.

The required pre-implementation commands also failed:

```bash
npm run web:verify
tools/web/test-browser.sh
```

`web:verify` passed all 365 Web unit tests before failing the new package
inventory tests. `test-browser.sh` did not exist yet.

A later verifier regression test exposed an additional binary-content gap:

```bash
node --test tools/web/verify-package.test.mjs
```

Result: 10 passed and 1 failed with `Missing expected exception` for an
absolute Cargo path embedded in a WASM payload. The verifier now scans every
package payload and the WASM build remaps workspace, Cargo, and Rustup paths to
stable relative prefixes.

Fix round 1 added the archive, publication metadata, exact WASM, and installed
package cases before implementation. The first expanded run reported 18 tests,
10 passed and 8 failed: exact WASM placement/content, archive links, special
headers/duplicates, PAX/GNU metadata, archive limits, malformed archives,
`private: true`, and related diagnostics were not yet enforced. The subsequent
installed-package comparison test reported 18 passed and 1 failed because
`verifyInstalledPackage` did not yet exist.

The focused Chromium destroy test also failed before its implementation:

```text
Expected: 1
Received: 0
```

That failure proved the log subscription had been manually removed before
`destroy()` instead of exercising client-owned teardown.

## Implementation

- Pinned `@playwright/test` to exactly `1.63.0` in the disposable Vite
  consumer and installed only Playwright Chromium under
  `target/playwright-browsers`.
- Replaced the smoke page with a production-package consumer that imports only
  `@bota.dev/web-sdk`, loads its packaged ESM/WASM, and exposes deterministic
  foreground controls for the browser gate.
- Added a pre-load fake Web Bluetooth/GATT surface and OPFS-compatible durable
  file surface. Chromium's real IndexedDB remains in use.
- `tools/web/test-consumer.sh` now builds, packs once with npm 12.0.2, verifies
  once, writes release evidence, installs only that tarball path into a clean
  consumer, builds with Vite, and passes the same tarball to the browser gate.
- `tools/web/test-browser.sh` rejects a missing, ambiguous, or symlinked
  package installation and compares every installed regular file against the
  verified inventory without extracting the archive or following links.
- Package verification uses the pinned maintained `tar@7.5.22` parser in
  strict mode and rejects links, unsafe link targets, non-file headers,
  duplicate/unsafe paths, PAX/GNU metadata, malformed/truncated input, and
  bounded entry/count/expanded/compressed-size violations before package reads.
- Package verification also rejects missing/multiple/renamed/invalid WASM,
  including anything other than the exact generated path and WebAssembly
  magic/version, plus source maps, tests, source, machine paths, credentials,
  `private: true`, version/package-manager drift, invalid ESM exports, and
  non-public publication metadata.
- The generated inventory records source revision, package metadata, raw
  tarball SHA-256, normalized content SHA-256, and each file's size and SHA-256.
- CI and tag workflows install only Chromium, assert the inventory source
  revision, and upload `target/web-release` unchanged. Protected npm OIDC
  publication and recovery verify the preserved inventory/tarball identity and
  retain the `beta` dist-tag.

## Browser Cases

All seven cases pass in Playwright Chromium 1.63.0:

1. A programmatic click is rejected without trusted user activation; a real
   click exercises `requestDevice`; a wrong serial fails; the exact serial
   connects.
2. Disconnect plus authorized reconnect uses `getDevices()` for the persisted
   exact device and does not call the picker again.
3. GATT notifications publish exactly one decoded WiFi status update and one
   decoded device-log line.
4. A live log subscription remains installed until `destroy()` owns its
   cleanup; the active listener count changes from one to zero and replaying
   the historical callback cannot publish a late line.
5. A staged recording upload persists through real IndexedDB and the
   OPFS-compatible fake, survives reload, reconnects without a picker, uploads
   exactly 9 bytes, completes cloud confirmation, and sends one device confirm.
6. Destroy suppresses a late provider completion; no upload or confirm occurs
   before reload/resume.
7. Missing Bluetooth and missing durable storage each expose their exact
   storage-only or Bluetooth-only capability matrix.

The fake `navigator.bluetooth` is installed with `page.addInitScript()` before
page load. `requestDevice()` checks both active user activation and a trusted
DOM event, and the accepted calls originate from Playwright locator clicks.

## Package Evidence

Both final clean runs produced one package with this identical evidence:

```text
package: @bota.dev/web-sdk@1.2.0-beta.1
package manager: npm@12.0.2
tarball: bota.dev-web-sdk-1.2.0-beta.1.tgz
tarball bytes: 354395
tarball SHA-256: d527fb80c117fdeabf884fc3383ef25b079741180cb13b50e4eeb4c627bac735
normalized content SHA-256: 618e2718215a6f2ff37db60c6e9794a1c01be5e45b9b80c82d7dfdc7adc5b8dc
inventory SHA-256: 1dbc85ff8507ff362dc25d79fa2be5343dd2289411ea1e091ccc6e0950e7c675
inventory entries: 52
WASM entries: 1 (package/dist/generated/bota_device_sdk_core_bg.wasm)
```

The 52 entries contain only `dist`, `LICENSE`, `README.md`, and `package.json`.
There are no source maps, tests, source trees, credential files/values,
workspace paths, dependencies, or additional WASM binaries.

Fix round 1's two pre-commit clean runs were bound to reviewed HEAD
`afcf17a0cc05bd2c64f428374f983d7c0c4cc236` and matched byte-for-byte:

```text
tarball SHA-256: d527fb80c117fdeabf884fc3383ef25b079741180cb13b50e4eeb4c627bac735
normalized content SHA-256: 618e2718215a6f2ff37db60c6e9794a1c01be5e45b9b80c82d7dfdc7adc5b8dc
inventory SHA-256: 7db66d12ab445902a0ec429ef63fc4b57edb3dfe5f87721146e799778f8f49eb
inventory entries: 52
```

The final two head-bound runs are intentionally generated after the fix commit
with no later tracked edits; their exact final revision and hashes are returned
to the operator rather than written back into this pre-commit report.

## GREEN Evidence

The complete gate was run twice with `target/web-release` removed between
runs:

```bash
env PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  npm_config_cache=$PWD/target/npm-cache \
  PLAYWRIGHT_BROWSERS_PATH=$PWD/target/playwright-browsers \
  npm run web:verify
```

Both runs passed:

- Web tests: 365 passed, 0 failed.
- Web typecheck: passed.
- Package verifier tests: 20 passed, 0 failed.
- Package build and verification: passed.
- Production Vite consumer build: passed from the installed tarball.
- Playwright Chromium: 7 passed, 0 failed.

`cmp` confirmed that `web-package-files.json` and its checksum file were
byte-identical across both runs. The raw tarball, normalized content, per-file
inventory, and inventory hashes matched exactly.

## Local-Only CI Validation

```bash
cargo test -p xtask --test release_readiness
# 31 passed, 0 failed

node --test tools/release/*.test.mjs tools/android/*.test.mjs \
  tools/flutter/verify-publication.test.mjs
# 64 passed, 0 failed

node --test tools/baseline/compare-workflows.test.mjs
# 16 passed, 0 failed

bash -n tools/web/build-wasm.sh tools/web/test-consumer.sh \
  tools/web/test-browser.sh
# passed

git diff --check
# passed
```

JSON parsing and explicit package assertions confirmed Playwright 1.63.0 in
both consumer manifest and lockfile, `tar@7.5.22` in the root manifest and
lockfile, npm 12.0.2 in the Web package, and exactly one release tarball. Ruby
Psych parsed both changed GitHub workflow files, and the Rust release-readiness
tests checked their release invariants. No remote workflow, publish, tag, or
deployment was triggered.

The broader `npm run test:workflows -- --sdk-path ../react-native-sdk` command
was also attempted. It reproducibly fails in unchanged
`core/device-sdk-core/tests/firmware_update_workflow.rs` because
`successful_reconnect_reads_back_the_target_firmware_version` reaches
`expected effect`. No Task 13 changed path participates in that test; the
focused workflow contract suite above remains green.

## Documentation Impact

Searches for `web:verify`, `web:browser`, `test-consumer.sh`,
`test-browser.sh`, `web-package-files.json`, `target/web-release`, Playwright,
and packed-consumer terms covered wrapper `internal-docs/`, public `docs/`, the
app-sdk documentation tree, and repository `AGENTS.md`, `ARCHITECTURE.md`, and
`README.md` files.

The affected app-sdk README, architecture, release guide, and AGENTS guidance
now describe the pinned Chromium install, strict no-extraction archive gate,
exact tarball consumer, installed-file comparison, deterministic WASM path
remapping, hashed release inventory, and unchanged protected release payload.
No public API or cross-system product design changed, so public docs and wrapper
internal product requirements did not need Task 13 edits.

## Physical And External Gaps

- No physical Web Bluetooth device was exercised. Picker, identity, reconnect,
  notification, and transfer boundaries use deterministic fake GATT objects in
  real Chromium.
- Chromium used real IndexedDB, but OPFS behavior used a deterministic
  OPFS-compatible fake. Real quota, permission revocation, and device-specific
  browser behavior remain acceptance work.
- Upload fetches and provider callbacks were deterministic local fakes; no Bota
  backend, object store, or live credential was contacted.
- GitHub-hosted Ubuntu execution, npm registry publication, OIDC exchange, and
  recovery against an external release were not run locally.
- No push, merge, tag, publish, remote CI/CD, subagent dispatch, global tool
  install, or user-level state change was performed.
