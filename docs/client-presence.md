# Client presence

Apple, Android, React Native, Flutter and Web expose passive
`clientPresence.nextReport(deviceId)` metadata (Apple uses `deviceID:`).
Use the SDK connection handle, not a backend `dev_*` ID. A null result means
there is no current verified connection.

## Report and lifetime

Reports contain a schema version, random in-memory connection-session ID,
increasing sequence, platform, and generated SDK package/version identity.
Reconnect rotates the session; disconnect and destroy invalidate it. Native
getters also check local transport ownership. The getter performs no Bluetooth
read, network request or periodic heartbeat.

The native/framework facades expose camelCase fields. Map these to the
heartbeat's snake_case `client_context` fields when sending them. The React
Native compatibility `BotaClient` report already uses snake_case; its modern
`BotaDeviceSDK` report is typed as `BotaClientPresenceContext`.

## Host integration

1. Obtain a fresh device status through the verified connection.
2. Capture the client report for that same SDK connection handle.
3. Confirm the authenticated account, project, device and binding generation
   still match before attaching the report to the existing heartbeat relay.
4. Discard pending observations after disconnect, logout, rebinding or a scope
   change. Do not queue stale reports for later replay.

The host may add a developer-supplied application identifier. The SDK does not
infer app names, collect phone identifiers or persist a client identity.
Reports are diagnostic observations, not device attestation, proof of continuous
connectivity or authority to route commands. Command routing is unchanged.

For React Native, `readClientPresenceObservation` binds a host-supplied status
read to the current SDK session. See the
[maintenance integration guide](parity/maintenance-baseline.md) for the
compatibility report, freshness checks and host responsibilities.

See the [Changelog](../CHANGELOG.md) for version history and the
[Web guide](../frameworks/web/README.md#local-client-metadata-source-preview)
for browser lifecycle rules.
