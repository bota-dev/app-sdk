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

- (void)isProvisioned:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      isProvisionedWithID:device.id_()
              serialNumber:device.serialNumber()
                deviceType:device.deviceType()
           firmwareVersion:device.firmwareVersion()
           hardwareRevision:device.hardwareRevision()
             isProvisioned:device.isProvisioned()
           connectionState:device.connectionState()
                       mtu:device.mtu()
                completion:^(BOOL value, NSError *_Nullable error) {
                  if (error != nil) {
                    BotaRejectAppleError(error, reject);
                    return;
                  }
                  resolve(@(value));
                }];
}

- (void)readPublicKey:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      readPublicKeyWithID:device.id_()
              serialNumber:device.serialNumber()
                deviceType:device.deviceType()
           firmwareVersion:device.firmwareVersion()
           hardwareRevision:device.hardwareRevision()
             isProvisioned:device.isProvisioned()
           connectionState:device.connectionState()
                       mtu:device.mtu()
                completion:^(NSString *_Nullable value, NSError *_Nullable error) {
                  if (error != nil) {
                    BotaRejectAppleError(error, reject);
                    return;
                  }
                  resolve(value ?: [NSNull null]);
                }];
}

- (void)readAuthNonce:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      readAuthNonceWithID:device.id_()
              serialNumber:device.serialNumber()
                deviceType:device.deviceType()
           firmwareVersion:device.firmwareVersion()
           hardwareRevision:device.hardwareRevision()
             isProvisioned:device.isProvisioned()
           connectionState:device.connectionState()
                       mtu:device.mtu()
                completion:^(NSString *_Nullable value, NSError *_Nullable error) {
                  if (error != nil) {
                    BotaRejectAppleError(error, reject);
                    return;
                  }
                  resolve(value ?: [NSNull null]);
                }];
}

- (void)setApiEndpoint:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
            environment:(NSString *)environment
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      setApiEndpointWithID:device.id_()
              serialNumber:device.serialNumber()
                deviceType:device.deviceType()
           firmwareVersion:device.firmwareVersion()
           hardwareRevision:device.hardwareRevision()
             isProvisioned:device.isProvisioned()
           connectionState:device.connectionState()
                       mtu:device.mtu()
               environment:environment
                completion:^(NSError *_Nullable error) {
                  if (error != nil) {
                    BotaRejectAppleError(error, reject);
                    return;
                  }
                  resolve(nil);
                }];
}

- (void)deliverCertificate:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
             certificatePem:(NSString *)certificatePem
              privateKeyPem:(NSString *)privateKeyPem
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      deliverCertificateWithID:device.id_()
                    serialNumber:device.serialNumber()
                      deviceType:device.deviceType()
                 firmwareVersion:device.firmwareVersion()
                 hardwareRevision:device.hardwareRevision()
                   isProvisioned:device.isProvisioned()
                 connectionState:device.connectionState()
                             mtu:device.mtu()
                  certificatePem:certificatePem
                   privateKeyPem:privateKeyPem
                      completion:^(NSError *_Nullable error) {
                        if (error != nil) {
                          BotaRejectAppleError(error, reject);
                          return;
                        }
                        resolve(nil);
                      }];
}

- (void)deliverBackendPublicKey:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
                   publicKeyHex:(NSString *)publicKeyHex
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      deliverBackendPublicKeyWithID:device.id_()
                        serialNumber:device.serialNumber()
                          deviceType:device.deviceType()
                     firmwareVersion:device.firmwareVersion()
                     hardwareRevision:device.hardwareRevision()
                       isProvisioned:device.isProvisioned()
                     connectionState:device.connectionState()
                                 mtu:device.mtu()
                        publicKeyHex:publicKeyHex
                          completion:^(NSError *_Nullable error) {
                            if (error != nil) {
                              BotaRejectAppleError(error, reject);
                              return;
                            }
                            resolve(nil);
                          }];
}

- (void)writeGrant:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
           grantBlob:(NSString *)grantBlob
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      writeGrantWithID:device.id_()
             serialNumber:device.serialNumber()
               deviceType:device.deviceType()
          firmwareVersion:device.firmwareVersion()
          hardwareRevision:device.hardwareRevision()
            isProvisioned:device.isProvisioned()
          connectionState:device.connectionState()
                      mtu:device.mtu()
                grantBlob:grantBlob
               completion:^(NSError *_Nullable error) {
                 if (error != nil) {
                   BotaRejectAppleError(error, reject);
                   return;
                 }
                 resolve(nil);
               }];
}

