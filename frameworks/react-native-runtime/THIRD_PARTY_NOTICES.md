# Third-party notices

The generated executable JavaScript contains compiled Rust SDK code and the Rust
standard library. This directory preserves full upstream notices for the locked
normal dependency tree of `bota-device-sdk-js` targeting `wasm32-unknown-unknown`,
including the macro dependencies used during compilation. Binaryen generates
the JavaScript runtime scaffolding; Terser minifies the generated artifact. Neither
compiler is an application runtime dependency. Ordinary JS dependency notices
are also included. Bota SDK source is covered by the package MIT LICENSE.

Rust 1.98.0 standard-library notices are retained in the complete upstream
[COPYRIGHT-library.html](THIRD_PARTY_NOTICES/rust-1.98.0-COPYRIGHT-library.html).
These upstream notices conservatively include optional/platform components;
listing a component does not assert that every optional component is used.

| Component | Version | Upstream license expression | Full license texts |
| --- | --- | --- | --- |
| [aead](https://github.com/RustCrypto/traits) | 0.6.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/aead-0.6.1-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/aead-0.6.1-LICENSE-MIT) |
| [base64](https://github.com/marshallpierce/rust-base64) | 0.22.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/base64-0.22.1-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/base64-0.22.1-LICENSE-MIT) |
| [base64-js](https://github.com/beatgammit/base64-js.git) | 1.5.1 | MIT | [LICENSE](THIRD_PARTY_NOTICES/base64-js-1.5.1-LICENSE) |
| [binaryen](https://github.com/AssemblyScript/binaryen.js.git) | 132.0.0 | Apache-2.0 | [LICENSE](THIRD_PARTY_NOTICES/binaryen-132.0.0-LICENSE) |
| [block-buffer](https://github.com/RustCrypto/utils) | 0.12.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/block-buffer-0.12.1-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/block-buffer-0.12.1-LICENSE-MIT) |
| [buffer](https://github.com/feross/buffer.git) | 6.0.3 | MIT | [LICENSE](THIRD_PARTY_NOTICES/buffer-6.0.3-LICENSE) |
| [cfg-if](https://github.com/rust-lang/cfg-if) | 1.0.4 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/cfg-if-1.0.4-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/cfg-if-1.0.4-LICENSE-MIT) |
| [chacha20](https://github.com/RustCrypto/stream-ciphers) | 0.10.2 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/chacha20-0.10.2-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/chacha20-0.10.2-LICENSE-MIT) |
| [chacha20poly1305](https://github.com/RustCrypto/AEADs) | 0.11.0 | Apache-2.0 OR MIT | [LICENSE-APACHE](THIRD_PARTY_NOTICES/chacha20poly1305-0.11.0-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/chacha20poly1305-0.11.0-LICENSE-MIT) |
| [cipher](https://github.com/RustCrypto/traits) | 0.5.2 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/cipher-0.5.2-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/cipher-0.5.2-LICENSE-MIT) |
| [cmov](https://github.com/RustCrypto/utils) | 0.5.4 | Apache-2.0 OR MIT | [LICENSE-APACHE](THIRD_PARTY_NOTICES/cmov-0.5.4-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/cmov-0.5.4-LICENSE-MIT) |
| [const-oid](https://github.com/RustCrypto/formats) | 0.10.2 | Apache-2.0 OR MIT | [LICENSE-APACHE](THIRD_PARTY_NOTICES/const-oid-0.10.2-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/const-oid-0.10.2-LICENSE-MIT) |
| [crypto-common](https://github.com/RustCrypto/traits) | 0.2.2 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/crypto-common-0.2.2-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/crypto-common-0.2.2-LICENSE-MIT) |
| [ctutils](https://github.com/RustCrypto/utils) | 0.4.2 | Apache-2.0 OR MIT | [LICENSE-APACHE](THIRD_PARTY_NOTICES/ctutils-0.4.2-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/ctutils-0.4.2-LICENSE-MIT) |
| [digest](https://github.com/RustCrypto/traits) | 0.11.3 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/digest-0.11.3-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/digest-0.11.3-LICENSE-MIT) |
| [eventemitter3](https://github.com/primus/eventemitter3.git) | 5.0.1 | MIT | [LICENSE](THIRD_PARTY_NOTICES/eventemitter3-5.0.1-LICENSE) |
| [hkdf](https://github.com/RustCrypto/KDFs/) | 0.13.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/hkdf-0.13.0-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/hkdf-0.13.0-LICENSE-MIT) |
| [hmac](https://github.com/RustCrypto/MACs) | 0.13.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/hmac-0.13.0-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/hmac-0.13.0-LICENSE-MIT) |
| [hybrid-array](https://github.com/RustCrypto/hybrid-array) | 0.4.14 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/hybrid-array-0.4.14-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/hybrid-array-0.4.14-LICENSE-MIT) |
| [ieee754](https://github.com/feross/ieee754.git) | 1.2.1 | BSD-3-Clause | [LICENSE](THIRD_PARTY_NOTICES/ieee754-1.2.1-LICENSE) |
| [inout](https://github.com/RustCrypto/utils) | 0.2.2 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/inout-0.2.2-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/inout-0.2.2-LICENSE-MIT) |
| [itoa](https://github.com/dtolnay/itoa) | 1.0.18 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/itoa-1.0.18-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/itoa-1.0.18-LICENSE-MIT) |
| [memchr](https://github.com/BurntSushi/memchr) | 2.8.3 | Unlicense OR MIT | [LICENSE-MIT](THIRD_PARTY_NOTICES/memchr-2.8.3-LICENSE-MIT) |
| [poly1305](https://github.com/RustCrypto/universal-hashes) | 0.9.1 | Apache-2.0 OR MIT | [LICENSE-APACHE](THIRD_PARTY_NOTICES/poly1305-0.9.1-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/poly1305-0.9.1-LICENSE-MIT) |
| [proc-macro2](https://github.com/dtolnay/proc-macro2) | 1.0.107 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/proc-macro2-1.0.107-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/proc-macro2-1.0.107-LICENSE-MIT) |
| [quote](https://github.com/dtolnay/quote) | 1.0.47 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/quote-1.0.47-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/quote-1.0.47-LICENSE-MIT) |
| [serde](https://github.com/serde-rs/serde) | 1.0.229 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/serde-1.0.229-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/serde-1.0.229-LICENSE-MIT) |
| [serde_core](https://github.com/serde-rs/serde) | 1.0.229 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/serde_core-1.0.229-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/serde_core-1.0.229-LICENSE-MIT) |
| [serde_derive](https://github.com/serde-rs/serde) | 1.0.229 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/serde_derive-1.0.229-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/serde_derive-1.0.229-LICENSE-MIT) |
| [serde_json](https://github.com/serde-rs/json) | 1.0.151 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/serde_json-1.0.151-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/serde_json-1.0.151-LICENSE-MIT) |
| [sha2](https://github.com/RustCrypto/hashes) | 0.11.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/sha2-0.11.0-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/sha2-0.11.0-LICENSE-MIT) |
| [syn](https://github.com/dtolnay/syn) | 3.0.4 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/syn-3.0.4-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/syn-3.0.4-LICENSE-MIT) |
| [terser](https://github.com/terser/terser) | 5.51.2 | BSD-2-Clause | [LICENSE](THIRD_PARTY_NOTICES/terser-5.51.2-LICENSE) |
| [typenum](https://github.com/paholg/typenum) | 1.20.1 | MIT OR Apache-2.0 | [LICENSE](THIRD_PARTY_NOTICES/typenum-1.20.1-LICENSE), [LICENSE-APACHE](THIRD_PARTY_NOTICES/typenum-1.20.1-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/typenum-1.20.1-LICENSE-MIT) |
| [unicode-ident](https://github.com/dtolnay/unicode-ident) | 1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/unicode-ident-1.0.24-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/unicode-ident-1.0.24-LICENSE-MIT), [LICENSE-UNICODE](THIRD_PARTY_NOTICES/unicode-ident-1.0.24-LICENSE-UNICODE) |
| [universal-hash](https://github.com/RustCrypto/traits) | 0.6.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](THIRD_PARTY_NOTICES/universal-hash-0.6.1-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/universal-hash-0.6.1-LICENSE-MIT) |
| [zeroize](https://github.com/RustCrypto/utils) | 1.9.0 | Apache-2.0 OR MIT | [LICENSE-APACHE](THIRD_PARTY_NOTICES/zeroize-1.9.0-LICENSE-APACHE), [LICENSE-MIT](THIRD_PARTY_NOTICES/zeroize-1.9.0-LICENSE-MIT) |
| [zmij](https://github.com/dtolnay/zmij) | 1.0.23 | MIT | [LICENSE-MIT](THIRD_PARTY_NOTICES/zmij-1.0.23-LICENSE-MIT) |

Retain this index and its accompanying directory when redistributing the
compiled SDK. Update the notices alongside locked dependency/toolchain changes.
