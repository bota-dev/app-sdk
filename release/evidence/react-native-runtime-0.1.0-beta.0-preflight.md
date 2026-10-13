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
publication controller is `5749b487934daa13c357fd035ac815a9cef2711d`.
Its [main CI 38431556345](https://github.com/bota-dev/app-sdk/actions/runs/38431556345)
passed all nine jobs; [License Gate 38431556404](https://github.com/bota-dev/app-sdk/actions/runs/38431556404)
passed. The runtime job passed canonical regeneration, all 91 comparisons and
all 447 pinned Hermes checks on that exact revision.

The actual runtime artifact `11830833447` contains 203 package files:

- GitHub ZIP SHA-256: `bf44e9c5845bbafe72dba59419c759094b53cbe51e38d9c33d6408b9f25d3c6d`.
- Preserved npm tarball SHA-256: `7c433f3d6a8e0df7435f97d705298e992117c6c112edbda40fe39b090fa52d1c`.

[Release run 38434458215](https://github.com/bota-dev/app-sdk/actions/runs/38434458215)
passed exact CI promotion and preservation in job `115424727173`. It is waiting
for the existing `release-approval` review (`115424826558`); publication has not
started. A fresh local installation of these actual CI bytes passed generated
client configuration/destruction with native imports and WebAssembly rejected,
and strict public declaration compilation. This is an archive-consumer check,
not a public-registry consumer result.

The main-only manual workflow promotes the exact CI runtime archive and retains
`release-approval` followed by `release`. It does not rebuild after approval.
Publication authenticates through the runtime's own npm trusted publisher;
the first exact-version bootstrap uses the owner's interactive npm login because
the package does not yet exist. Temporary authentication remains outside source
and CI secrets. No placeholder package version is used. Resuming verification of
the occupied version proves public bytes and consumers without performing an
OIDC upload. Configure the grant near the next authorized absent-version release:
npm requires its first successful upload within two days. Configuration readback
alone does not qualify automated publication.

## Requirement and evidence review

| Requirement | Verification | Preparation status |
| --- | --- | --- |
| Independent version and publication | Separate main-only workflow and strict 0.x beta identity | Implemented; hosted promotion passed; publication pending |
| Exact tested source/archive | Main push CI/License, repository/run/artifact ownership, ZIP and tarball hashes, bounded archive/metadata validation | 22 promotion tests, exact nine-job CI/License and hosted archive promotion passed |
| Single existing human approval | Verified artifact precedes `release-approval`; publisher retains `release` and OIDC | Hosted run waiting for required reviewer; approval pending |
| Immutable registry publication | Only 404 authorizes upload; occupied version and downloaded tarball must match; uncertain writes preserve all channel checks | 18 mocked-registry tests pass; public upload/readback pending |
| Channel preservation | All four current/retired RN/Web package tag maps stay unchanged; runtime beta advances to the candidate | Local tests; live verification pending |
| First runtime namespace | Initial latest may remain absent or be created only at the exact first candidate; existing latest never moves | Reviewed initial-publication rule; live verification pending |
| Public consumer | Fresh installed generated client with native/WebAssembly rejected; strict public declaration compilation | Exact preserved CI archive consumer and strict declarations pass locally; public registry install pending |
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
