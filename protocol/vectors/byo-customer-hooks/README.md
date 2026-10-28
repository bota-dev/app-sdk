# Customer package golden vector

`package.json` was produced using the backend reference
`api/src/storage-integration/customer-hooks/package.ts` (`customerPackageTrailer`)
and the existing Batch journal fixture. It contains only synthetic ciphertext,
public context/authorization, opaque manifest and the resulting trailer/package
facts. No customer private key or service credential is included.

The original ciphertext hash belongs to `context`; `upload_package` binds the
complete original-plus-footer bytes. Rust core, native adapters, generated-JS
host tests and the firmware production C codec consume this fixed vector.
The firmware copy at `tests/fixtures/byo-customer-hooks/package.json` must remain
byte-identical. When the contract changes, regenerate with the backend owner,
review field order and both hashes, then update all consumers together. Do not
replace the fixture with each implementation's independently generated output.

Signature/time admission remains the device owner's responsibility. This vector
checks serialization and transport identity; it does not authorize a real device
or prove released-customer integration.
