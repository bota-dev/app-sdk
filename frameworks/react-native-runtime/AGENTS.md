# JavaScript-only React Native runtime

This package has no native autolinking, native dependency or Codegen module.
Workflow source stays in `../react-native/src`; the root packager compiles that
one implementation and emits portable structural adapter declarations here.
Never copy/edit workflow implementations or generated `lib` by hand.

Use an independent package version. The installed native adapter's version need
not match; it must fulfill version 1 method/event, identity and cleanup contracts.
This folder follows the existing facade convention of separate npm locks rather
than adding an npm workspace alongside Cargo/platform package managers.

Run `npm ci`, `npm run verify` and pack inspection. CI and License Gate must cover
this package. Publish/registry configuration and consuming-app OTA acceptance are
separate gates. Update README and the owning runtime design review after changes.
