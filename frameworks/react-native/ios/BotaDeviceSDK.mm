#import <BotaDeviceSDKSpec/BotaDeviceSDKSpec.h>

#if __has_include(<BotaDeviceSDK/BotaDeviceSDK-Swift.h>)
#import <BotaDeviceSDK/BotaDeviceSDK-Swift.h>
#else
#import "BotaDeviceSDK-Swift.h"
#endif

static void BotaRejectAppleError(NSError *error, RCTPromiseRejectBlock reject)
{
  reject(@"apple_sdk_error", error.localizedDescription, error);
}

@interface BotaDeviceSDK : NSObject <NativeBotaDeviceSDKSpec>
@end

@implementation BotaDeviceSDK

RCT_EXPORT_MODULE(BotaDeviceSDK)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (void)configure:(JS::NativeBotaDeviceSDK::NativeConfiguration &)configuration
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      configureWithApplicationSupportDirectory:configuration.applicationSupportDirectory()
                                     logLevel:configuration.logLevel()
                                   completion:^(NSError *_Nullable error) {
                                     if (error != nil) {
                                       BotaRejectAppleError(error, reject);
                                       return;
                                     }
                                     resolve(nil);
                                   }];
}

- (void)destroy:(RCTPromiseResolveBlock)resolve
         reject:(__unused RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared] destroyWithCompletion:^{
    resolve(nil);
  }];
}

- (void)getCapabilities:(RCTPromiseResolveBlock)resolve
                 reject:(__unused RCTPromiseRejectBlock)reject
{
  resolve([[BotaDeviceSDKAppleBridge shared] capabilities]);
}

- (void)getState:(RCTPromiseResolveBlock)resolve
          reject:(__unused RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared] stateWithCompletion:^(NSString *state) {
    resolve(state);
  }];
}

#if RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeBotaDeviceSDKSpecJSI>(params);
}
#endif

@end
