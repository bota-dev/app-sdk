# React Native JavaScript host

`contracts.ts` separates the generated shared Rust implementation from installed
OS capabilities. BLE, files, scoped durable persistence and registered network
requests are primitive ports; none invokes a complete native Bota SDK workflow.
Generated codecs and reducers own wire formats, identity, retry and recovery
decisions. Host code orders OS I/O and settles its exact resources.

`BotaJsHostExecutor` owns one operation at a time. Core callbacks retain the
operation, request, cancellation and increasing runtime generation. GATT I/O uses
one lane; timers and persistence are started independently so a blocked read
cannot postpone a core deadline. Cancellation and terminal completion join
submitted work and subscription teardown before replacement work is admitted.
Uncertain teardown retains ownership until destruction.
Explicit encrypted V2 sync reserves the existing bounded control FIFO, then
holds one executor owner through verified preparation, generated transfer and
joined cleanup. It adds no network retry; see the
[admission review](../../../../docs/parity/v2-workflow-admission.md).
Pending-catalog reads reserve the same FIFO and hold one direct lease through
their existing legacy/V2 body and subscription cleanup; see the
[catalog review](../../../../docs/parity/catalog-admission.md).
For reset, `beforeFactoryResetReceipt` joins the application's durable result
and binding-generation journal before the core receives `FactoryResetResultSaved`
and can request the receipt write. A failed callback never acknowledges that save.

`JsFileEffects` reopens files by scoped logical identity, truncates only to the
core-requested checkpoint, and returns append evidence only after durable host
completion. The host verifies final CRC32 before acknowledging finalization.
Firmware reads are bounded and preserve decimal 64-bit offsets. No file effect
authorizes deletion of the recording on the physical device.
Managed recording transfers use one opaque UUID for the durable queue task and
file sink, so admitted restart lookup reopens `recording/<task.id>`. Older tasks
whose sink used a different, unrecorded ID remain protected; this does not permit
reconstructing an opaque handle from an arbitrary local path.

Protected packet/material references stay opaque. The ordinary raw-byte core
event boundary does not yet represent an opaque provisioning/reset envelope or
protected transfer payload; accepting an opaque reference is not evidence that
the end-to-end generated-core path supports it. A missing protected primitive
fails closed. Never satisfy it by invoking a complete native SDK operation or
by fabricating document bytes. The material/secure boundary must be reviewed
before enabling those paths.

Focused source checks use the installed TypeScript compiler and Node tests in
`__tests__`; they exercise ownership, cancellation, deadlines, durable file
boundaries and scoped opaque handles. They do not establish publication,
installed-host durability, background execution, app OTA or physical BLE parity.
Run `node --test src/jsHost/__tests__/*.test.mjs` from the RN package; the tests
transpile the checked-in source in memory with the installed compiler.