- (void)syncTime:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      syncTimeWithID:device.id_()
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

- (void)configureWiFi:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
                  ssid:(NSString *)ssid
              password:(NSString *)password
             grantBlob:(NSString *)grantBlob
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      configureWiFiWithID:device.id_()
              serialNumber:device.serialNumber()
                deviceType:device.deviceType()
           firmwareVersion:device.firmwareVersion()
           hardwareRevision:device.hardwareRevision()
             isProvisioned:device.isProvisioned()
           connectionState:device.connectionState()
                       mtu:device.mtu()
                      ssid:ssid
                  password:password
                 grantBlob:grantBlob
                completion:^(NSDictionary *_Nullable result, NSError *_Nullable error) {
                  if (error != nil) {
                    BotaRejectAppleError(error, reject);
                    return;
                  }
                  resolve(result);
                }];
}

- (void)disconnectWiFi:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      disconnectWiFiWithID:device.id_()
              serialNumber:device.serialNumber()
                deviceType:device.deviceType()
           firmwareVersion:device.firmwareVersion()
           hardwareRevision:device.hardwareRevision()
             isProvisioned:device.isProvisioned()
           connectionState:device.connectionState()
                       mtu:device.mtu()
                completion:^(NSDictionary *_Nullable result, NSError *_Nullable error) {
                  if (error != nil) {
                    BotaRejectAppleError(error, reject);
                    return;
                  }
                  resolve(result);
                }];
}

- (void)readWiFiStatus:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      readWiFiStatusWithID:device.id_()
              serialNumber:device.serialNumber()
                deviceType:device.deviceType()
           firmwareVersion:device.firmwareVersion()
           hardwareRevision:device.hardwareRevision()
             isProvisioned:device.isProvisioned()
           connectionState:device.connectionState()
                       mtu:device.mtu()
                completion:^(NSDictionary *_Nullable status, NSError *_Nullable error) {
                  if (error != nil) {
                    BotaRejectAppleError(error, reject);
                    return;
                  }
                  resolve(status);
                }];
}

- (void)startWiFiStatusUpdates:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  __weak BotaDeviceSDK *weakSelf = self;
  [[BotaDeviceSDKAppleBridge shared]
      startWiFiStatusUpdatesWithID:device.id_()
                       serialNumber:device.serialNumber()
                         deviceType:device.deviceType()
                    firmwareVersion:device.firmwareVersion()
                    hardwareRevision:device.hardwareRevision()
                      isProvisioned:device.isProvisioned()
                    connectionState:device.connectionState()
                                mtu:device.mtu()
                           onStatus:^(NSDictionary *status) {
                             [weakSelf emitOnWiFiStatusUpdated:status];
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

- (void)stopWiFiStatusUpdates:(RCTPromiseResolveBlock)resolve
                        reject:(__unused RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared] stopWiFiStatusUpdatesWithCompletion:^{
    resolve(nil);
  }];
}

- (void)scanWiFiNetworks:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      scanWiFiNetworksWithID:device.id_()
              serialNumber:device.serialNumber()
                deviceType:device.deviceType()
           firmwareVersion:device.firmwareVersion()
           hardwareRevision:device.hardwareRevision()
             isProvisioned:device.isProvisioned()
           connectionState:device.connectionState()
                       mtu:device.mtu()
                completion:^(NSDictionary *_Nullable result, NSError *_Nullable error) {
                  if (error != nil) {
                    BotaRejectAppleError(error, reject);
                    return;
                  }
                  resolve(result);
                }];
}

- (void)listRecordings:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      listRecordingsWithID:device.id_()
              serialNumber:device.serialNumber()
                deviceType:device.deviceType()
           firmwareVersion:device.firmwareVersion()
           hardwareRevision:device.hardwareRevision()
             isProvisioned:device.isProvisioned()
           connectionState:device.connectionState()
                       mtu:device.mtu()
                completion:^(NSArray<NSDictionary *> *_Nullable recordings,
                             NSError *_Nullable error) {
                  if (error != nil) {
                    BotaRejectAppleError(error, reject);
                    return;
                  }
                  resolve(recordings);
                }];
}

