import assert from 'node:assert/strict';
import { createHash, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
/** Test peer uses Node/OpenSSL, independently of the production Rust AEAD. */
export function localWifiControlPeer() {
  const key=Buffer.alloc(32,7), envelope=Buffer.alloc(509,8);
  envelope.write('BOTAWFC1'); envelope.set([0,16,0,1,0,3,0,1],8);
  const salt=createHash('sha256').update(envelope).digest();
  const derive=direction=>Buffer.from(hkdfSync('sha256',key,salt,`bota/local-wifi/control/v1/${direction}`,40));
  const app=derive('app'), device=derive('device'); let send=0,receive=0;
  const aad=prefix=>Buffer.concat([Buffer.from('bota/local-wifi/control/v1'),prefix]);
  const nonce=(keys,counter)=>{const b=Buffer.alloc(12);keys.copy(b,0,32);b.writeUInt32LE(counter,8);return b;};
  return {
    grant: JSON.stringify({format:'bota-local-wifi-control-v1',control_key_base64:key.toString('base64'),envelope_base64:envelope.toString('base64'),expires_in_seconds:300}),
    envelope,
    seal(frame){const prefix=Buffer.alloc(16);Buffer.from(frame).copy(prefix,0,0,12);prefix.writeUInt32LE(send,12);
      const c=createCipheriv('chacha20-poly1305',device.subarray(0,32),nonce(device,send++),{authTagLength:16});c.setAAD(aad(prefix),{plaintextLength:frame.length-12});
      return Buffer.concat([prefix,c.update(frame.subarray(12)),c.final(),c.getAuthTag()]);},
    open(wire){wire=Buffer.from(wire);assert.equal(wire.readUInt32LE(12),receive);
      const c=createDecipheriv('chacha20-poly1305',app.subarray(0,32),nonce(app,receive++),{authTagLength:16});
      c.setAAD(aad(wire.subarray(0,16)),{plaintextLength:wire.length-32});c.setAuthTag(wire.subarray(-16));
      return Buffer.concat([wire.subarray(0,12),c.update(wire.subarray(16,-16)),c.final()]);},
  };
}
