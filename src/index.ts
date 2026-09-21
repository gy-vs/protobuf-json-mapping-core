export function decodeVarint(data: Uint8Array, offset = 0) {
  let value = 0n, shift = 0n;
  for (let i = offset; i < data.length && i < offset + 10; i++) {
    const byte = data[i];
    value |= BigInt(byte & 127) << shift;
    if (!(byte & 128)) return { value, length: i - offset + 1 };
    shift += 7n;
  }
  return null;
}

// Wire-level primitives (kept for compatibility with the low-level API).
export type Field = { number: number; wireType: number; raw: Uint8Array };

export * from './names.js';
export * from './base64.js';
export * from './descriptors.js';
export * from './dynamic.js';
export * from './wellknown.js';
export {
  toJson,
  toJsonValue,
  fromJson,
  JsonFormatError,
  type ToJsonOptions,
  type FromJsonOptions,
} from './json.js';
