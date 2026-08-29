# Security Policy

Report suspected vulnerabilities privately to `security@bota.dev`. Do not open
a public issue containing exploit details, credentials, device tokens, private
keys, recordings, or customer data.

Supported versions will be listed in release manifests after the first stable
Device SDK release. Prerelease milestone artifacts are not production-supported.

Repository rules:

- never commit secrets or production signing material;
- use synthetic protocol fixtures without customer data;
- preserve authenticated provisioning and reset close-loop semantics;
- keep backend decryption keys outside the Device SDK;
- treat malformed BLE data as untrusted input and never panic on it.
