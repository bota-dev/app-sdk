import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBackgroundBleSession } = require('../lib/commonjs/backgroundBleSession.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Android advertises availability after promotion and can recover from a refused start', async () => {
  let visible = false, attempts = 0, warnings = 0, confirm;
  const session = createBackgroundBleSession('android', {
    async setActive(on) {
      if (!on) return;
      if (++attempts === 1) throw new Error('start refused');
      await new Promise(resolve => { confirm = resolve; });
    }, async waitToRetryFor() {}, async cancelRetry() {},
  }, () => visible, () => warnings++);
  session.backgroundBle.setActive(true);
  assert.equal(attempts, 0);
  visible = true;
  session.resume(); await tick();
  assert.equal(warnings, 1);
  assert.equal(session.backgroundBle.isAvailable(), false);
  session.resume();
  assert.equal(session.backgroundBle.isAvailable(), false);
  confirm(); await tick();
  assert.equal(session.backgroundBle.isAvailable(), true);
  session.backgroundBle.setActive(false);
  assert.equal(session.backgroundBle.isAvailable(), false);
});

test('native methods are checked and cancellation targets only the submitted retry', async () => {
  assert.equal(createBackgroundBleSession('android', {}, () => true, () => {}), undefined);
  const waiting = new Map(), cancelled = [];
  const session = createBackgroundBleSession('ios', {
    async setActive() {},
    waitToRetryFor(token) { return new Promise(resolve => waiting.set(token, resolve)); },
    async cancelRetry(token) { cancelled.push(token); waiting.get(token)(); },
  }, () => false, () => {});
  session.backgroundBle.setActive(true);
  const first = new AbortController(), second = new AbortController();
  const one = session.backgroundBle.waitToRetry(2000, first.signal);
  const two = session.backgroundBle.waitToRetry(2000, second.signal);
  await tick();
  assert.equal(waiting.size, 2);
  first.abort(); await one;
  assert.deepEqual(cancelled, [[...waiting.keys()][0]]);
  second.abort(); await two;
  assert.equal(cancelled.length, 2);
});
