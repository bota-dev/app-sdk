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
identity. Reconnect may try the next candidate only after exact Disconnect
acknowledgement; manual connection retains its timeout result after that join.
No arbitrary unknown event is ignored and no OS/native contract changes.

| Requirement | Evidence | Status |
| --- | --- | --- |
| A deadline joins submitted IO before moving to the next candidate | New Rust cases cover manual/reconnect, three IO phases and success/failure; actual generated-core adapter holds Connect and Disconnect separately | Source correction drafted; Linux execution/canonical adoption pending |
| Exact request and physical identity remain enforced | Foreign-class/peripheral, duplicate completion and exact Disconnect acknowledgement cases | Rust tests compile and strict Clippy passes; executable check pending |
| Failed cleanup cannot permit another probe or new control | Actual adapter cleanup failure preserves uncertain teardown and prevents the next candidate | Passes against preceding core and remains a required preservation regression |
| Shared behavior stays in generated Rust and native boundaries stay compatible | Rust reducer change only; existing pinned Linux generation route, unchanged OS-v1/native/wire contracts | Canonical generation and exact new candidate checks pending |
| Physical acceptance stays separate | Earlier normal One settings writes pass; Demo fails reconnect and destruction in round 5 | Further normal app/device qualification required; no cloud/media/cleanup success claim |

The actual adapter happy-path regression fails against the preceding generated
core with `reconnect: unexpected_event`; its cleanup-failure regression already
passes. The direct generated-core event probe reproduces the same late-result
error. Local Rust connection tests compile with `--no-run` and strict Clippy
passes. Windows Application Control blocks execution of the new test binary;
no native test-pass claim or policy bypass is made. Hosted Linux Rust execution,
byte-exact canonical generation/adoption, complete RN checks and fresh exact-main
CI/License/archive qualification remain required before release. Beta.19 remains
unpublished; preceding d13/fd409 qualification is retained as separate evidence.
