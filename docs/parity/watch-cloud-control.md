# Watch SDK integration review

## Authoritative scope

The October 29 scope correction requires an SDK that customer developers can
call from their Apple Watch applications. The SDK provides watchOS-compatible
HTTP command calls and a primary Double Tap integration helper. Customers own
their applications, screens, account/login/refresh logic, device selection and
business state. A companion phone app, new Watch backend endpoints and device
network changes are not prerequisites.

Earlier exploratory source added an application controller, screen and durable
operation store. Those additions were removed before delivery. The example is
now only a customer-owned button binding. The request-header provider is an I/O
extension point, not an authentication implementation.

## End-to-end checklist

| Requirement | Source evidence | Status / remaining evidence |
| --- | --- | --- |
| Reuse existing commands | `WatchCloudClient.submit`, explicit start/stop JSON | matched in fixtures; live customer backend unverified |
| Read status without claiming commands | Bounded list or configured detail GET; metadata recovery | matched in fixtures; absent list entry remains unknown; no pending/ACK calls |
| Customer owns authorization | Optional per-request headers or existing HTTP transport | matched; no account model, login flow or token persistence |
| Preserve request identity | Codable intent, TTL and metadata correlation | matched in fixtures; live server/device expiry and idempotency unverified |
| watchOS-compatible distribution | Root product, release generator and source package | partial; manifest graph verified, watchOS/public build unverified |
| Gesture integration | `View.botaPrimaryHandGesture(isEnabled:)` and button snippet | partial; non-watch branch compiles, watchOS branch/physical Double Tap unverified |
| No SDK-owned business UI | No app/controller/journal targets | matched by source review; device/state DTOs only |
| Independent customer consumer | `tests/consumers/watch-control` | partial; source-package macOS compile/link passes, root artifact and watchOS gates unverified |
| Phone locked during operation | Existing device Wi-Fi/cellular HTTP path | unverified; requires customer app plus physical recorder/watch acceptance |

The root manifest and release generator export `BotaWatchControl` independently
of the binary-backed `BotaAppSDK` product. SwiftPM's parsed root manifest confirms
that the Watch target has no target dependencies. The native XCFramework and
Rust/C ABI are unchanged; no new watchOS binary slices are claimed.

SwiftPM nevertheless resolves the root package's declared native artifact even
for a source-only consumer. The current root pin, `v2.0.0-beta.23`, returned 404
when this integration was checked; the existing tag asset was also unavailable
through the authenticated release lookup. No pin, version or checksum was
substituted to make this look like a successful public consumer.

Pre-release CI uses `test-watch-root-consumer.sh` after the native Apple build:
it copies the root product/target graph and both source trees, replacing only
the binary URL/checksum with the same-checkout local XCFramework location.
It builds an external consumer for macOS and watchOS device/simulator.
After publication, `test-remote-consumer.sh` also invokes the Watch consumer
through the real exact-version package URL, without that substitution.
Neither CI path had run at the local review checkpoint. PR checks must establish
hosted build results; no release or hardware success is implied here.

## Review method and verification

Review follows the repository's compound-engineering requirement, comparing
the SDK-only scope and the authoritative design with source and test evidence.
Checks cover explicit routes/actions, request-ID reuse, deadline expiry, device
response mismatch, HTTPS/path validation, malformed customer headers, sanitized
HTTP failures, raw state preservation and read-only recovery. Additional checks
cover detail-query identity, bounded list lookup, typed transport errors,
cancellation during header preparation and URLSession-style task cancellation.
A successful
command request is not promoted to a successful recording by the SDK.

Two regressions were reproduced before fixing: a newly created minimum-TTL
intent was immediately rejected by flooring the remaining interval, and a
cancelled transport's `URLError.cancelled` became `networkUnavailable`.
TTL is now rounded up by less than one second to the existing whole-second
server contract, and task cancellation is checked before translating errors.
The local deadline still does not override server/device expiry semantics.

Local verification: 19 Swift contract groups, external source-package macOS
consumer, six Swift package generator checks, parsed root-manifest dependency
isolation, strict Swift formatting and shell syntax. The host has command-line
tools only, so watchOS device/simulator, live networking and physical gesture
tests remain unverified. CI source includes those compile gates; workflow edits
alone do not establish hosted execution or public package availability.

Expanded release-tool verification initially passed 223 of 224 checks; the
legacy Android fixture check failed because `JAVA_HOME` was unset and passed
when rerun with the installed JDK 17. Two attempts to complete the locked npm
installation then failed with connection reset/read timeout. A subsequent broad
run and the dependency-license recheck could not complete against that partial
installation. The final complete tooling/license gate remains unverified;
the six dependency-free package-generator checks pass on the final source.

## Pre-PR review

The October 30 review fast-forwarded the branch to main `f4df2a37` and rechecked
the SDK-only scope, cloud request/response shapes, cancellation, bounded lookup,
dependency isolation and CI/release entry points. No blocking source findings
remained. Existing backend command validation and dashboard/public controllers
were inspected for explicit start/stop, metadata preservation, idempotency,
TTL, command-list and state response compatibility; this was a source comparison,
not a live backend test.

On that base, all 19 Swift groups, the external source-package consumer and six
package-generator checks passed again. Strict Swift formatting, shell syntax
and whitespace checks passed. The watchOS, full dependency/tooling, public asset
and physical acceptance gaps above remain open and must not be represented as
successful PR or release qualification.
