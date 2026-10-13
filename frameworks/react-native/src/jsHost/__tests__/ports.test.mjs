import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';

const { BOTA_JS_HOST_PORT_API_VERSION, validateJsHostPorts } = loadSource('ports.ts');

function fixture() {
  let calls = 0;
  const primitive = () => { calls += 1; throw new Error('Preflight must not invoke ports'); };
  const ports = {
    apiVersion: 1, platform: 'ios', randomBytes: primitive,
    ble: Object.fromEntries(['scan', 'connect', 'discoverServices', 'disconnect', 'read', 'write', 'subscribe']
      .map(name => [name, primitive])),
    persistence: { namespace: 'account/project/end-user/production', load: primitive, save: primitive, remove: primitive },
  };
  return { ports, primitive, calls: () => calls };
}

test('versioned foreground ports pass before any installed primitive is invoked', () => {
  const f = fixture();
  assert.equal(BOTA_JS_HOST_PORT_API_VERSION, 1);
  validateJsHostPorts(f.ports);
  assert.equal(f.calls(), 0);
});

test('absent or incompatible installed contract fails before examining other capabilities', () => {
  for (const ports of [undefined, null, [], {}, { apiVersion: 0 }, { apiVersion: 2 }, { apiVersion: '1' }]) {
    assert.throws(() => validateJsHostPorts(ports), { code: 'host_contract_unsupported', operation: 'Configure' });
  }
});

test('scope identity must be a bounded nonempty string', () => {
  for (const namespace of [undefined, null, '', ' \r\n ', 'x'.repeat(4097), '界'.repeat(1366)]) {
    const f = fixture();
    f.ports.persistence.namespace = namespace;
    assert.throws(() => validateJsHostPorts(f.ports), { code: 'invalid_scope' });
    assert.equal(f.calls(), 0);
  }
});

test('each required BLE, persistence and entropy primitive is checked before resource acquisition', async t => {
  const paths = ['randomBytes', 'ble', 'persistence', ...['scan', 'connect', 'discoverServices', 'disconnect', 'read', 'write', 'subscribe']
    .map(name => `ble.${name}`), ...['load', 'save', 'remove'].map(name => `persistence.${name}`)];
  for (const path of paths) await t.test(path, () => {
    const f = fixture();
    const keys = path.split('.');
    const parent = keys.length === 1 ? f.ports : f.ports[keys[0]];
    parent[keys.at(-1)] = undefined;
    assert.throws(() => validateJsHostPorts(f.ports), { code: `missing_primitive:${path}` });
    assert.equal(f.calls(), 0);
  });
});

test('a declared file capability is complete while create and flush remain optional', async t => {
  const methods = ['open', 'metadata', 'append', 'truncate', 'read', 'finalize', 'remove'];
  for (const method of methods) await t.test(method, () => {
    const f = fixture();
    f.ports.files = Object.fromEntries(methods.map(name => [name, f.primitive]));
    delete f.ports.files[method];
    assert.throws(() => validateJsHostPorts(f.ports), { code: `missing_primitive:files.${method}` });
    assert.equal(f.calls(), 0);
  });
  const f = fixture();
  f.ports.files = Object.fromEntries(methods.map(name => [name, f.primitive]));
  validateJsHostPorts(f.ports);
  assert.equal(f.calls(), 0);
});

test('declared network and lifecycle ports are checked without requiring background execution', () => {
  const f = fixture();
  f.ports.network = { download: f.primitive, upload: f.primitive };
  f.ports.lifecycle = { current: f.primitive, observe: f.primitive, backgroundExecution: false };
  validateJsHostPorts(f.ports);
  f.ports.network.upload = null;
  assert.throws(() => validateJsHostPorts(f.ports), { code: 'missing_primitive:network.upload' });
  f.ports.network.upload = f.primitive;
  f.ports.lifecycle.backgroundExecution = undefined;
  assert.throws(() => validateJsHostPorts(f.ports), { code: 'missing_primitive:lifecycle.backgroundExecution' });
  assert.equal(f.calls(), 0);
});

test('optional hooks must be callable when supplied, and scope signals are structural', () => {
  const cases = [['ble', 'getMtu'], ['ble', 'observeDisconnect'], ['ble', 'writeOpaque'], ['', 'checkScope'],
    ['files', 'create'], ['files', 'flush'], ['network', 'registerDownload'], ['network', 'unregister']];
  for (const [prefix, hook] of cases) {
    const f = fixture();
    f.ports.files = Object.fromEntries(['open', 'metadata', 'append', 'truncate', 'read', 'finalize', 'remove'].map(name => [name, f.primitive]));
    f.ports.network = { download: f.primitive, upload: f.primitive };
    const parent = prefix ? f.ports[prefix] : f.ports;
    parent[hook] = null;
    assert.throws(() => validateJsHostPorts(f.ports), { code: `missing_primitive:${prefix ? `${prefix}.` : ''}${hook}` });
    parent[hook] = f.primitive;
    f.ports.signal = new AbortController().signal;
    validateJsHostPorts(f.ports);
    assert.equal(f.calls(), 0);
  }
  const f = fixture();
  f.ports.signal = { aborted: false, addEventListener: f.primitive };
  assert.throws(() => validateJsHostPorts(f.ports), { code: 'missing_primitive:signal.removeEventListener' });
});
