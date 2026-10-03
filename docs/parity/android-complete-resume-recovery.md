# Android encrypted-v2 completed-resume recovery

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
failed with `unexpected_event`. This physical metadata establishes the complete
resume condition, not a BLE packet trace. Firmware source and the host control
regression establish the manifest-first sequence and intake mismatch.

## Change and design review

Only a validated `ResumeAccepted` whose `nextCiphertextOffset` equals the
request's expected ciphertext length selects the manifest intake phase. The
transition happens before the control-acceptance gate releases queued packets.
Existing session, recording UUID/generation, checkpoint revision, offset,
prefix hash and negotiation checks run first. Fresh START and partial RESUME
keep their window phase; unsolicited manifest and complete-resume DATA or
WINDOW_END remain invalid. Cancellation and transport ownership are unchanged.

| Requirement | Implementation and evidence | Status |
| --- | --- | --- |
| Resume completed ciphertext without another window | `acceptCompletedResume` after `validateResume`, before `controlAccepted`; manifest/EOF regression | Matched in host test |
| Reject packets outside the validated phase | Fresh/partial manifest and complete-resume DATA/WINDOW_END rejection cases | Matched in host test |
| Preserve exact identity and checkpoint validation | Existing validation precedes the transition; full control suite retained | Matched in source and host tests |
| Preserve signed receipt/CONFIRM and native journal cleanup | No receiver, backend, host cleanup or authorization changes | Matched in source; patched physical recovery unverified |
| Avoid an unnecessary Apple change | Apple uses its notification reader without the Android intake window gate | Matched in source review |
| Recover a real interrupted published recording | Existing physical checkpoint matches the condition; candidate native binary still needed | Unverified for this patch |

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

Independent source review found no phase-ordering or validation bypass. Full
source CI, License Gate, a source-built native candidate and physical recovery
of the retained recording remain required before release qualification.
Candidate beta.12 also includes the previously merged connect/MTU cleanup;
it does not establish a fix for every GATT 8/133 failure. New native application
binaries are required; an OTA JavaScript update cannot install this fix.
