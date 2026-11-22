# Retired independent BYO upload

The unpublished independent device/proxy BYO workflow has been removed.
Use the [ordinary managed encrypted-v2 backend](v2-managed-backend.md#generic-target-extension-unreleased)
for both Bota and customer destinations. Apps do not select a storage backend.

Removed APIs include `createByoStorageBackend`, `listByoRecordings`,
`syncByoRecording` and `streamByoRecording`, their native bridges, Rust codecs
and generated workflow registrations. ABI allocations remain reserved; old
journals are not adopted, re-created or treated as deletion permission.
Historical source and vectors remain available through version control.

Customer configuration, hook credentials and completion DTO adaptation belong
to Bota cloud. The device produces the ordinary HPKE manifest and uploads raw
BOTAENC2; customer private keys do not enter the SDK or Bota. URL renewal must
retain the selected target and recipient. Only a matching, device-verified and
durable Bota receipt permits source cleanup.
