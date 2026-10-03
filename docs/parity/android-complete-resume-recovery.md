# Native encrypted-v2 completed-resume recovery

## Requirement and failure

A retained encrypted-v2 transfer can already contain every ciphertext byte
while cloud verification and device cleanup are still pending. After exact
RESUME acceptance at that boundary, the device sends manifest and EOF without
another DATA/WINDOW_END pair. Cleanup still requires a signed receipt and
device CONFIRM; cloud publication alone does not authorize deletion.

Android's transfer intake previously always opened in its window phase.
`EncryptedUploadV2TransferControl` validated the accepted resume but did not
select the manifest phase at the complete ciphertext boundary. The next
manifest therefore failed with `unexpected_event` before backend reconciliation.

A supervised Android app interruption after cloud publication retained one
version-3 checkpoint whose offset equalled its ciphertext length. Restart
failed with `unexpected_event`. Bounded identity references also matched the
exact device, recording/generation, upload session, owner and ciphertext hash.
This physical metadata establishes the complete resume condition, not a BLE
packet trace. Firmware source and the host control regression establish the
manifest-first sequence and intake mismatch.

The first native candidate (`0e6e9a1`, with byte-identical tested payloads at
`72ca200`) was then installed over the existing Android app without removing
its journals. The retry reached `transferring` but failed with
`integrity_failed`; it did not complete recovery. The checkpoint retained
revision 34, offset/length 155960 and historical sequence 339. Every retained
ciphertext file still matched the expected length and SHA-256. Firmware source
resets DATA numbering to 1 for a new admitted RESUME and emits EOF sequence 0
when that attempt needs no DATA. Both native receivers instead compared EOF
and the next window against the previous attempt's saved sequence. Real
Android host/receiver regressions reproduce both complete and partial failures.
This cause is supported by source and tests, not an observed packet capture.

## Change and design review

Only a validated `ResumeAccepted` whose `nextCiphertextOffset` equals the
request's expected ciphertext length selects the manifest intake phase. The
transition happens before the control-acceptance gate releases queued packets.
Existing session, recording UUID/generation, checkpoint revision, offset,
prefix hash and negotiation checks run first. Fresh START and partial RESUME
keep their window phase; unsolicited manifest and complete-resume DATA or
WINDOW_END remain invalid. Cancellation and transport ownership are unchanged.

Android and Apple receivers now maintain an attempt-local acknowledged sequence.
After a validated resumed opening, and before pumping notifications, the host
resets that counter once to 0. A partial resume must then acknowledge sequence 1
onwards; a complete resume can prove EOF sequence 0. The receiver rejects a
second reset or a reset after receiving payload. Durable checkpoint revision,
offset, prefix and historical sequence remain intact until verified new progress
is persisted. Rejected-resume reconciliation uses its actual retried offset;
an offset-zero START retains its existing semantics. Apple rechecks cancellation
and generation after the receiver actor call before installing the transfer.
An exact duplicate active RESUME never creates another receiver or resets its
counter. All ciphertext, manifest, block-count, identity and receipt checks stay.

| Requirement | Implementation and evidence | Status |
| --- | --- | --- |
| Resume completed ciphertext without another window | `acceptCompletedResume` after `validateResume`, before `controlAccepted`; manifest/EOF regression | Matched in host test |
| Reject packets outside the validated phase | Fresh/partial manifest and complete-resume DATA/WINDOW_END rejection cases | Matched in host test |
| Preserve exact identity and checkpoint validation | Existing validation precedes the transition; full control suite retained | Matched in source and host tests |
| Keep attempt sequences separate from durable progress | One-time accepted-opening reset; full/partial host and receiver cases retain old checkpoint until verified save | Matched in Android and Apple host tests |
| Reject stale sequences and invalid completion evidence | Old sequence, ciphertext/manifest hash, manifest bytes, file, length and block-count cases | Matched in Android and Apple host tests |
| Preserve signed receipt/CONFIRM and native journal cleanup | No backend, host cleanup or authorization changes; corrected Android recovery retained the same receipt/owner and cleared both journals/device pending state | Matched in source and narrow Android physical test |
| Maintain Apple parity | Same sequence defect fixed; no Android intake gate added to Apple | Matched in source review and macOS tests |
| Recover a real interrupted published recording | First candidate failed its next integrity gate; corrected same-source Android binary recovered the retained full checkpoint and completed cleanup | Matched for the supervised Android case; Apple physical recovery unverified |

