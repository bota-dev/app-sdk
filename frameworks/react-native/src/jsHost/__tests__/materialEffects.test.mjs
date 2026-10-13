import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';

const { JsMaterialEffects } = loadSource('materialEffects.ts');
function fixture() {
  const events = [], cleanups = [], codecs = [];
  const controller = new AbortController();
  let current = true;
  const core = { codec(name, input) { codecs.push([name, input]); return Array(179).fill(1); } };
  const effects = new JsMaterialEffects({
    core,
    emit(name, value) { events.push([name, value]); },
    checkOwner() { if (!current) throw Object.assign(new Error('stale'), { code: 'stale_owner' }); },
  });
  const context = { operationId: 'op', operation: 'Provision', requestId: '9007199254740993',
    generation: '9007199254740994', cancellationId: '01', signal: controller.signal,
    addCleanup(action) { cleanups.push(action); }, async emit() {} };
  const provisioning = { PrepareProvisioning: { device: 'SERIAL', nonce: Array(16).fill(2),
    device_public_key: Array(64).fill(3) } };
  const reset = { PrepareFactoryResetGrant: { device: 'SERIAL', nonce: Array(16).fill(4) } };
  return { effects, core, events, cleanups, codecs, context, controller, provisioning, reset,
    stale() { current = false; } };
}

test('provisioning broker emits native-compatible hex metadata and waits for the exact application response', async () => {
  const f = fixture();
  f.effects.registerProvisioning('op', { serialNumber: 'SERIAL' });
  const waiting = f.effects.handler(f.provisioning, f.context);
  const [name, event] = f.events[0];
  assert.equal(name, 'onProvisioningMaterialRequested');
  assert.equal(event.nonce, '02'.repeat(16));
  assert.equal(event.devicePublicKey, '03'.repeat(64));
  assert.equal(event.requestId, 'material:op:9007199254740994:9007199254740993');
  await assert.rejects(f.effects.resolveProvisioningMaterial('foreign', { apiEndpoint: 'https://example.test',
    deviceToken: 'token', mtu: 23 }), error => error.code === 'stale_material_request');
  await f.effects.resolveProvisioningMaterial(event.requestId, { apiEndpoint: String.fromCharCode(1), deviceToken: 'token', mtu: 23 });
  const result = await waiting;
  assert.deepEqual(result.ProvisioningMaterialPrepared.material.api_endpoint, [1]);
  assert.equal(Buffer.from(result.ProvisioningMaterialPrepared.material.device_token).toString(), 'token');
  assert.equal(result.ProvisioningMaterialPrepared.material.mtu, 23);
  await assert.rejects(f.effects.resolveProvisioningMaterial(event.requestId, {}), error => error.code === 'stale_material_request');
});

test('factory reset validates through shared Rust against immutable caller generation before delivery', async () => {
  const f = fixture();
  const registration = { serialNumber: 'SERIAL', commandId: 'command', bindingGeneration: 5 };
  f.effects.registerFactoryReset('op', registration);
  registration.bindingGeneration = 6;
  const waiting = f.effects.handler(f.reset, { ...f.context, operation: 'FactoryReset' });
  const event = f.events[0][1];
  assert.equal(event.bindingGeneration, 5);
  assert.equal(event.commandId, 'command');
  await f.effects.resolveFactoryResetGrant(event.requestId, 'signed-document');
  assert.deepEqual(f.codecs, [['validateFactoryResetGrant', { grantBlob: 'signed-document', bindingGeneration: '5' }]]);
  assert.equal((await waiting).FactoryResetGrantPrepared.grant.length, 179);
});

test('invalid grant cannot reach the core or retain an unresolved material callback', async () => {
  const f = fixture();
  f.effects.registerFactoryReset('op', { serialNumber: 'SERIAL', commandId: 'command', bindingGeneration: 5 });
  f.core.codec = () => { throw Object.assign(new Error('invalid grant'), { code: 'invalid_factory_reset_grant' }); };
  const waiting = f.effects.handler(f.reset, { ...f.context, operation: 'FactoryReset' });
  const rejected = assert.rejects(waiting, error => error.code === 'invalid_factory_reset_grant');
  await assert.rejects(f.effects.resolveFactoryResetGrant(f.events[0][1].requestId, 'wrong'),
    error => error.code === 'invalid_factory_reset_grant');
  await rejected;
});

test('cancel removes broker ownership and rejects late application material without dispatch', async () => {
  const f = fixture();
  f.effects.registerProvisioning('op', { serialNumber: 'SERIAL' });
  const waiting = f.effects.handler(f.provisioning, f.context);
  const rejected = assert.rejects(waiting, error => error.code === 'operation_cancelled');
  f.controller.abort();
  await rejected;
  await assert.rejects(f.effects.resolveProvisioningMaterial(f.events[0][1].requestId,
    { apiEndpoint: 'https://example.test', deviceToken: 'token', mtu: 23 }), error => error.code === 'stale_material_request');
  await f.cleanups[0]();
});

test('scope replacement and device mismatch prevent material provider delivery', async () => {
  const f = fixture();
  f.effects.registerProvisioning('op', { serialNumber: 'SERIAL' });
  await assert.rejects(f.effects.handler({ PrepareProvisioning: { ...f.provisioning.PrepareProvisioning, device: 'FOREIGN' } }, f.context),
    error => error.code === 'material_identity_mismatch');
  assert.equal(f.events.length, 0);
  const waiting = f.effects.handler(f.provisioning, f.context);
  const rejected = assert.rejects(waiting, error => error.code === 'stale_owner');
  f.stale();
  await assert.rejects(f.effects.resolveProvisioningMaterial(f.events[0][1].requestId,
    { apiEndpoint: 'https://example.test', deviceToken: 'token', mtu: 23 }), error => error.code === 'stale_owner');
  await rejected;
});

test('material rejection uses stable redacted errors and operation release settles pending callbacks', async () => {
  const f = fixture();
  f.effects.registerProvisioning('op', { serialNumber: 'SERIAL' });
  const waiting = f.effects.handler(f.provisioning, f.context);
  const rejected = assert.rejects(waiting, error => error.code === 'application_material_rejected' && !error.message.includes('secret'));
  await f.effects.rejectApplicationMaterial(f.events[0][1].requestId, 'secret');
  await rejected;
  const second = f.effects.handler(f.provisioning, { ...f.context, requestId: '2' });
  const cancelled = assert.rejects(second, error => error.code === 'operation_cancelled');
  f.effects.release('op');
  await cancelled;
});
