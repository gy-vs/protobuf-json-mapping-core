// Base64 codec. Serialization always emits canonical standard-alphabet
// base64 with padding; parsing accepts standard or URL-safe alphabet, with
// or without padding (per the proto3 JSON spec).

const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64Encode(data: Uint8Array): string {
  let out = '';
  const len = data.length;
  const rem = len % 3;
  const main = len - rem;
  for (let i = 0; i < main; i += 3) {
    const n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out += STD[(n >> 18) & 63] + STD[(n >> 12) & 63] + STD[(n >> 6) & 63] + STD[n & 63];
  }
  if (rem === 1) {
    const n = data[main] << 16;
    out += STD[(n >> 18) & 63] + STD[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (data[main] << 16) | (data[main + 1] << 8);
    out += STD[(n >> 18) & 63] + STD[(n >> 12) & 63] + STD[(n >> 6) & 63] + '=';
  }
  return out;
}

export function base64Decode(text: string): Uint8Array {
  if (text.length === 0) return new Uint8Array(0);
  const urlSafe = text.includes('-') || text.includes('_');
  const alphabet = urlSafe ? URL : STD;
  const padIndex = text.indexOf('=');
  const body = padIndex === -1 ? text : text.slice(0, padIndex);
  const padding = padIndex === -1 ? 0 : text.length - padIndex;
  // Padding, when present, must be trailing and complete the final quantum.
  if (padIndex !== -1 && (!text.slice(padIndex).split('').every((c) => c === '=') || padding > 2)) {
    throw new TypeError(`invalid base64 input: ${text}`);
  }
  if (body.length % 4 === 1) {
    throw new TypeError(`invalid base64 input: ${text}`);
  }
  const values: number[] = [];
  for (const c of body) {
    const v = alphabet.indexOf(c);
    if (v === -1) throw new TypeError(`invalid base64 input: ${text}`);
    values.push(v);
  }
  const expectedPad = (4 - (values.length % 4)) % 4;
  if (padIndex !== -1 && padding !== expectedPad) {
    throw new TypeError(`invalid base64 padding: ${text}`);
  }
  const outLen = Math.floor(values.length * 6) / 8;
  const out = new Uint8Array(Math.floor(outLen));
  let bitBuf = 0;
  let bitCount = 0;
  let o = 0;
  for (const v of values) {
    bitBuf = (bitBuf << 6) | v;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[o++] = (bitBuf >> bitCount) & 255;
    }
  }
  // Non-zero bits beyond the encoded byte length are invalid unpadded data.
  // A 3-quantum tail leaves 2 bits which must be zero; a 2-quantum tail
  // (already fully consumed above) leaves no required-zero residue.
  const residue = values.length % 4;
  if (residue === 3 && bitCount > 0 && (bitBuf & ((1 << bitCount) - 1)) !== 0) {
    throw new TypeError(`invalid base64 input (trailing bits): ${text}`);
  }
  return out;
}
