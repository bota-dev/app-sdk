#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#import <UIKit/UIKit.h>

// Core Bluetooth owns the pending connection. A bounded UIKit task keeps a
// retry callback runnable during the short delay after a transient failure.
@interface BotaBleSession : NSObject <RCTBridgeModule, RCTInvalidating>
@end

@implementation BotaBleSession {
  BOOL _active;
  NSMutableDictionary<NSString *, dispatch_block_t> *_waiting;
}
RCT_EXPORT_MODULE(BotaBleSession)
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

- (void)releaseToken:(NSString *)token {
  dispatch_block_t finish = _waiting[token];
  [_waiting removeObjectForKey:token];
  if (finish) finish();
}
RCT_EXPORT_METHOD(setActive:(BOOL)active resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  _active = active;
  if (!_waiting) _waiting = [NSMutableDictionary new];
  if (!active) for (NSString *token in _waiting.allKeys) [self releaseToken:token];
  resolve(nil);
}
RCT_EXPORT_METHOD(waitToRetryFor:(NSString *)token delay:(double)ms resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (!_active || !(ms >= 0 && ms <= 30000) || _waiting[token]) {
    reject(@"ble_retry_unavailable", @"No available Bluetooth retry", nil);
    return;
  }
  UIApplication *app = UIApplication.sharedApplication;
  __block UIBackgroundTaskIdentifier task = UIBackgroundTaskInvalid;
  __block BOOL expired = NO;
  task = [app beginBackgroundTaskWithName:@"Bota Bluetooth retry" expirationHandler:^{
    expired = YES;
    [self releaseToken:token];
  }];
  if (task == UIBackgroundTaskInvalid) {
    reject(@"ble_retry_unavailable", @"Bluetooth execution time unavailable", nil);
    return;
  }
  _waiting[token] = ^{
    if (expired) reject(@"ble_retry_expired", @"Bluetooth execution time expired", nil);
    else resolve(nil);
    [app endBackgroundTask:task];
  };
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(ms * NSEC_PER_MSEC)), self.methodQueue, ^{
    [self releaseToken:token];
  });
}
RCT_EXPORT_METHOD(cancelRetry:(NSString *)token resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  [self releaseToken:token];
  resolve(nil);
}
- (void)invalidate {
  dispatch_async(dispatch_get_main_queue(), ^{
    self->_active = NO;
    for (NSString *token in self->_waiting.allKeys) [self releaseToken:token];
  });
}
@end
