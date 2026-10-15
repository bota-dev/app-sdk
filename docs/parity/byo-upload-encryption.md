# BYO customer envelopes and opaque relay

October 15, 2026: BYO uses one fixed BOTAENC2 content format and HPKE
X25519/HKDF-SHA256/ChaCha20-Poly1305 envelope suite. The customer public key is the
recipient of the recording data key. The customer opens the envelope and decrypts
without requesting a key from Bota. There is no old BYO custody fallback.

Backend first prepare obtains and authenticates the customer public key through
getUploadUrl, then signs the existing device authorization. Firmware already
seals to that authorized recipient. Existing Apple/Android `ByoUploadSession`,
Rust BLE codecs and generated-JS transport relay the original encrypted bytes
and documents. No SDK encryption plug-in, plaintext conversion, second encrypted
file or new native codec is required; keys do not cross JS/Dart bridges.

Persist the exact original authorization/manifest for retries. URL renewal cannot
rotate the pinned customer key. Completion forwards the envelope to the customer;
source cleanup still requires a verified durable Bota receipt. TLS transport
protection is independent of audio content encryption.

The 17 existing Rust BLE/recovery tests pass. Production firmware C-to-Python
customer-envelope interoperability is tested in the firmware worktree; backend
fixtures demonstrate customer-only decryption of unchanged audio. These checks
do not establish released native binaries or physical BLE/radio qualification.

See the single checklist in `internal-docs/device/BYO-Upload-Encryption.md`.
No SDK API or production implementation changed, and no package was released.
