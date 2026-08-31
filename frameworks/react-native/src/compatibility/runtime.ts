import type { BotaDeviceSDKClient } from '../client';

let defaultClient: BotaDeviceSDKClient | null = null;
let testClient: BotaDeviceSDKClient | null = null;

export const setDefaultCompatibilityClient = (
  client: BotaDeviceSDKClient
): void => {
  defaultClient = client;
};

export const getCompatibilityClient = (): BotaDeviceSDKClient => {
  const client = testClient ?? defaultClient;
  if (!client) {
    throw new Error('BotaDeviceSDK compatibility runtime is not initialized');
  }
  return client;
};

export const setCompatibilityClientForTesting = (
  client: BotaDeviceSDKClient | null
): void => {
  testClient = client;
};
