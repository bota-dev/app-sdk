# Recording-control notification correction — October 6, 2026

The legacy RecordingStatus characteristic carries two different messages: a
six-byte command result and an 18-byte `[active, initiator, uuid[16]]` snapshot.
The previous core decoder interpreted byte 5 of every long message as a result
code. For an 18-byte snapshot that byte belongs to the UUID, so valid activity
could produce an arbitrary recording-control error.

The shared Rust decoder now distinguishes the 18-byte snapshot before reading
result codes. Its activity flag must be 0 or 1. Six-byte known errors remain
errors, and an unknown explicit result fails instead of falling back to activity.
Android waits for a snapshot matching the requested Start/Stop activity, or an
explicit result; an unrelated snapshot cannot finish the request. Subscription
ordering, Stop pacing, timeout and subscription cleanup remain unchanged.

## Requirement review

| Requirement | Evidence | Status |
|---|---|---|
| Interpret released bytes by message layout | Rust tests cover both activity values and every UUID byte-5 value, plus explicit errors and invalid activity | Source regression added; hosted verification pending |
| Unrelated state cannot complete Android Start/Stop | Native tests send opposite activity before matching activity and before an explicit rejection | Source regression added; hosted verification pending |
| Retain released opcodes and authorization transport | Existing opcode, subscription/pacing and grant-error tests remain required | No public API or grant-format change |
| Physical device owns acceptance | An Android HCI trace observes Start followed about 49 ms later by a six-byte `already_recording` result with active=0; firmware separately repairs stale recording admission | Reproduced on installed Demo; corrected hardware acceptance pending |
| Durable exact-command result required by the target Remote Device Control design | Legacy record-scope grant and state snapshots remain compatibility behavior | Not implemented by this correction |

The 0.0.65 reference, its frozen comparison and existing canonical fixtures are
unchanged. This is an intentional decoder bug correction, not evidence that the
new edge cases match the old reference implementation. Android action filtering
does not establish equivalent host behavior on Apple or Web.

Source and hosted builds do not update the published beta.12 native libraries
inside the installed Demo. A new SDK publication, consuming app binary and
firmware installation are separate steps. An early active snapshot still does
not prove recorder-file creation or finalization; hardware acceptance must check
Start, Stop, a subsequent Start and the resulting valid recording file.
