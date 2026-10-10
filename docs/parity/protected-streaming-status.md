# Protected STREAMING status reader

## English

The unpublished React Native source exports `createProtectedStreamingStatusBackend`.
This is a read-only API: the public factory calls the managed native adapter,
which performs an authenticated GET through Android OkHttp or Apple URLSession.
Both production transports disable redirects. No protected START, marker relay,
audio upload, finalization, device confirmation or cleanup is added by this reader.

```ts
const lifetime = new AbortController();
const backend = createProtectedStreamingStatusBackend({
  baseUrl: 'https://api.example.com/dashboard/projects/proj_example',
  organizationId: 'org_example',
  signal: lifetime.signal,
  getAccessToken: async signal => getFreshApplicationToken(signal),
});
const metadata = await backend.getStatus({
  recordingId: 'rec_example',
  sessionId: '12345678-1234-4234-8234-123456789012',
  recordingGeneration: 1,
  writerEpoch: '1',
});
// On logout, workspace/environment/binding change or screen ownership loss:
lifetime.abort();
backend.dispose();
```

The GET path is `/recordings/:recordingId/streaming-status?session_id=:sessionId`
relative to the captured base URL. Use an application-authenticated read proxy;
never place a secret API key in a mobile application. The Dashboard route uses
existing organization/project recording-read permission. This does not grant
the separate device-token protected write authority.

The reader requires the exact known recording/session/generation/writer identity.
It rejects foreign owner responses, unsafe integer representations, extra fields,
impossible marker counts and malformed states. `writerEpoch` is a positive int64
decimal string; `revision` is a nonnegative int64 decimal string (initially `0`).
Counts are integers from 0 to 65535. `state: 'sealed'` means marker metadata was
sealed; it never establishes audio completion, publication or deletion permission.
An expired authorization can still be inspected without issuing fresh authority.

Native code bounds the returned body and allows only the expected scalar fields
across React Native. No keys, nonce, ciphertext, signatures or ACK documents cross
this interface. Cancellation is propagated by a request identifier, and results
are fenced again after credential refresh and native completion. No permission,
absence or server failure triggers a fallback upload or another owner selection.

### Design conformance and evidence

| Requirement | Implementation and verification | Status / remaining checks |
| --- | --- | --- |
| Public API reaches real HTTP provider | Public package entry factory, Codegen methods, Android and Apple adapter implementations; public entry test plus native provider HTTP fixtures | Source implemented; full target adapter builds remain required |
| Exact identity, revision and state parsing | Ten RN tests, including zero revision, int64 precision, stale identities and scope/dispose races | Host regressions pass |
| Native scalar boundary and no fallback | Android provider regression (96 total host tests); Apple provider regression (21 total host suites) | Pass with injected HTTP fixtures; no live server or physical-device claim |
| Preserve BATCH and cleanup proof | Existing managed upload tests retained; reader exposes only `getStatus` and `dispose` | Existing host regressions pass |
| Match published mobile runtime | New methods require a matching native binary | Not published; existing beta.14 does not include these methods |
| Complete protected capture workflow | START/opaque relay require separate native device authority and BLE integration | Not implemented by this status change; profile stays disabled |

Run `npm run verify` in `frameworks/react-native`,
`node tools/react-native/test-upload-backend-android.mjs` with the documented JDK
and dependency cache, and `bash tools/react-native/test-upload-backend-apple.sh`.
The earlier local beta.14 candidate snapshot predates this reader; it is not
evidence that these new methods were packaged or installed.

## 中文

未发布的 React Native 源码新增 `createProtectedStreamingStatusBackend`，它是只读接口：
公开工厂经过托管原生适配器，由 Android OkHttp 或 Apple URLSession 发送认证 GET。
两个生产传输均禁用重定向。该接口没有实现 protected START、标记转发、音频上传、
最终完成、设备确认或删除。

以上示例的 `baseUrl` 固定项目路径，`organizationId` 固定组织；注销、工作空间、环境、
绑定变化或页面失去请求所有权时，应取消生命周期并调用 `dispose()`。
相对路径为 `/recordings/:recordingId/streaming-status?session_id=:sessionId`。
使用应用认证的只读代理，移动 App 不能嵌入 secret API key。Dashboard 使用既有组织/项目
录音读取权限，不授予独立的 device-token protected 写入权限。

调用必须提供已知且精确的录音、会话、代际与 writer 身份。解析器拒绝其他 owner、
不安全整数、额外字段、错误计数和状态。`writerEpoch` 是正 int64 十进制字符串；
`revision` 是非负 int64 十进制字符串，初始值为 `0`。计数范围为 0～65535。
`sealed` 只代表标记元数据封存，不代表音频完成、已发布或可以删除。
授权过期后仍可只读检查，不签发新权限。

原生层限制响应大小，只允许预期标量字段经过 RN，不传密钥、nonce、密文、签名或 ACK。
请求 ID 用于取消原生读取；凭证刷新和原生完成之后再次检查生命周期。
权限失败、不存在和服务端异常都不会触发回退上传或切换 owner。

### 设计对照与验证

| 要求 | 实现及验证 | 状态 / 剩余验证 |
| --- | --- | --- |
| 公开接口调用真实 HTTP provider | 包入口工厂、Codegen、双端适配器；公开入口测试和原生 HTTP fixture | 源码已实现；仍需完整目标平台构建 |
| 身份、revision 与状态校验 | 十项 RN 回归，包含零 revision、int64 精度、旧身份和生命周期竞争 | host 回归通过 |
| 原生标量边界与禁止回退 | Android 共 96 项、Apple 共 21 套 host 回归 | 注入 HTTP fixture 通过，不代表线上或实机验证 |
| 保持 BATCH 与删除证明 | 保留既有上传回归；新增读取仅暴露 `getStatus` 和 `dispose` | 既有 host 回归通过 |
| 匹配已发布移动运行时 | 新方法要求对应原生二进制 | 尚未发布；已发布 beta.14 不包含这些方法 |
| 完整 protected 采集流程 | START/opaque relay 需要独立原生设备权限和 BLE 接线 | 本次状态读取未实现该流程，profile 保持关闭 |

验证命令同英文。此前本地 beta.14 候选包早于本次修改，不能证明新增方法已打包或安装。
