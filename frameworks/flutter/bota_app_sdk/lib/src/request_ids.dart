import 'dart:math';

/// Generates and validates bridge-owned opaque request identifiers.
abstract final class RequestId {
  static final Random _random = Random.secure();
  static final RegExp _pattern = RegExp(r'^[0-9a-f]{32}$');

  static String next() {
    final StringBuffer value = StringBuffer();
    for (var index = 0; index < 16; index += 1) {
      value.write(_random.nextInt(256).toRadixString(16).padLeft(2, '0'));
    }
    return value.toString();
  }

  static bool isValid(String value) => _pattern.hasMatch(value);
}
