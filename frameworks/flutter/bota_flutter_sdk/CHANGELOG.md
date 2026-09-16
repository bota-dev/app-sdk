# Changelog

## 1.2.0-beta.0 (historical unpublished Flutter metadata)

- Projected adapter-only bridge failures into sanitized stable Dart error codes
  while preserving the public operation; added `operationNotOwned` for
  cross-engine ownership rejection.
- Marked this version identity occupied by immutable non-Flutter source. The
  package must receive a new synchronized version before release packaging.
- Added the initial iOS and Android Flutter facade for discovery, connection,
  status, recording control and batch transfer, provisioning, connection
  settings, upload ownership, WiFi, OTA, sanitized logs, remove-only
  deprovision, and authenticated factory reset.
- Added generated Pigeon bindings backed by the public Apple and Android native
  facades. Recording bodies, firmware bodies, raw Bluetooth packets, and
  device-private material remain outside Dart event channels.
- Added all 29 Flutter-supported canonical workflow conformance traces;
  explicitly classified the four Encrypted Upload v2 traces as unsupported;
  and added disposable Android and iOS release consumers.
- Added a device-management example whose backend callbacks fail closed until
  the application supplies request-bound material.
- Added deterministic package/archive inventory, dependency-license evidence,
  publication verification, and clean Android/iOS release-consumer gates.

The synchronized `1.1.0` release did not publish a Flutter package. Preparing
this changelog entry does not claim that `1.2.0-beta.0` exists on pub.dev.
