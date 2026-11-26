interface NativeSession {
  setActive(active: boolean): Promise<void>;
  waitToRetryFor(token: string, delayMs: number): Promise<void>;
  cancelRetry(token: string): Promise<void>;
}

let sequence = 0;

/** The host owns visibility, native module resolution and logging. */
export function createBackgroundBleSession(platform: string, bridge: Partial<NativeSession> | undefined,
  visible: () => boolean, unavailable: () => void) {
  if ((platform !== 'ios' && platform !== 'android') || !bridge ||
      typeof bridge.setActive !== 'function' || typeof bridge.waitToRetryFor !== 'function' ||
      typeof bridge.cancelRetry !== 'function') return undefined;
  const native = bridge as NativeSession;
  let wanted = false;
  let active = false;
  let generation = 0;
  let changing: Promise<void> | undefined;
  const activate = () => {
    if (!wanted || active || changing || (platform === 'android' && !visible())) return;
    const ticket = ++generation;
    changing = native.setActive(true).then(() => {
      if (ticket === generation) active = true;
    }).catch(() => { if (ticket === generation) unavailable(); })
      .finally(() => { if (ticket === generation) changing = undefined; });
  };
  const setActive = (value: boolean) => {
    wanted = value;
    if (value) { activate(); return; }
    generation++;
    active = false;
    changing = undefined;
    void native.setActive(false).catch(unavailable);
  };
  return {
    resume: activate,
    backgroundBle: {
      setActive,
      isAvailable: () => active,
      canRecover: () => active || changing !== undefined,
      async waitToRetry(delayMs: number, signal?: AbortSignal) {
        await changing;
        if (!active || signal?.aborted) throw new Error('Bluetooth background session unavailable');
        const token = String(++sequence);
        const cancel = () => { void native.cancelRetry(token).catch(unavailable); };
        signal?.addEventListener('abort', cancel, { once: true });
        try { await native.waitToRetryFor(token, delayMs); }
        finally { signal?.removeEventListener('abort', cancel); }
      },
    },
  };
}