- (void)syncRecording:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
             recording:(JS::NativeBotaDeviceSDK::NativeDeviceRecording &)recording
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  __weak BotaDeviceSDK *weakSelf = self;
  [[BotaDeviceSDKAppleBridge shared]
      syncRecordingWithID:device.id_()
              serialNumber:device.serialNumber()
                deviceType:device.deviceType()
           firmwareVersion:device.firmwareVersion()
           hardwareRevision:device.hardwareRevision()
             isProvisioned:device.isProvisioned()
           connectionState:device.connectionState()
                       mtu:device.mtu()
             recordingUUID:recording.uuid()
      startedAtMilliseconds:recording.startedAtMs()
       durationMilliseconds:recording.durationMs()
                  fileSize:recording.fileSize()
                     codec:recording.codec()
               isEncrypted:recording.isEncrypted()
                onProgress:^(NSDictionary *progress) {
                  [weakSelf emitOnRecordingTransferProgress:progress];
                }
                completion:^(NSString *_Nullable path, NSError *_Nullable error) {
                  if (error != nil) {
                    BotaRejectAppleError(error, reject);
                    return;
                  }
                  resolve(path);
                }];
}

- (void)observeUploadOwnership:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
                       request:(JS::NativeBotaDeviceSDK::NativeUploadOwnershipRequest &)request
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  __weak BotaDeviceSDK *weakSelf = self;
  [[BotaDeviceSDKAppleBridge shared]
      observeUploadOwnershipWithID:device.id_()
                      serialNumber:device.serialNumber()
                        deviceType:device.deviceType()
                   firmwareVersion:device.firmwareVersion()
                   hardwareRevision:device.hardwareRevision()
                     isProvisioned:device.isProvisioned()
                   connectionState:device.connectionState()
                               mtu:device.mtu()
                     recordingUUID:request.recordingUuid()
                          uploadID:request.uploadId()
                     destinationID:request.destinationId()
                        onProgress:^(NSDictionary *progress) {
                          [weakSelf emitOnUploadOwnershipProgress:progress];
                        }
                        completion:^(NSDictionary *_Nullable result, NSError *_Nullable error) {
                          if (error != nil) {
                            BotaRejectAppleError(error, reject);
                            return;
                          }
                          resolve(result);
                        }];
}

- (void)updateFirmware:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
                 image:(JS::NativeBotaDeviceSDK::NativeFirmwareImage &)image
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  __weak BotaDeviceSDK *weakSelf = self;
  [[BotaDeviceSDKAppleBridge shared]
      updateFirmwareWithID:device.id_()
              serialNumber:device.serialNumber()
                deviceType:device.deviceType()
           firmwareVersion:device.firmwareVersion()
           hardwareRevision:device.hardwareRevision()
             isProvisioned:device.isProvisioned()
           connectionState:device.connectionState()
                       mtu:device.mtu()
                   version:image.version()
                 sizeUnits:image.sizeUnits()
                     crc32:image.crc32()
                       url:image.url()
                onProgress:^(NSDictionary *progress) {
                  [weakSelf emitOnFirmwareUpdateProgress:progress];
                }
                completion:^(NSError *_Nullable error) {
                  if (error != nil) {
                    BotaRejectAppleError(error, reject);
                    return;
                  }
                  resolve(nil);
                }];
}

