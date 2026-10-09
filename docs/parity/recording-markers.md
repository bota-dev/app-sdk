# Recording markers core foundation

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
