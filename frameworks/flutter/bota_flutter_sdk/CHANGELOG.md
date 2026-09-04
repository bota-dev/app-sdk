# Changelog

## Unreleased

- Added the initial iOS and Android Flutter facade for discovery, connection,
  status, recording control and batch transfer, provisioning, connection
  settings, upload ownership, WiFi, OTA, sanitized logs, remove-only
  deprovision, and authenticated factory reset.
- Added generated Pigeon bindings backed by the public Apple and Android native
  facades. Recording bodies, firmware bodies, raw Bluetooth packets, and
  device-private material remain outside Dart event channels.
- Added all 29 canonical workflow conformance traces and disposable Android and
  iOS release consumers.
- Added a device-management example whose backend callbacks fail closed until
  the application supplies request-bound material.

The first planned pub.dev version is `1.2.0-beta.0`. The synchronized `1.1.0`
release did not publish a Flutter package.
