// Public test material only. This is a fixture audit, not a production verifier.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(name, import.meta.url));
const json = name => JSON.parse(read(name));
const hex = value => Buffer.from(value, 'hex');
const hash = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const domain = value => Buffer.from(`${value}\0`, 'ascii');
const same = (a, b) => assert.deepEqual(a, b);
const order = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
let signatures = 0;
for (const [name, digest] of Object.entries(json('SHA256SUMS.json'))) {
  assert.equal(hash(read(name)).toString('hex'), digest, name);
}
function header(bytes, magic, kind, length) {
  assert.equal(bytes.length, length);
  assert.equal(bytes.subarray(0, 8).toString('ascii'), magic);
  assert.equal(bytes.readUInt16LE(8), 1);
  assert.equal(bytes.readUInt16LE(10), kind);
  assert.equal(bytes.readUInt32LE(12), length);
  assert(bytes.subarray(16, 32).some(v => v !== 0));
}
function signed(bytes, magic, kind, length, label, keys, context) {
  header(bytes, magic, kind, length);
  same(bytes.subarray(32, 64), context);
  const raw = hex(keys.backendPublicKeyHex);
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
    x: raw.subarray(0, 32).toString('base64url'), y: raw.subarray(32).toString('base64url') } });
  const sig = bytes.subarray(-64);
  const r = BigInt(`0x${sig.subarray(0, 32).toString('hex')}`);
  const s = BigInt(`0x${sig.subarray(32).toString('hex')}`);
  assert(r > 0n && r < order && s > 0n && s <= order / 2n);
  const message = Buffer.concat([domain(label), bytes.subarray(0, -64)]);
  const check = (m, signature) => verify('sha256', m, { key, dsaEncoding: 'ieee-p1363' }, signature);
  assert(check(message, sig));
  const changed = Buffer.from(sig); changed[0] ^= 1;
  assert(!check(message, changed));
  assert(!check(Buffer.concat([domain(`${label}-WRONG`), bytes.subarray(0, -64)]), sig));
  signatures++;
}
function authorization(bytes, keys) {
  const context = hash(domain('BOTA-MARKER-CONTEXT-V1'), bytes.subarray(64, 240));
  signed(bytes, 'BOTASTR1', 0x1100, 468, 'BOTA-STREAM-AUTH-V1', keys, context);
  assert.equal(bytes[65], 2);
  return context;
}
function markerAuthorization(bytes, audio, keys, context) {
  signed(bytes, 'BOTAMRK1', 0x1003, 280, 'BOTA-MARKER-AUTH-V1', keys, context);
  same(bytes.subarray(64, 96), hash(audio));
  same(bytes.subarray(96, 144), audio.subarray(240, 288));
}
function completion(fixture, keys) {
  const audio = hex(fixture.audioProofHex), marker = hex(fixture.markerCompletionHex);
  const auth = hex(fixture.authorizationHex), context = authorization(auth, keys);
  markerAuthorization(hex(fixture.markerAuthorizationHex), auth, keys, context);
  signed(audio, 'BOTASTR1', 0x1101, 296, 'BOTA-STREAM-AUDIO-COMPLETE-V1', keys, context);
  signed(marker, 'BOTAMRK1', 0x1002, 296, 'BOTA-MARKER-COMPLETE-V1', keys, context);
  const stop = hex(fixture.audioStopHex), seal = hex(fixture.markerSealHex);
  header(stop, 'BOTASTR1', 2, 168); header(seal, 'BOTAMRK1', 2, 200);
  same(audio.subarray(16, 32), stop.subarray(16, 32));
  same(marker.subarray(16, 32), seal.subarray(16, 32));
  same(audio.subarray(168, 200), hash(stop));
  same(marker.subarray(188, 220), hash(seal));
  same(marker.subarray(124, 156), hash(audio));
  same(marker.subarray(156, 188), audio.subarray(200, 232));
  assert.equal(marker.readUInt16LE(228), 2);
  assert.equal(marker.readUInt16LE(230), 0);
  const snapshot = hex(fixture.canonicalSnapshotHex);
  same(marker.subarray(92, 124), hash(domain('BOTA-MARKER-SNAPSHOT-V1'), snapshot));
  const changed = Buffer.from(snapshot); changed[0] ^= 1;
  assert.notDeepEqual(marker.subarray(92, 124), hash(domain('BOTA-MARKER-SNAPSHOT-V1'), changed));
  assert.equal(snapshot.readUInt16LE(0), 1);
  assert.equal(snapshot.readUInt16LE(2), 1);
  assert.equal(snapshot.length, 36 + 92 * snapshot.readUInt32LE(20) + 52 * snapshot.readUInt32LE(24));
  assert.equal(snapshot.readUInt32LE(24), marker.readUInt32LE(220));
  assert.equal(snapshot.readUInt32LE(28), marker.readUInt32LE(224));
  assert.equal(audio.readBigUInt64LE(68), 1100n);
  assert.equal(audio.readBigUInt64LE(76), 4700n);
  assert(auth.readBigUInt64LE(316) < audio.readBigUInt64LE(68));
  const wrong = Buffer.from(context); wrong[0] ^= 1;
  assert.throws(() => signed(marker, 'BOTAMRK1', 0x1002, 296, 'BOTA-MARKER-COMPLETE-V1', keys, wrong));
}
const start = json('recording-stream-direct-start.json'), one = start.scenarios.oneMarker;
const auth = hex(one.authorizationHex), context = authorization(auth, start.keys);
same(context, hex(one.contextDigestHex));
markerAuthorization(hex(one.markerAuthorizationHex), auth, start.keys, context);
for (const [field, source, length] of [
  ['context_base64', 'contextHex', 176], ['authorization_base64', 'authorizationHex', 468],
  ['marker_authorization_base64', 'markerAuthorizationHex', 280], ['key_grant_base64', 'keyGrantHex', 257],
]) {
  const bytes = Buffer.from(start.startResponse[field], 'base64');
  assert.equal(bytes.length, length); same(bytes, hex(one[source]));
}
const markerAck = hex(one.ackHex);
signed(markerAck, 'BOTAMRK1', 0x1001, 208, 'BOTA-MARKER-ACCEPT-V1', start.keys, context);
same(markerAck.subarray(112, 144), hash(domain('BOTA-MARKER-EVENT-V1'), hex(one.markerBodyHex)));
same(markerAck.subarray(16, 32), hex(one.markerHex).subarray(16, 32));
const ackFixture = json('recording-stream-audio-ack.json');
const ack = hex(ackFixture.acknowledgementHex), chunk = hex(ackFixture.audioDocumentHex);
const ackContext = authorization(hex(ackFixture.scenario.authorizationHex), ackFixture.keys);
signed(ack, 'BOTASTR1', 0x1102, 224, 'BOTA-STREAM-AUDIO-ACCEPT-V1', ackFixture.keys, ackContext);
same(ack.subarray(88, 120), hash(chunk)); same(ack.subarray(120, 152), hex(ackFixture.chainHex));
same(ack.subarray(16, 32), chunk.subarray(16, 32));
assert.equal(ack.readUInt32LE(84), chunk.readUInt32LE(64));
assert.throws(() => header(ack, 'BOTASTR1', 0x1101, 296));
completion(json('recording-stream-c-direct.json'), start.keys);
const complete = json('recording-stream-completion-interop.json'); completion(complete, complete.keys);
for (const vector of json('recording-markers-v1.json').vectors) {
  if (vector.expected !== 'accept') continue; // Rejections are for the integrator's real decoder.
  const body = hex(vector.hex); assert.equal(body.length, 52);
  assert.equal(hash(domain('BOTA-MARKER-EVENT-V1'), body).toString('hex'), vector.marker_digest);
}
console.log(`PASS: 5 pinned fixtures; ${signatures} signed documents; identity/hash bindings and negative mutations. HPKE/runtime acceptance is separate.`);
