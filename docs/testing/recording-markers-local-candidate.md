# Recording markers: local candidate validation, October 10

This checkpoint validates the current unpublished BATCH source. It is not a new
SDK release and does not establish STREAMING, mobile target builds or physical
acceptance. Package metadata remains `2.0.0-beta.14`, an already published version.
The local snapshot must never replace that release or be uploaded to a registry.

## Refreshed scalar-status snapshot (same day)

After adding the native protected STREAMING read API, rebuilt and packed with
npm 12.0.2 into a fresh temporary directory. All **259** archive files match
current source; an independent fresh consumer installed the archive with scripts
disabled. Installed hashes and lockfile SHA-512 integrity match. TypeScript verifies
both BATCH and the new status API, including revision `0` and exact decimal owner
epochs; numeric epochs and signed-document `markersRequired` are rejected.

Archive SHA-256: `01b9fae80e32bc23d964a10625c881a126ff0ed856000657786c1db58bc18311`.
Evidence: `/private/tmp/markers-status-candidate/{snapshot-manifest.json,consumer-validation.json}`.
This remains an explicitly nonpublishable dirty-source snapshot, using unchanged
beta.14 metadata. No registry upload or native target build is implied. The prior
250-file snapshot and 187-test checkpoint below are historical; current RN checks
pass 197 tests, Android JVM 96 and Apple host 21.

### 同日更新：状态读取 API 快照

新增原生 STREAMING 状态 API 后重新构建并使用 npm 12.0.2 打包，259 个文件均与
源码一致。全新临时 consumer 关闭脚本安装后，逐文件哈希与锁文件完整性匹配；
TypeScript 验证 BATCH 和新状态 API，并拒绝丢精度的数字 epoch/非法标记字段。
上方 SHA-256 标识当前快照；保留 beta.14 元数据并明确禁止发布，未替换公开版本。
旧 250 文件/187 测试证据属于历史检查点，当前 RN 197、JVM 96、Apple host 21
通过；目标原生构建仍需配套环境。

## Verified source and packaging

- Rust workspace: 287 tests passed across 52 test-result groups; no failures or
  ignored tests. Workspace Clippy with all targets/features, formatting and
  generated protocol checks passed.
- React Native `npm run verify`: 187 tests, TypeScript, codegen and license gates
  passed. The license gate scanned 410 packages.
- Release tooling: 147 tests passed. The existing beta.14 release-manifest schema,
  and the frozen React Native API contract/metadata validation used by CI passed.
  These metadata checks do not turn the dirty working tree into a release candidate.
- The CI-pinned npm 12.0.2 pack command produced an archive with 250 regular files.
  Each file matched the current package source byte for byte; npm SHA-1/SHA-512
  metadata and an independent SHA-256 inventory were checked. Two local pack runs
  produced identical bytes. The archive includes the built JavaScript, public
  declarations, generated native contract, and Android/Apple managed providers.
- Archive SHA-256:
  `2e45cbc48c8105222ce34bd5404347e3ae6e02d3cec7775e806ad12ee2c8a3e0`.
  The separate snapshot manifest labels the source tree dirty and the archive
  nonpublishable. A Git HEAD value alone does not identify these uncommitted bytes.
- A fresh temporary consumer installed the tarball with scripts disabled, using
  published React 19.2.3 / React Native 0.86.3 dependencies. Its lock retained the
  exact archive integrity; all 250 installed file hashes matched, and the SDK was
  a real installed directory rather than a sibling-source link. TypeScript passed
  for public marked/ordinary recording and managed-backend options, including an
  expected error rejecting a signed-document string as `markersRequired`.
  This is package/type-consumer validation, not a native runtime/build result.

Relevant repeatable checks, from the repository root unless indicated:

```sh
cargo test --workspace
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo fmt --all -- --check
cargo xtask protocol generate --check
npm run verify --prefix frameworks/react-native
npm run test:release
node tools/baseline/react-native-api-contract.mjs validate \
  --contract protocol/baseline/react-native-public-api-0.0.65.json \
  --baseline-metadata protocol/baseline/react-native-sdk-0.0.65.json
cargo xtask release validate release/examples/2.0.0-beta.14.json
# Run inside frameworks/react-native; use a fresh local output directory.
npx --yes npm@12.0.2 pack --json --pack-destination "$CANDIDATE_DIRECTORY"
```

The developer-host checks used Node 26.8.2, Rust 1.98.0 and JDK 17 where required;
CI selects Node 22. Local checks supplement exact-revision CI, not replace it.

## Remaining build gates

The local host has Command Line Tools but no Xcode application or `iphoneos` SDK.
It also has no configured or conventionally installed Android SDK. Full Android
AAR/APK and Apple XCFramework/iOS consumer builds were not run. The canonical
native release packagers also require a clean source tree; that gate was retained.

The checked-in CI provides an Ubuntu Android lane with API 26/35 consumers and
macOS 15 Apple lanes, including the pinned Xcode toolchain. Reading that workflow
does not prove hosted execution for this snapshot. No workflow, deployment, tag,
package publication or Demo dependency change was initiated by this checkpoint.

## 中文：10 月 10 日本地候选验证

本记录验证当前尚未发布的 BATCH 源码，不代表新 SDK 发布，也不证明 STREAMING、
移动目标构建或实机验收。版本仍是已发布的 `2.0.0-beta.14`；本地快照不得覆盖该版本，
也不得上传到 registry。

已通过 Rust 工作区 287 项测试（52 组结果，无失败或忽略）、全部 target/feature 的
Clippy、格式及协议生成检查。React Native verify 通过 187 项测试、TypeScript、
codegen 和许可检查，许可门禁扫描 410 个包。发布工具 147 项测试、beta.14 manifest
schema，以及 CI 使用的冻结 RN API 契约与 metadata 检查通过；它们不代表未提交源码
已满足发布条件。

使用 CI 固定的 npm 12.0.2 打包得到 250 个普通文件，逐项与当前源码比较字节，
验证 npm SHA-1/SHA-512 和独立 SHA-256 清单。两次本地打包字节一致；包内包含构建
后的 JavaScript、公开类型、原生生成契约及 Android/Apple managed provider。
包 SHA-256 为上方相同值；独立 snapshot manifest 明确标记 dirty source 和禁止发布，
不能仅用 Git HEAD 表示这份未提交快照。

独立临时 consumer 关闭安装脚本，从 tgz 安装 SDK，依赖公开 React 19.2.3 /
React Native 0.86.3。锁文件保留精确 archive integrity，250 个安装文件哈希全部
匹配，SDK 为实际安装目录而非 sibling source 链接。公开打标/普通录音类型和
managed backend options 的 TypeScript 检查通过，并确认 markersRequired 不能
传入签名文档字符串。该结果证明包与类型消费，不代表原生运行或目标编译。

本机使用 Node 26.8.2、Rust 1.98.0，需要 Java 的检查使用 JDK 17；CI 使用 Node 22。
本机只有 Command Line Tools，没有 Xcode/iphoneos SDK，也没有配置或常规安装的
Android SDK，因此未运行完整 AAR/APK、XCFramework/iOS consumer 构建。原生正式
packager 的 clean source 门禁保持不变。现有 CI 提供 Ubuntu Android API26/35 与
macOS15 Apple 构建，但读取配置不等于该快照已经通过 CI；本次未触发 workflow、
部署、tag、发包或修改 Demo 依赖。