- (void)startDeviceLogs:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  __weak BotaDeviceSDK *weakSelf = self;
  [[BotaDeviceSDKAppleBridge shared]
      startDeviceLogsWithID:device.id_()
              serialNumber:device.serialNumber()
                deviceType:device.deviceType()
           firmwareVersion:device.firmwareVersion()
           hardwareRevision:device.hardwareRevision()
             isProvisioned:device.isProvisioned()
           connectionState:device.connectionState()
                       mtu:device.mtu()
                    onLine:^(NSDictionary *line) {
                      [weakSelf emitOnDeviceLog:line];
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

- (void)stopDeviceLogs:(RCTPromiseResolveBlock)resolve
                 reject:(__unused RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared] stopDeviceLogsWithCompletion:^{
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

- (void)readConnectionSettings:
            (JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      readConnectionSettingsWithID:device.id_()
                       serialNumber:device.serialNumber()
                         deviceType:device.deviceType()
                    firmwareVersion:device.firmwareVersion()
                   hardwareRevision:device.hardwareRevision()
                      isProvisioned:device.isProvisioned()
                    connectionState:device.connectionState()
                                mtu:device.mtu()
                         completion:^(NSDictionary *_Nullable settings,
                                      NSError *_Nullable error) {
                           if (error != nil) {
                             BotaRejectAppleError(error, reject);
                             return;
                           }
                           resolve(settings);
                         }];
}

- (void)writeConnectionSettings:
            (JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
                         settings:
            (JS::NativeBotaDeviceSDK::NativeDeviceConnectionSettings &)settings
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  auto enabled = settings.enabledConnections();
  auto heartbeat = settings.heartbeatEnabledConnections();
  auto power = settings.powerManagement();
  NSMutableArray<NSString *> *preference = [NSMutableArray array];
  for (NSString *value : settings.uploadNetworkPreference()) {
    [preference addObject:value];
  }
  [[BotaDeviceSDKAppleBridge shared]
      writeConnectionSettingsWithID:device.id_()
                       serialNumber:device.serialNumber()
                         deviceType:device.deviceType()
                    firmwareVersion:device.firmwareVersion()
                    hardwareRevision:device.hardwareRevision()
                      isProvisioned:device.isProvisioned()
                    connectionState:device.connectionState()
                                mtu:device.mtu()
                        enabledWifi:enabled.wifi()
                    enabledCellular:enabled.cellular()
                      heartbeatWifi:heartbeat.wifi()
                  heartbeatCellular:heartbeat.cellular()
            uploadNetworkPreference:preference
             wifiIdleTimeoutSeconds:power.wifiIdleTimeoutSeconds()
         cellularIdleTimeoutSeconds:power.cellularIdleTimeoutSeconds()
                   streamingEnabled:settings.streamingEnabled()
       streamingFlushIntervalSeconds:settings.streamingFlushIntervalSeconds()
                         completion:^(NSError *_Nullable error) {
                           if (error != nil) {
                             BotaRejectAppleError(error, reject);
                             return;
                           }
                           resolve(nil);
                         }];
}

- (void)factoryReset:(JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
           commandId:(NSString *)commandId
   bindingGeneration:(double)bindingGeneration
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  __weak BotaDeviceSDK *weakSelf = self;
  [[BotaDeviceSDKAppleBridge shared]
      factoryResetWithID:device.id_()
             serialNumber:device.serialNumber()
               deviceType:device.deviceType()
          firmwareVersion:device.firmwareVersion()
          hardwareRevision:device.hardwareRevision()
            isProvisioned:device.isProvisioned()
          connectionState:device.connectionState()
                      mtu:device.mtu()
                commandID:commandId
        bindingGeneration:bindingGeneration
           onGrantRequest:^(NSDictionary *request) {
             [weakSelf emitOnFactoryResetGrantRequested:request];
           }
               completion:^(NSDictionary *_Nullable result, NSError *_Nullable error) {
                 if (error != nil) {
                   BotaRejectAppleError(error, reject);
                   return;
                 }
                 resolve(result);
               }];
}

- (void)resumePendingFactoryReset:
            (JS::NativeBotaDeviceSDK::NativeConnectedDevice &)device
                  currentBindingGeneration:(double)currentBindingGeneration
                                    resolve:(RCTPromiseResolveBlock)resolve
                                     reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      resumePendingFactoryResetWithID:device.id_()
                       serialNumber:device.serialNumber()
                         deviceType:device.deviceType()
                    firmwareVersion:device.firmwareVersion()
                    hardwareRevision:device.hardwareRevision()
                      isProvisioned:device.isProvisioned()
                    connectionState:device.connectionState()
                                mtu:device.mtu()
           currentBindingGeneration:currentBindingGeneration
                         completion:^(NSDictionary *_Nullable result, NSError *_Nullable error) {
                           if (error != nil) {
                             BotaRejectAppleError(error, reject);
                             return;
                           }
                           resolve(result);
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

- (void)resolveFactoryResetGrant:(NSString *)requestId
                       grantBlob:(NSString *)grantBlob
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  [[BotaDeviceSDKAppleBridge shared]
      resolveFactoryResetGrantWithRequestID:requestId
                                  grantBlob:grantBlob
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
