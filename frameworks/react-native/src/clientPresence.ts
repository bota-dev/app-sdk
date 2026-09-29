/** Optional diagnostics, not device attestation or command authority. */
export interface SdkClientContext {
  schema_version: 1;
  session_id: string;
  sequence: number;
  platform: 'ios' | 'android';
  sdk_package: string;
  sdk_version: string;
}

export interface ClientPresence {
  nextReport(deviceId: string): Promise<SdkClientContext | null>;
}

/** Read fresh BLE status only while the same verified connection and host scope survive.
 * The caller owns authentication, binding generation, scheduling and HTTP.
 * Unavailable presence or a changed scope/session skips reporting without BLE writes.
 */
export async function readClientPresenceObservation<T>(options: {
  presence: ClientPresence;
  deviceId: string;
  isCurrent(): boolean;
  readStatus(): Promise<T>;
}): Promise<{ status: T; clientContext: SdkClientContext } | null> {
  if (!options.isCurrent()) return null;
  const before = await options.presence.nextReport(options.deviceId);
  if (!before || !options.isCurrent()) return null;
  const status = await options.readStatus();
  if (!options.isCurrent()) return null;
  const after = await options.presence.nextReport(options.deviceId);
  if (!after || !options.isCurrent() || before.session_id !== after.session_id) return null;
  return { status, clientContext: after };
}
