#import <React/RCTBridgeModule.h>
@interface RCT_EXTERN_MODULE(MicrophonePermission, NSObject)
RCT_EXTERN_METHOD(microphonePermission:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
@end
