import type { BotaDeviceSDKClient } from '../client';

let defaultClient: BotaDeviceSDKClient | null = null;
let testClient: BotaDeviceSDKClient | null = null;

type CompatibilityDisconnectionListener = (error?: Error) => void;

const disconnectionListeners = new WeakMap<
  BotaDeviceSDKClient,
  Set<CompatibilityDisconnectionListener>
>();

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

export const subscribeToCompatibilityDisconnections = (
  client: BotaDeviceSDKClient,
  listener: CompatibilityDisconnectionListener
): { remove: () => void } => {
  const listeners = disconnectionListeners.get(client) ?? new Set();
  listeners.add(listener);
  disconnectionListeners.set(client, listeners);
  return {
    remove: () => {
      listeners.delete(listener);
      if (listeners.size === 0) disconnectionListeners.delete(client);
    },
  };
};

export const reportCompatibilityDisconnection = (
  client: BotaDeviceSDKClient,
  error?: Error
): void => {
  for (const listener of disconnectionListeners.get(client) ?? []) {
    listener(error);
  }
};
