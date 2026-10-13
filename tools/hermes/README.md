# Pinned Hermes runtime conformance

`build-runtime.sh` builds the Linux Hermes CLI from React Native's
`hermes-v0.17.0` source commit
`829dcd74f5b774d19a86ab1dc47e3dee9e44d190`. It verifies the checkout, builds the
Release `hermes` target with debugger and Intl disabled, and records the binary
hash beside the executable. Source and build directories stay inside `target`;
the helper never deletes or force-resets a checkout.

Ubuntu dependencies: C++ compiler, `git`, `cmake`, `ninja-build`, `libicu-dev`,
`python3`, `zip`, `libreadline-dev`, and the repository's Node/npm dependencies.
See the pinned upstream [build instructions](https://github.com/facebook/hermes/blob/829dcd74f5b774d19a86ab1dc47e3dee9e44d190/doc/BuildingAndRunning.md)
and [CMake options](https://github.com/facebook/hermes/blob/829dcd74f5b774d19a86ab1dc47e3dee9e44d190/CMakeLists.txt).

```sh
bash tools/hermes/build-runtime.sh
HERMES_BIN="$PWD/target/hermes-runtime/829dcd74f5b7/build/bin/hermes" \
  node tools/hermes/conformance.mjs
```

GitHub Actions receives `HERMES_BIN` through `GITHUB_ENV`. Set
`HERMES_BUILD_JOBS` to change build parallelism; the default is two.

The conformance helper transpiles the committed generated Rust core into a
standalone JavaScript bundle with no native imports, Buffer, TextEncoder,
TextDecoder, or WebAssembly runtime. Its bounded u32 handle/RPC helper checks
UTF-8, canonical OTA bytes and device status, exact u64 generations, cancellation
identity, callback families, and stale handles. It compares the complete Hermes
runtime transcript with execution of the same bundle in Node's VM. Runtime mode
requires the pinned build's matching source and binary provenance.
The generated module uses one Metro-style factory wrapper. Compiler parser
limits remain at their defaults, so excessive generated control-flow nesting
fails this gate rather than being hidden by a flat test-only bundle.

`target/hermes-conformance/runtime-result.json` records the source, bundle and
binary hashes, version, and matched transcript. This establishes standalone
Hermes CLI execution. Installed React Native iOS/Android application delivery,
OS ports, scheduling and physical-device acceptance remain separate checks.

Local inspection modes preserve that distinction:

```sh
node tools/hermes/conformance.mjs --bundle-only
node tools/hermes/conformance.mjs --compile-only --hermes-bin /path/to/hermesc
```

The first runs only Node; the second also compiles Hermes bytecode but does not
claim VM execution. Neither may replace the runtime gate in CI. No shader,
Android SDK, Xcode SDK, application installation or device action is involved.
