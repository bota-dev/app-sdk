# Connection deadline and late host IO

October 15 follow-up to the ordinary-control candidate. Normal Demo reconnect
fails with `unexpected_event` about 15 seconds after its attempt starts; later
normal retries fail without a verified connection. Destruction subsequently
reports `cleanup_incomplete`. No recording is requested in that round. These
observations do not prove the exact failed callback or Android ownership cause.

Source reproduction identifies a narrower defect. Reconnect can spend five
seconds scanning before selecting a same-name candidate when its stored
peripheral hint is stale. Each connection attempt has a separate ten-second
deadline. Rust moves a timed-out attempt into Disconnecting while the host
still joins its submitted Connect, DiscoverServices or serial Read. An exact
late success previously falls into `unexpected_event`; a late failure can also
advance or repeat cleanup before the original Disconnect acknowledgement.
Stored identifiers and names remain selection hints, never identity proof.

The correction remains Rust-sourced in `ConnectionWorkflow`. While
Disconnecting, it consumes only the single pending request's matching result
or failure. Connected/ServicesDiscovered and the Disconnect acknowledgement
must name the exact active peripheral. Wrong classes, foreign peripherals and
duplicate callbacks remain rejected. A late serial response does not verify
identity. Retired attempt callbacks cannot advance probing; the original
Disconnect effect must settle first, and successful acknowledgement checks its
exact peripheral. Existing disconnect-failure policy remains unchanged; host
`cleanup_incomplete` still prevents replacement work. Manual connection retains
its timeout result after that join.
No arbitrary unknown event is ignored and no OS/native contract changes.

| Requirement | Evidence | Status |
| --- | --- | --- |
| A deadline joins submitted IO before moving to the next candidate | New Rust cases cover manual/reconnect, three IO phases and success/failure; actual generated-core adapter holds Connect and exercises held/immediate Disconnect return | Matched in Linux Rust tests and adopted-core focused adapter tests |
| Exact request and physical identity remain enforced | Foreign-class/peripheral, duplicate completion and exact successful Disconnect acknowledgement cases | Linux Rust execution and strict Clippy pass |
| Failed cleanup cannot permit another probe or new control | Actual adapter cleanup failure preserves uncertain teardown and prevents the next candidate | Passes against preceding core and remains a required preservation regression |
| Shared behavior stays in generated Rust and native boundaries stay compatible | Rust reducer change only; pinned Linux generation verified/adopted byte-for-byte, unchanged OS-v1/native/wire contracts | Canonical source matched; exact new main/platform candidate checks pending |
| Physical acceptance stays separate | Earlier normal One settings writes pass; Demo fails reconnect and destruction in round 5 | Further normal app/device qualification required; no cloud/media/cleanup success claim |

The actual adapter happy-path regression fails against the preceding generated
core with `reconnect: unexpected_event`; its cleanup-failure regression already
passes. The direct generated-core event probe reproduces the same late-result
error. Local Rust connection tests compile with `--no-run` and strict Clippy
passes. Windows Application Control blocks execution of the new test binary;
no local native test-pass claim or policy bypass is made.

Source-only branch `ba69adc529b43cf61a28f098fb8d92beb505bd3b` runs the existing
build/check-only [CI 38812484749](https://github.com/bota-dev/app-sdk/actions/runs/38812484749).
Linux Rust/tooling job 116688885841 passes, including both new regression
groups. Its RN foundation deliberately retains the old generated core and
reports 503 passes and the one expected late-completion failure. Canonical
comparison also fails as expected; this run is not a green release candidate.

Diagnostics artifact 12008089998 has transport SHA-256
`00f38ed17b01ba90b265240eb769ea6de75025d6200d3e6ff6b18d79af6a181a`.
All 106 source/generator inputs match the exact branch commit. Its pinned
x86_64-unknown-linux-gnu Rust 1.98.0/Binaryen 132 output is adopted unchanged:
3,971,431 LF bytes, SHA-256
`a75a2c6a06c4306d496929260f804932fa50cd58d89f63ef21c7959be595695d`,
source SHA-256
`4f24ed3bb0cc0e03415e850bf6d117a935d821f87207cf463f5a74bc03b7b691`.
Compiler-free provenance passes. The actual adapter regressions now both pass,
including immediate and held Disconnect return; all 504 full RN tests pass.
Strict TypeScript, normal build, Codegen, package metadata and license
checks pass. The resulting isolated functional commit is `f5b3edb777f225b2db939611a6efeb7704464a3d`.
Its original beta.19 RN pack contains 500 hashed files; its SHA-256 is
`fe28ac203ccef8a90a1660549b3befcb6fd10224678257cb6813bfa6b41b9c69`.
This local Windows phone candidate is separate from the future main-CI archive.
Fresh exact-main CI/License/archive qualification and normal phone testing remain
required.
Beta.19 remains unpublished; preceding d13/fd409 qualification is separate.

Exact source-branch Apple job 116688885682 then passes, including its normal
Swift callers, device/simulator builds, binary slices and exact CocoaPods
archive lint. Artifact 12010190969 has independently verified transport digest
`e58e5252595fcb02b5103fc3d732db6b0d9d0770f50f4c4776cc0facaa52a2c3`.
The exact source/version manifest, both archive hashes and sidecars verify.
Existing public metadata generators update SwiftPM to archive SHA-256
`acb285bca52b584d1706929e3e2d8eba23f2cd9cf011be2fae3866115bfdfe30`
and CocoaPods to
`f8d4d70906d1b3022ecbe542c0b606d9d5cd0489c1dd07c4bf0152ada9883231`.
These are package preparation checks; final main artifacts must reproduce the
pins before any release tag or publication.

Normal round 6 Demo uses the exact packed f5b3/a75 core on firmware 1.0.19.
An initial auto attempt reports `device_not_found`; the normal device-page retry
then verifies the exact serial at MTU 512, raw model BOTA_DEV and binding
generation 3. Normal settings writes pass. Fresh supported reads show Idle,
pending 0, streaming=false and BLE > WiFi > cellular. Explicit UI disconnect,
normal reconnect and another settings write pass without a Bluetooth cycle.
Final SDK destruction joins successfully before force-stop. This bounded round
has no observed `unexpected_event` or busy settings failure; it does not prove
that the exact timed-out callback branch executed. No recording, model write
or firmware update occurs; broader recording/cloud acceptance remains open.
