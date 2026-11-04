#import <React/RCTBridgeModule.h>
@interface RCT_EXTERN_MODULE(SpeechLabHost, NSObject)
RCT_EXTERN_METHOD(request:(NSString *)id origin:(NSString *)origin role:(NSString *)role code:(NSString *)code action:(NSString *)action body:(NSString *)body resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(cancel:(NSString *)id resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(microphonePermission:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
@end
