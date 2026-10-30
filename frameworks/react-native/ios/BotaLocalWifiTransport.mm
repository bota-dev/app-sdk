#import <BotaDeviceSDKSpec/BotaDeviceSDKSpec.h>
#if __has_include(<BotaLocalWifiTransport/BotaLocalWifiTransport-Swift.h>)
#import <BotaLocalWifiTransport/BotaLocalWifiTransport-Swift.h>
#elif __has_include("BotaLocalWifiTransport-Swift.h")
#import "BotaLocalWifiTransport-Swift.h"
#elif __has_include(<BotaDeviceSDK/BotaDeviceSDK-Swift.h>)
#import <BotaDeviceSDK/BotaDeviceSDK-Swift.h>
#else
#import "BotaDeviceSDK-Swift.h"
#endif

@interface BotaLocalWifiTransport : NativeBotaLocalWifiTransportSpecBase <NativeBotaLocalWifiTransportSpec>
@property(nonatomic, strong) BotaLocalWifiTransportBridge *transport;
@end
@implementation BotaLocalWifiTransport
RCT_EXPORT_MODULE(BotaLocalWifiTransport)
+ (BOOL)requiresMainQueueSetup { return NO; }
- (instancetype)init {
  if ((self = [super init])) { _transport = [BotaLocalWifiTransportBridge new]; }
  return self;
}
- (void)preflight:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_transport preflight:^(NSString *value, NSError *error) {
    if (error) reject(@"local_wifi_unavailable", @"Local WiFi operation failed", nil); else resolve(value);
  }];
}
- (void)createLease:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_transport createLease:^(NSString *value, NSError *error) {
    if (error) reject(@"local_wifi_unavailable", @"Local WiFi operation failed", nil); else resolve(value);
  }];
}
- (void)join:(NSString *)handle inputJSON:(NSString *)inputJSON resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_transport join:handle inputJSON:inputJSON completion:^(NSString *value, NSError *error) {
    if (error) reject(@"local_wifi_unavailable", @"Local WiFi operation failed", nil); else resolve(value);
  }];
}
- (void)open:(NSString *)handle inputJSON:(NSString *)inputJSON resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_transport open:handle inputJSON:inputJSON completion:^(NSString *value, NSError *error) {
    if (error) reject(@"local_wifi_unavailable", @"Local WiFi operation failed", nil); else resolve(value);
  }];
}
- (void)read:(NSString *)handle maximumLength:(double)maximumLength resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_transport read:handle maximumLength:maximumLength completion:^(NSString *value, NSError *error) {
    if (error) reject(@"local_wifi_unavailable", @"Local WiFi operation failed", nil); else resolve(value);
  }];
}
- (void)closeReader:(NSString *)handle resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_transport closeReader:handle completion:^(NSString *value, NSError *error) {
    if (error) reject(@"local_wifi_unavailable", @"Local WiFi operation failed", nil); else resolve(value);
  }];
}
- (void)closeLease:(NSString *)handle resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_transport closeLease:handle completion:^(NSString *value, NSError *error) {
    if (error) reject(@"local_wifi_unavailable", @"Local WiFi operation failed", nil); else resolve(value);
  }];
}
- (void)invalidate { [_transport invalidate]; }
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeBotaLocalWifiTransportSpecJSI>(params);
}
@end
