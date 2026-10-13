# React Native JavaScript runtime 0.1.0-beta.0 preflight

The owner requested continuation after the Rust-generated RN migration was
verified and pushed. This prepares publication of only
`@bota.dev/react-native-app-sdk-runtime@0.1.0-beta.0`; the synchronized native
family remains the immutable published beta.15. No native family tag, environment
policy or existing package channel is changed by this preparation.

## Candidate and delivery boundary

The generated engine's input provenance remains
`0b81ddad0fe950671153010902a96401eb52c83da107630b9b3d52490069e01c`.
Migration source `ee866d21` passed all nine main CI jobs in
[38371201617](https://github.com/bota-dev/app-sdk/actions/runs/38371201617) and
[License Gate 38371201665](https://github.com/bota-dev/app-sdk/actions/runs/38371201665),
including exact canonical regeneration, 91 Rust/JS RPC comparisons and 447
pinned Hermes 0.17 VM checks. This is historical source evidence; the final
publication-controller revision and its exact successful main CI/License must
also be checked before promotion. Fresh candidate hashes/run IDs are recorded
after that run, rather than guessed from a local repack.

The main-only manual workflow promotes the exact CI runtime archive and retains
`release-approval` followed by `release`. It does not rebuild after approval.
Publication authenticates through the runtime's own npm trusted publisher;
the first exact-version bootstrap uses the owner's interactive npm login because
the package does not yet exist. Temporary authentication remains outside source
and CI secrets. No placeholder package version is used.

## Requirement and evidence review

| Requirement | Verification | Preparation status |
| --- | --- | --- |
| Independent version and publication | Separate main-only workflow and strict 0.x beta identity | Implemented; protected execution pending |
| Exact tested source/archive | Main push CI/License, repository/run/artifact ownership, ZIP and tarball hashes, bounded archive/metadata validation | 22 promotion tests and real GitHub archive replay pass; final hosted controller check pending |
| Single existing human approval | Verified artifact precedes `release-approval`; publisher retains `release` and OIDC | Structural review; actual approval pending |
| Immutable registry publication | Only 404 authorizes upload; occupied version and downloaded tarball must match; uncertain writes preserve all channel checks | 18 mocked-registry tests pass; public upload/readback pending |
| Channel preservation | All four current/retired RN/Web package tag maps stay unchanged; runtime beta advances to the candidate | Local tests; live verification pending |
| First runtime namespace | Initial latest may remain absent or be created only at the exact first candidate; existing latest never moves | Reviewed initial-publication rule; live verification pending |
| Public consumer | Fresh installed generated client with native/WebAssembly rejected; strict public declaration compilation | Local packed client and strict TypeScript consumer pass; public registry install pending |
| App OTA and physical behavior | Installed compatible OS ports required; no recording decryption in app/SDK | Source contract only; app delivery and physical acceptance unverified |

Workflow syntax and protected ordering are checked directly because the bundled
generator skill's referenced validator/reference package is unavailable locally.
YAML parses with unique keys; three protected-workflow checks and 83 focused
new/adjacent release tests pass. The companion build, four package checks and
four-package license scan pass. A fresh reviewer found no actionable integrity
defect and replayed the original successful CI artifact through the strict
ZIP reader (203 regular package files); this historical replay verifies format
compatibility, rather than approving those old bytes for the new publication.
The existing CI and License jobs remain intact. First-publication account
authentication and the protected review are prerequisites to execution, not
evidence of a published artifact.

Current npm staging supports new packages through a public `0.0.0-stage`
placeholder, contrary to the older repository wording. This workflow publishes
the reviewed version directly. See [npm staging](https://docs.npmjs.com/staged-publishing/)
and [trusted publishing](https://docs.npmjs.com/trusted-publishers/).
