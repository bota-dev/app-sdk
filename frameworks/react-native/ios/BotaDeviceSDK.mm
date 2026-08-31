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

@interface BotaDeviceSDK : NativeBotaDeviceSDKSpecBase <NativeBotaDeviceSDKSpec>
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

- (void)startScan:(double)timeoutMs
  allowDuplicates:(BOOL)allowDuplicates
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  __weak BotaDeviceSDK *weakSelf = self;
  [[BotaDeviceSDKAppleBridge shared]
      startScanWithTimeoutMilliseconds:timeoutMs
                     allowDuplicates:allowDuplicates
                            onDevice:^(NSDictionary *device) {
                              [weakSelf emitOnDeviceDiscovered:device];
                            }
                             onError:^(__unused NSError *error) {}
                           completion:^(NSError *_Nullable error) {
                             if (error != nil) {
                               BotaRejectAppleError(error, reject);
                               return;
                             }
                             resolve(nil);
                           }];
}

- (void)stopScan:(RCTPromiseResolveBlock)resolve
          reject:(__unused RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared] stopScanWithCompletion:^{
    resolve(nil);
  }];
}

- (void)connectSelected:(JS::NativeBotaDeviceSDK::NativeDiscoveredDevice &)device
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      connectSelectedWithID:device.id_()
                      name:device.name()
                deviceType:device.deviceType()
           firmwareVersion:device.firmwareVersion()
                macAddress:device.macAddress()
              pairingState:device.pairingState()
                      rssi:device.rssi()
  discoveredAtMilliseconds:device.discoveredAtMs()
                completion:^(NSDictionary *_Nullable connected, NSError *_Nullable error) {
                  if (error != nil) {
                    BotaRejectAppleError(error, reject);
                    return;
                  }
                  resolve(connected);
                }];
}

- (void)reconnect:(NSString *)serialNumber
          options:(JS::NativeBotaDeviceSDK::NativeReconnectOptions &)options
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      reconnectWithSerialNumber:serialNumber
        scanTimeoutMilliseconds:options.scanTimeoutMs()
  connectionTimeoutMilliseconds:options.connectionTimeoutMs()
                     completion:^(NSDictionary *_Nullable connected, NSError *_Nullable error) {
                       if (error != nil) {
                         BotaRejectAppleError(error, reject);
                         return;
                       }
                       resolve(connected);
                     }];
}

- (void)disconnect:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared] disconnectWithCompletion:^(NSError *_Nullable error) {
    if (error != nil) {
      BotaRejectAppleError(error, reject);
      return;
    }
    resolve(nil);
  }];
}

- (void)readStatus:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      readStatusWithCompletion:^(NSDictionary *_Nullable status, NSError *_Nullable error) {
        if (error != nil) {
          BotaRejectAppleError(error, reject);
          return;
        }
        resolve(status);
      }];
}

- (void)startStatusUpdates:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  __weak BotaDeviceSDK *weakSelf = self;
  [[BotaDeviceSDKAppleBridge shared]
      startStatusUpdatesWithOnStatus:^(NSDictionary *status) {
        [weakSelf emitOnDeviceStatusUpdated:status];
      }
      onError:^(__unused NSError *error) {}
      completion:^(NSError *_Nullable error) {
        if (error != nil) {
          BotaRejectAppleError(error, reject);
          return;
        }
        resolve(nil);
      }];
}

- (void)stopStatusUpdates:(RCTPromiseResolveBlock)resolve
                    reject:(__unused RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared] stopStatusUpdatesWithCompletion:^{
    resolve(nil);
  }];
}

- (void)provision:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  __weak BotaDeviceSDK *weakSelf = self;
  [[BotaDeviceSDKAppleBridge shared]
      provisionWithID:device.id_()
          serialNumber:device.serialNumber()
            deviceType:device.deviceType()
       firmwareVersion:device.firmwareVersion()
       hardwareRevision:device.hardwareRevision()
         isProvisioned:device.isProvisioned()
       connectionState:device.connectionState()
                   mtu:device.mtu()
     onMaterialRequest:^(NSDictionary *request) {
       [weakSelf emitOnProvisioningMaterialRequested:request];
     }
            completion:^(NSError *_Nullable error) {
              if (error != nil) {
                BotaRejectAppleError(error, reject);
                return;
              }
              resolve(nil);
            }];
}

- (void)deprovision:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      deprovisionWithID:device.id_()
             serialNumber:device.serialNumber()
               deviceType:device.deviceType()
          firmwareVersion:device.firmwareVersion()
          hardwareRevision:device.hardwareRevision()
            isProvisioned:device.isProvisioned()
          connectionState:device.connectionState()
                      mtu:device.mtu()
               completion:^(NSError *_Nullable error) {
                 if (error != nil) {
                   BotaRejectAppleError(error, reject);
                   return;
                 }
                 resolve(nil);
               }];
}

- (void)resolveProvisioningMaterial:(NSString *)requestId
                           material:(JS::NativeBotaDeviceSDK::NativeProvisioningMaterial &)material
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      resolveProvisioningMaterialWithRequestID:requestId
                                    apiEndpoint:material.apiEndpoint()
                                    deviceToken:material.deviceToken()
                                            mtu:material.mtu()
                                     completion:^(NSError *_Nullable error) {
                                       if (error != nil) {
                                         BotaRejectAppleError(error, reject);
                                         return;
                                       }
                                       resolve(nil);
                                     }];
}

- (void)rejectApplicationMaterial:(NSString *)requestId
                           message:(NSString *)message
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      rejectApplicationMaterialWithRequestID:requestId
                                      message:message
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
