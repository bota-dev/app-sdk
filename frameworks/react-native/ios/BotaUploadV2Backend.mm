#import <BotaDeviceSDKSpec/BotaDeviceSDKSpec.h>
#if __has_include(<BotaDeviceSDK/BotaDeviceSDK-Swift.h>)
#import <BotaDeviceSDK/BotaDeviceSDK-Swift.h>
#else
#import "BotaDeviceSDK-Swift.h"
#endif

@interface BotaUploadV2Backend : NativeBotaUploadV2BackendSpecBase <NativeBotaUploadV2BackendSpec>
@property(nonatomic, strong) BotaUploadV2BackendBridge *backend;
@end

@implementation BotaUploadV2Backend
RCT_EXPORT_MODULE(BotaUploadV2Backend)
+ (BOOL)requiresMainQueueSetup { return NO; }
- (instancetype)init {
  if ((self = [super init])) { _backend = [BotaUploadV2BackendBridge new]; }
  return self;
}
- (void)readProtectedStreamingStatus:(NSString *)requestId inputJSON:(NSString *)inputJSON resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_backend readProtectedStreamingStatus:requestId inputJSON:inputJSON completion:^(NSString *result, NSError *error) {
    if (error) { reject(@"BOTA_STREAM_STATUS_FAILED", @"BOTA_STREAM_STATUS_FAILED", nil); }
    else { resolve(result); }
  }];
}
- (void)cancelProtectedStreamingStatus:(NSString *)requestId resolve:(RCTPromiseResolveBlock)resolve reject:(__unused RCTPromiseRejectBlock)reject {
  [_backend cancelProtectedStreamingStatus:requestId completion:^{ resolve(nil); }];
}
- (void)prepare:(NSString *)inputJSON resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  __weak BotaUploadV2Backend *weakSelf = self;
  [_backend prepare:inputJSON credentialsRequested:^(NSString *requestId, NSString *operationId) {
    [weakSelf emitOnCredentialsRequested:@{@"requestId": requestId, @"operationId": operationId}];
  } completion:^(NSString *result, NSError *error) {
    if (error) { reject(@"encrypted_upload_v2_backend_failed", error.localizedDescription, nil); }
    else { resolve(result); }
  }];
}
- (void)cancel:(NSString *)operationId resolve:(RCTPromiseResolveBlock)resolve reject:(__unused RCTPromiseRejectBlock)reject {
  [_backend cancel:operationId completion:^{ resolve(nil); }];
}
- (void)complete:(NSString *)operationId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_backend complete:operationId completion:^(NSError *error) {
    if (error) { reject(@"encrypted_upload_v2_backend_failed", error.localizedDescription, nil); }
    else { resolve(nil); }
  }];
}
- (void)resolveCredentials:(NSString *)requestId token:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(__unused RCTPromiseRejectBlock)reject {
  [_backend resolveCredentials:requestId token:token completion:^{ resolve(nil); }];
}
- (void)rejectCredentials:(NSString *)requestId resolve:(RCTPromiseResolveBlock)resolve reject:(__unused RCTPromiseRejectBlock)reject {
  [_backend rejectCredentials:requestId completion:^{ resolve(nil); }];
}
- (void)invalidate { [_backend invalidate]; }
#if RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeBotaUploadV2BackendSpecJSI>(params);
}
#endif
@end