The current encrypted-v2 resume and delete-after-confirmation contract is the
acceptance basis; this change introduces no wire format, API or firmware gate.
Shared Rust workflow sequencing and opaque checkpoint bytes are unchanged.
See also [lost-WINDOW_ACK recovery](android-lost-ack-recovery.md) for the distinct
older-prefix reconciliation path.

## Verification and limits

The same 22-test control suite was run before and after the change. Before it,
the complete-resume manifest failed and complete-resume DATA was accepted:
two failures. With the fix, all 22 tests pass. Kotlin 2.1.20 compiled the actual
changed class and test source with warnings as errors against the released
beta.11 dependency classes and real CoreModelMapper/types. Transport/JNI packet
boundaries are fakes, so this proves host control behavior, not JNI or hardware.

The additional Android full/partial host regressions failed before the sequence
fix with `EOF integrity mismatch` and `malformed window`. They pass after it,
along with the strict receiver negatives. The full control case now also feeds
validated manifest/EOF into the real receiver with a retained file. Native
transport/JNI remains simulated; host tests use the validated-open service
boundary. Local full host execution additionally encountered Windows directory
fsync `AccessDenied` and its cleanup timeout in existing confirmation tests;
required Linux/macOS CI remains authoritative for those paths. Apple receiver
and host tests cannot execute on this Windows host; they passed in the exact
corrected-source macOS job below.
The final focused JVM run passes 34 tests: all 22 control tests, all eight
receiver tests, both accepted-resume host cases and the existing zero/nonzero
reconciliation and repair host cases. No production source was substituted to
work around the Windows confirmation limitation.

Independent review caught and corrected Apple's new actor-suspension ownership
gap; the host now fences generation/cancellation before installing its reader.
Historical source `0e6e9a1` passed all eight jobs in
[CI 37103546154](https://github.com/bota-dev/app-sdk/actions/runs/37103546154)
and [License Gate 37103548045](https://github.com/bota-dev/app-sdk/actions/runs/37103548045),
including the full Android native tests and API 26/35 consumers. Its verified
Android AAR and matching React Native package were used in the failed physical
candidate described above. Those checks do not cover the sequence correction.
Corrected-source CI, Apple artifact-derived pins, a new native physical retry,
final main CI and publication required the separate evidence below.

Corrected source `07c915ee635469ca2230a7b0e56cf3864fe5351c` passed all eight jobs,
including Android native/API 26/35, Apple package/consumer and Flutter, in
[CI 37108789844](https://github.com/bota-dev/app-sdk/actions/runs/37108789844).
All five targeted Apple complete/partial, stale/integrity, reset-guard and host
reload regressions explicitly passed. [License Gate 37108791793](https://github.com/bota-dev/app-sdk/actions/runs/37108791793)
also passed. The corrected AAR and matching React Native package have verified
artifact digests and source identities; Apple pins are regenerated from its
verified archives. Final pinned-metadata checks and the narrow Android physical
retry subsequently passed as recorded below.
Candidate beta.12 also includes the previously merged connect/MTU cleanup;
it does not establish a fix for every GATT 8/133 failure. New native application
binaries are required; an OTA JavaScript update cannot install this fix.

## Corrected physical recovery and main verification

The corrected Android Demo 1.0.11 APK used exact `07c915e` CI artifacts and was
installed in place, preserving the owner-revision-3 pointer and full checkpoint
(revision 34, offset/length 155960, historical sequence 339). After launch on
2026-10-03 at 08:42:27Z, the native backend-adapter pointer and SDK checkpoint store both cleared.
The actual app and an independent device read showed zero pending recordings;
direct WiFi/4G uploads remained disabled throughout recovery. Backend evidence
confirmed the same unique recording/session/owner, valid receipt and matching
streamed plaintext hash. Original cloud/device connection settings were fully
restored afterward, including all 12 setting bytes and streaming disabled.

Final pinned source `5da63b0` passed exact branch and main CI/License gates.
Main [CI 37111210813](https://github.com/bota-dev/app-sdk/actions/runs/37111210813)
and [License Gate 37111210790](https://github.com/bota-dev/app-sdk/actions/runs/37111210790)
are the annotated release inputs. All ten package payloads match corrected
`07c915e`; the official promotion verifier checked all 49 inventory files.

This is evidence for retained-published/full-checkpoint Android recovery and
receipt-gated cleanup. The cloud publication occurred before the interruption.
No physical packet trace or actual-app PUT count was recorded, and this does not
qualify Apple hardware, arbitrary OS scheduling or physical partial-resume
failure injection. Protected release `37112341485` attempt 2 subsequently
passed all five publications, public native consumers and the complete Flutter
archive check; see the [release evidence](../../release/evidence/2.0.0-beta.12-publication.md).
