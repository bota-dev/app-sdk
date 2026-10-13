import type { BleManager } from 'react-native-ble-plx';
import { createBlePlxPort, type BlePlxManager } from '../src/runtime';

declare const manager: BleManager;
const portManager: BlePlxManager = manager;
createBlePlxPort(portManager);
declare const disconnect: Parameters<BlePlxManager['onDeviceDisconnected']>[1];
disconnect(null, null);
