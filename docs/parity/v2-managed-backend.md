# Managed encrypted-v2 backend adapter

Current source adds `createEncryptedUploadV2Backend` to the React Native App
SDK on iOS and Android. It packages the native HTTP/journal implementation
previously supplied by Demo. Publication and physical acceptance are separate
gates; beta.10 does not contain this helper. Existing custom native providers
remain supported. The Apple/Android material API gains an optional
`reconcileStaging` callback without changing the wire protocol.

## Customer integration

```ts
import { createEncryptedUploadV2Backend } from '@bota.dev/react-native-app-sdk';

const lifetime = new AbortController();
const uploads = createEncryptedUploadV2Backend({
  baseUrl: 'https://your-backend.example/v1',
  scopeKey: `${environment}/${accountId}/${projectId}/${endUserId}`,
  accountId, projectId, endUserId, environment,
  signal: lifetime.signal,
  getAccessToken: async signal => getCurrentAppAccessToken(signal),
});

// Use a freshly connected, authorized device and its v2 catalog entry.
// Invoke this same operation after reopening/reconnecting to resume its journal.
const { recordingId } = await uploads.sync(device, recording, {
  deviceId, bindingGeneration,
  onProgress: progress => showProgress(progress),
});

// On logout, project/account/device-binding changes, or host teardown:
lifetime.abort();
await uploads.dispose();
```

This removes custom native HTTP, status-polling and journal code from customers.
The host still supplies fresh app credentials, stable identity, scope
invalidation and the reconnect/sync trigger. Construct a new helper for a new
scope; an A → B → A account transition never revives an aborted helper. The
existing legacy `complete`/`uploadRecoveryProvider` callbacks do not select v2.
A package upgrade alone does not migrate an application using the legacy path.
A new native app binary is required for the added TurboModule.

The HTTPS base URL is the route prefix of the customer's authenticated proxy.
It must expose the existing Bota encrypted-v2 recording creation, session
create/status/recover/staging-url/manifest and device context create/status/proof
routes, preserving response bodies and status codes. The backend authorizes
the exact tenant, EndUser, device and binding; the app supplies an application
access token, never a Bota secret API key. The optional `organizationId` supports
the first-party dashboard bridge, whose base path is
`/dashboard/projects/{projectId}`. No Bota API schema changes are required.
An integration exposing only legacy upload-complete must add the v2 proxy routes.

## Recovery and completion

Native journals bind the backend origin/prefix, account/project/EndUser,
environment, device/binding and exact recording UUID/generation/length/hash.
The journal stores metadata and cloud identity, not credentials or signed
documents. Reopening and syncing the same recording reuses that identity and
queries the session. An ambiguous initial recording/session creation is parked
instead of issuing a potentially duplicate POST; automatic reconciliation of
that initial unknown outcome remains a backend idempotency gap.

Before any new ciphertext PUT, the SDK tries the exact manifest, then validates
the retained local file after the provider callback. An accepted manifest skips PUT. Only HTTP 409 with
`encrypted_upload_v2_staging_missing` permits PUT. Generic conflict, permissions,
transport failure and server failure do not prove the object absent. Already
staged/ready/processing/published sessions also skip PUT.

After manifest acceptance, native code polls session status every two seconds
for at most 60 polls. Each retry-safe request can make up to three attempts
with a 250 ms delay for transport/429/5xx failures. HTTP latency adds to the
polling window. Exhaustion retains recovery state and source audio; the host's
next sync/reconnect resumes. There is no OS background wakeup guarantee.
The firmware owns direct WiFi/4G retries independently.

V2 manifest acceptance is `202`; verification remains asynchronous. Recording
`pending` and session `ready`/`processing` are not deletion permission.
Publication sets recording `uploaded` and supplies the exact signed receipt.
Native SDK/firmware validate the receipt before CONFIRM/deletion; the backend
journal is removed only after native sync confirms success. App closure can
interrupt cleanup while cloud verification continues.

## Design and acceptance review

Reviewed against Upload Management §1.1 and Encrypted Upload v2. Tests are
listed here as requirements/evidence targets until CI has passed.

| Requirement | Evidence | Status / remaining check |
| --- | --- | --- |
| Small customer integration; app authentication stays scoped | Exported helper, native credential broker, eight JS integration cases | Local JS cases pass; linked native consumers pending CI |
| Reuse exact recording/session after interruption | Ported native journals and restart/nonce recovery suites | Native CI required; initial ambiguous create remains parked |
| Lost PUT response does not cause another upload | Native manifest replay tests and registry manifest/lease validation tests | CI and physical interruption checks pending |
| Account changes reject late work | Captured scope, AbortSignal, fresh credential requests, cancel/dispose tests | Local JS passes; native cancellation suites pending CI |
| Cloud commitment and device cleanup are distinct | Native receipt validation/CONFIRM unchanged; journal completion delayed | Host suites required; device power-loss qualification not run |
| No opaque artifacts or audio in JS | Metadata projection and native material registry | Codegen/type checks pass; packaged consumers required |
| Existing custom integrations remain valid | Optional native callback defaults to old decision provider | Existing suite and native CI required |

The first CI pass caught a file-check ordering regression: provider callbacks
can change the file, so validation must remain after the callback, including
when it skips PUT. The original tampering regression is retained unchanged.
The corrected candidate must pass it before release.

The change does not claim cross-channel deduplication, a new async API, physical
parity, streaming-v2, or release-gate enablement. The standalone Apple/Android
facades keep their custom-provider integration; this packaged HTTP convenience
entry point is currently React Native only.
