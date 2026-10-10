# Recording markers source integration

## Current native BATCH implementation

Android and Apple native hosts now consume marked catalog entries, assemble and
verify bounded 0x4a document streams before EOF, submit metadata after the audio
manifest, and require both completion receipts before kind-6 device confirmation.
Malformed, missing or changed metadata retains the native ciphertext file.
LIST opts in to marked entries and falls back to legacy only on explicit result 3;
ordinary 408/336-byte authorization/receipt behavior remains unchanged.

The managed native provider first GETs saved marker authorization, including
pre-manifest retries after new admission is disabled. Only an explicit 404 before
manifest acceptance permits POST admission. Conflicts and revoked access never
create a replacement. Marked authorization is 864 bytes; dual completion is 632.
START/CONFIRM hashes still bind the original audio prefixes. JS receives only the
optional scalar `markersRequired`; no signed documents or encrypted pages cross JS.

Validation uses real Kotlin receiver/registry/host code in the JVM harness, the
Apple managed provider, a standalone Swift host linked against the real Rust core,
RN bridge typechecking and RN contract tests. See the commands below. Android SDK
and Xcode/iOS SDK are unavailable on this host, so APK/iOS builds and physical
acceptance are not established. No package version, rollout gate or Demo native
dependency changed.

```sh
node tools/react-native/test-upload-backend-android.mjs
bash tools/react-native/test-upload-backend-apple.sh
python3 tools/apple/test-recording-markers-host.py
```

Demo now routes marked recordings through the managed SDK provider; ordinary
recordings retain its original adapter/journal. SDK publication and matching native
App binaries remain release gates. Protected STREAMING and its durable ACKs remain
separate development work. The current backend/firmware source implements marked
pre-manifest successor recovery, Wi-Fi/cellular switching and single-export-copy
repair; the native BLE provider regression below verifies its own successor and
channel fences. It does not establish cross-device integration or authorize BLE
adoption of a Wi-Fi/cellular owner. The physical WRGB adapter still needs hardware
facts. Demo playback source and backend recording-read APIs exist separately.

## 中文：当前原生 BATCH 实现

Android/Apple 已接入打标目录、有界 0x4a 重组校验、音频 manifest 后提交元数据、
精确双回执及 kind6 确认。缺页、乱序、篡改均保留密文文件。LIST 仅在明确 result3
时回退旧目录；普通 408/336 字节流程保持兼容。原生 provider 优先 GET 已存授权，
包括关闭新准入后的未提交 manifest 重试；仅明确 404 且尚未接受 manifest 才 POST。
864/632 字节打标文档保留原音频前缀哈希语义；JS 仅接收 markersRequired 元数据。

已验证 JVM 原生流程、Apple provider、链接真实 Rust 的 Swift host 和 RN 契约；
本机缺 Android SDK 与 Xcode/iOS SDK，尚无移动二进制或实机结论。
Demo 已将打标录音接入 SDK managed provider，普通录音保留旧 adapter/日志；
SDK 发包及匹配原生 App 二进制仍待验证。受保护 STREAMING 及持久 ACK 仍需开发。
当前后端/固件源码已实现打标未提交 manifest 的 successor 恢复、Wi-Fi/4G 切换与
单份导出修复；下述原生 BLE provider 回归验证其自身 successor 和通道隔离，
不代表跨设备集成通过，也不允许 BLE 接管 Wi-Fi/4G owner。实体 WRGB 仍需硬件事实。
后端播放读取与 Demo 播放源码另已接入。未发包、开启门控或改变 Demo 原生依赖。

## October 10 native BATCH successor review

| Requirement | Implementation evidence | Conformance / verification |
| --- | --- | --- |
| Restore exact child admission after owner recovery | Both managed providers persist the successor pointer, then GET that session's marker authorization at the selected owner revision | Kotlin and Swift tests expire a marked parent, recover revision 2, and verify exact 864-byte saved child authorization with no admission POST |
| Failed lookup must not reopen admission | GET-first admission permits POST only for explicit 404 in pre-manifest states | Both suites reject 403/409; added 503 and post-manifest 404 cases retain the journal and send no POST |
| Old owner or foreign channel cannot supply completion | Finalize validates the response session, owner, channel and ciphertext identity before exposing receipts | Both provider suites reject the prior owner's published response and Wi-Fi/cellular responses; no receipt or journal cleanup is permitted |
| Invalid marker proof must not complete | Canonical receipt length/hash checks precede receipt delivery | Both provider suites reject marker receipt/hash disagreement and retain the successor journal; this is a transport-integrity test, not signature verification |
| Stale native confirmation must preserve local state | Android host checks exact material registration and accepted audio-prefix receipt hash before cleanup or signed-blob delivery | Actual host regression rejects old material / old hash, retains ciphertext and checkpoint, then completes only with the accepted current receipt |
| Existing wire and compatibility remain stable | Marked bundles remain 864/632 bytes; ordinary bundles remain 408/336; absent and false `markersRequired` share legacy identity | Existing provider, receiver, catalog and host regressions run alongside the new cases |

