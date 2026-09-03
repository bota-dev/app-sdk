import 'package:bota_flutter_sdk/bota_flutter_sdk.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('exports the Flutter package identity', () {
    expect(BotaFlutterSdk.packageName, 'bota_flutter_sdk');
  });
}
