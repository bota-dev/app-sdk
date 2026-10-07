# October 7 follow-on tooling alerts

The live scanner added Critical #8 (`frameworks/react-native/package-lock.json`, shell-quote) and High #9 (`tests/consumers/web-vite/package-lock.json`, source-map-js) after the original 40-High snapshot. Npm-generated same-major updates select shell-quote 1.11.0 and source-map-js 1.2.2. The [shell-quote advisory](https://github.com/advisories/GHSA-pqg4-j6r4-53mv) fixes comment-following line-terminator injection; the [indexed-map advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) bounds excessive source-map offsets.

Root, React Native and Web consumer frozen installs passed. `node --test scripts/test-new-alert-security.mjs scripts/test-fast-uri-security.mjs tools/baseline/encrypted-upload-v2-vector-contract.test.mjs tools/release/release-manifest-schema.test.mjs` passed 15 cases. React Native typecheck/build and its 410-package license scan passed; root license scan passed for 21 packages. The [public registry receipt](2026-10-07-registry-verification.json) verifies downloaded integrity, MIT/BSD licenses and seven-day release age.

Web consumer build was attempted but its setup requires a prepared `@bota.dev/web-app-sdk` artifact; the dependency is absent in this local Windows checkout. Rust/Wasm preparation, hosted full CI, scanner closure, registry publication and native/device qualification remain separate gates. Historical Windows broad tooling/release failures are retained in the earlier review.

Design review: compatible source selection, crafted shell/offset rejection, normal quote/map behavior, frozen install, React Native compilation and license are **matched**. Hosted exact-source build and scanner closure are **unverified**. No release tag, native artifact, or consumer application binary is produced by this correction.


October 7 release-age correction: the first follow-on lock had selected shell-quote 1.12.0 despite this review naming 1.11.0. That version was only five days old. The final lock restores the npm-generated, parent-compatible 1.11.0 selection using the explicit npm 11.17 CLI and seven-day age filter. Ordinary shell updates do not downgrade an already locked younger version automatically. Verify the selected lock version against the receipt before reporting age conformance; the native/publication gates remain separate.