The review found no production behavior change necessary in these provider paths.
The provider treats signed documents as opaque; device signature/context validation
remains authoritative. Passing a JSON response hash is not proof that an arbitrary
old signed receipt is safe. These checks do not establish STREAMING support, target
Android/iOS builds, package publication or physical acceptance.

Validation: Kotlin JVM provider/receiver/registry/host suite (95 tests), Swift
managed-provider host executable (20 suites). Tests exercise real provider source
with deterministic HTTP responses; the Kotlin suite also uses real loopback HTTP
servers for its transport cases. No rollout or publication occurred.

## 10 月 10 日原生 BATCH successor 对照审查

| 要求 | 实现证据 | 符合情况与验证 |
| --- | --- | --- |
| 恢复后读取精确子会话准入 | 两端 provider 先持久化 successor，再按子会话和 owner revision GET 打标准入 | Kotlin/Swift 覆盖打标父会话过期、恢复 revision 2，逐字节检查 864 字节子会话授权，无准入 POST |
| 读取失败不能重开准入 | 仅明确 404 且未提交 manifest 时允许 POST | 两端覆盖 403/409，新增 503 和 manifest 后 404，均保留日志且不 POST |
| 旧 owner 或其他通道不能提供完成证明 | finalize 暴露回执前验证 session、owner、channel 和密文身份 | 两端拒绝旧 owner published 及 Wi-Fi/4G 响应，不返回回执、不清理日志 |
| 错误打标证明不能完成 | 返回回执前校验长度及规范哈希 | 两端拒绝打标回执与哈希不符并保留 successor 日志；这是传输完整性测试，不是签名测试 |
| 过期原生 CONFIRM 保留本地状态 | Android host 清理或发送签名文档前校验精确 material 和已接受音频前缀回执哈希 | 真实 host 回归拒绝旧 material/旧哈希，保留密文及 checkpoint，随后仅当前已接受回执可完成 |
| wire 和兼容行为保持稳定 | 打标为 864/632 字节，普通为 408/336；markersRequired 缺省与 false 共享旧身份 | 同时运行已有 provider、receiver、catalog、host 回归 |

本次审查未发现这些 provider 路径需要修改生产行为。provider 将签名文档视为
opaque，设备签名及上下文验证仍是最终授权依据；JSON 响应哈希通过不代表任意旧
签名回执可安全使用。本次不证明 STREAMING、Android/iOS 目标构建、发包或实机验收。

验证：Kotlin JVM provider/receiver/registry/host 共 95 项，Swift managed-provider
主机程序共 20 组。使用真实 provider 源码和确定性 HTTP 响应；Kotlin 套件另含真实
loopback HTTP 传输测试。未开启门控或发包。

## Historical foundation checkpoint

The following checkpoints describe earlier source states; current native status is above.

The Rust core exposes candidate marker-body/header decoders and a bounded opaque
document assembler. Protocol facts come from `protocol/manifest/device-protocol.yaml`;
run `cargo xtask protocol generate --check`. Inner kinds allocate no GATT/CONTROL
or C ABI values and advertise no capability.

Marker media values remain u64 within signed-BIGINT bounds, preserving values
above JavaScript's safe integer. The decoder hashes the exact canonical body,
rejects invalid source/flags/reserved/UTC and never labels an event cloud-saved.
The assembler binds connection generation, transfer ID, expected kind, request
UUID, context, total length and local frame ceiling. It accepts exact duplicate
fragments, rejects gaps/changed duplicates, and exposes no document after final
identity mismatch. The caller destroys it on connection retirement. It cannot
decrypt HPKE fields or authenticate backend persistence/cleanup proofs.

Tests: `cargo test -p bota-device-sdk-core`, `cargo clippy -p bota-device-sdk-core
--all-targets -- -D warnings`, formatting and generated-file checks. The seven
new tests include shared backend/C body vectors and cross-connection/transfer,
wrong-kind, overflow, duplicate and context-mismatch cases. Test-first compile
failure was captured before adding production exports.

No native platform facade, HTTP workflow, C ABI, package version or Demo dependency
changed. No end-to-end/hardware or crypto interoperability acceptance is claimed.
MarkerAuthorization now uses the exact existing 16-byte recipient UUID and is
280 bytes. Runtime integration must wait for protected device admission/journal,
backend durable processing and final completion gates. Never send candidate inner
kinds through legacy BLE control opcodes or interpret reassembly as an ACK.

## 中文

本批在Rust core加入标记body/header解析及受限opaque分片重组，常量由manifest生成，
没有分配GATT/CONTROL/C ABI或宣告能力。保留u64精度，并校验连接代次、transfer ID、
预期kind、请求UUID、context、长度与本地上限。重复片段必须逐字节一致；最终身份错误
不会暴露完整文档。重组不能解密HPKE或证明云端保存、整条完成、允许删除。

新增7个用例覆盖跨端共享向量和重组边界，并运行core测试、clippy、格式及生成检查。
未改平台facade、HTTP工作流、包版本或Demo依赖；尚不具备端到端或硬件验收。
标记授权沿用16字节接收者UUID、总长度280字节；后续接入必须依赖固件受保护持久化与
后端事务/完成门槛，不能将候选内部kind当成旧BLE opcode发送。

