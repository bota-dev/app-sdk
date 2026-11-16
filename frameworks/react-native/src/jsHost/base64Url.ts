import { Buffer } from 'buffer';

/** The mobile Buffer polyfill supports base64, but not Node's base64url encoding. */
export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
