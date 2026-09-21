// Field-name conversion helpers used by canonical JSON mapping.

/**
 * proto snake_case -> proto lowerCamelCase.
 *
 * The proto spec strips underscores and upper-cases the letter after them;
 * a run of consecutive underscores (no letter to capitalize) is illegal.
 * Leading underscores are preserved.
 */
export function snakeToCamel(name: string): string {
  let out = '';
  let cap = false;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (ch === '_') {
      // "_" at the end or followed by another underscore is not a valid
      // proto field name; keep the underscore rather than silently corrupting.
      if (i === 0) {
        out += ch;
        continue;
      }
      if (i + 1 >= name.length || name[i + 1] === '_') {
        out += ch;
        continue;
      }
      cap = true;
    } else {
      out += cap ? ch.toUpperCase() : ch;
      cap = false;
    }
  }
  return out;
}

/**
 * lowerCamelCase -> snake_case (used for FieldMask paths). Each dot-separated
 * segment is converted independently.
 */
export function camelToSnake(name: string): string {
  return name
    .split('.')
    .map((segment) => segment.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase()))
    .join('.');
}

const B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Standard (padded) base64, the canonical JSON form of `bytes`. */
export function base64Encode(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i];
    const b1 = i + 1 < data.length ? data[i + 1] : 0;
    const b2 = i + 2 < data.length ? data[i + 2] : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += B64_STD[(triplet >> 18) & 63];
    out += B64_STD[(triplet >> 12) & 63];
    out += i + 1 < data.length ? B64_STD[(triplet >> 6) & 63] : '=';
    out += i + 2 < data.length ? B64_STD[triplet & 63] : '=';
  }
  return out;
}

/**
 * Decode canonical or URL-safe base64. Padding is optional but, when
 * present, must be correct. Whitespace is not allowed.
 */
export function base64Decode(text: string): Uint8Array {
  const alphabet = text.includes('-') || text.includes('_') ? B64_URL : B64_STD;
  let s = text.replace(/=+$/, '');
  if (/=/.test(s)) throw new Error(`invalid base64 padding: ${JSON.stringify(text)}`);
  if (s.includes('-') || s.includes('_')) {
    if (alphabet !== B64_URL) throw new Error(`mixed base64 alphabets: ${JSON.stringify(text)}`);
  }
  if (s.length === 0) return new Uint8Array(0);
  if (s.length % 4 === 1) throw new Error(`invalid base64 length: ${JSON.stringify(text)}`);
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  s = s + '='.repeat(pad);
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const vals: number[] = [];
    for (let j = 0; j < 4; j++) {
      const ch = s[i + j];
      if (ch === '=') vals.push(0);
      else {
        const v = alphabet.indexOf(ch);
        if (v < 0) throw new Error(`invalid base64 character ${JSON.stringify(ch)}`);
        vals.push(v);
      }
    }
    const triplet = (vals[0] << 18) | (vals[1] << 12) | (vals[2] << 6) | vals[3];
    out.push((triplet >> 16) & 255);
    if (s[i + 2] !== '=') out.push((triplet >> 8) & 255);
    if (s[i + 3] !== '=') out.push(triplet & 255);
  }
  return Uint8Array.from(out);
}