## October 9 upload-owner integration follow-up

Source now connects marked BATCH files to the existing BLE admission/transfer
owner and Wi-Fi/cellular coordinator. Audio ownership is persisted before metadata
export so a reset cannot leave an exported admission with a consumed, unrecorded
nonce. The export MAC and first terminal write recheck the live signed context.
Exact persisted export/terminal recovery revalidates origin, identity and signatures.
Only the exact audio + metadata receipts, durably stored/read back in `.MCT`, permit
payload deletion. Payload deletion precedes sidecar cleanup. Missing or corrupt
proof retains the recording. `.MRK`/`.MXP`/`.MCT` also prevent legacy fallback when
an audio header is damaged. No capture or rollout gate was enabled.

Wi-Fi/cellular sends the immutable seal and pages as a bounded-memory JSON request,
retries the same owner, and requires both receipts. Dashboard metadata routes now
recheck current organization membership/project ownership and reset state inside
the storage transaction. Admission responses include the exact 176-byte context;
GET authorization recovers stored bytes without reopening new-admission policy.

BLE extension (candidate): LIST request_flags bit 0 opts into marked files;
legacy LIST=0 hides them. Catalog completion_state=2 means committed audio requiring
markers. Signed blob kind 5 is audio authorization408 + context176 + metadata
authorization280 (864 bytes); kind 6 is audio receipt336 + metadata receipt296 (632).
Metadata chunks (0x4a) precede EOF: common header12, document index u32@12,
document count u32@16 (seal plus pages, 2..4097), offset u16@20, document length
u16@22 (200..402), chunk length u16@24, zero u16@26, document SHA256@28,
opaque chunk@60. MTU bounds apply. Notification acceptance advances the cursor;
new START/RESUME retransmits final metadata. The Rust canonical registry, codecs
and private ABI support these frames. Existing native upload hosts do not yet
consume them, so this is not complete SDK/App support.

Local evidence: API 2,437 unit tests and 22 real PostgreSQL tests; firmware 195
v2 checks and 54 recording checks (one optional tool skip); SDK workspace tests
and eight marker tests. Target build/flash was not run under the macOS exclusion.

Remaining development: Android/Apple native hosts and managed provider, App
upload/playback, protected active-key STREAMING and its acknowledgements,
marked-session successor/channel-change recovery, and physical WRGB driver.
Partial/corrupt immutable export state is retained rather than regenerated;
recovery/repair policy still needs completion. WRGB part/pins/full-charge input
remain unavailable. These are development gaps, not only release testing.

## 10 月 9 日上传归属接线进展

已将打标 BATCH 接入 BLE 准入/传输 owner 与 Wi-Fi/4G 调度器。音频授权先持久化，
再生成元数据导出，避免 nonce 已消费但归属未落盘的断电窗口。导出 MAC 与首次终态
写入前重新检查实时签名上下文；恢复时重验原始归属、完整身份及签名。
只有精确音频与打标双回执完成 `.MCT` 持久化和回读后，才允许删除音频；随后清理
侧文件。证据缺失或损坏保留原文件。`.MRK/.MXP/.MCT` 存在时禁止退回旧上传。
未开启录音或发布门控。

Wi-Fi/4G 使用有界内存分块提交同一加密 seal/pages，等待双回执后清理。
Dashboard 元数据路由在事务内重查组织成员、项目归属与重置状态。
授权响应增加精确 176 字节 context；GET 可在停止新准入后恢复已保存的授权。

BLE 候选扩展：LIST request_flags bit0 显式请求打标录音，旧 LIST=0 不返回此类文件；
目录 completion_state=2 表示音频已提交且必须包含打标。blob kind5 为
408+176+280=864 字节准入，kind6 为 336+296=632 字节双回执。
EOF 前发送 0x4a：12 字节公共头，u32 文档序号@12、u32 总数@16（seal+pages，
2..4097）、u16 偏移@20、u16 文档长度@22（200..402）、u16 分片长度@24、
零 u16@26、文档 SHA256@28、加密分片@60。通知发送成功后推进游标；
新的 START/RESUME 重发元数据。Rust 注册表、编解码及私有 ABI 已支持；
原生上传 host 尚未消费，不能称为 SDK/App 完成。

本地验证：API 2437 单测及 22 PostgreSQL 用例；固件 195 v2 用例、54 录音用例
（1 项可选工具跳过）；SDK 工作区与 8 项 marker 用例。遵守 macOS 禁止完整目标
构建/烧录规则，尚无实机结论。

尚需开发：Android/Apple 原生 host、managed provider、App 上传/播放、受保护
活跃密钥 STREAMING 及实时回执、打标会话 successor/切换通道恢复、实体 WRGB。
不完整/损坏的不可变导出目前保留而不重建，修复策略仍待接通。WRGB 器件、引脚与
满电输入仍缺资料。以上是开发缺口，不只是发布验证。
