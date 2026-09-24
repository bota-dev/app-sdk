import 'package:bota_app_sdk/bota_app_sdk.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('exports the Flutter package identity', () {
    expect(BotaFlutterSdk.packageName, 'bota_app_sdk');
  });
}
