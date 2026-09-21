// Public API: descriptor model, dynamic messages, and canonical JSON mapping.

export function decodeVarint(data: Uint8Array, offset = 0): { value: bigint; length: number } | null {
  let value = 0n;
  let shift = 0n;
  for (let i = offset; i < data.length && i < offset + 10; i++) {
    const byte = data[i];
    value |= BigInt(byte & 127) << shift;
    if (!(byte & 128)) return { value, length: i - offset + 1 };
    shift += 7n;
  }
  return null;
}

/** Low-level wire field (pre-descriptor API retained for compatibility). */
export type Field = { number: number; wireType: number; raw: Uint8Array };

/** Minimal wire-level message container; see {@link DynamicMessage} for the
 * descriptor-based value tree. */
export class WireMessage {
  fields: Field[] = [];
  add(field: Field): void {
    this.fields.push(field);
  }
  unknown(): Field[] {
    return this.fields.slice();
  }
}

export {
  DescriptorPool,
  EnumDescriptor,
  FieldDescriptor,
  MessageDescriptor,
  standardPool,
} from './descriptors.js';
export type {
  EnumSpec,
  FieldSpec,
  FieldType,
  FileSpec,
  MessageSpec,
  Syntax,
} from './descriptors.js';

export {
  DynamicMessage,
  defaultValue,
  is32Bit,
  is64Bit,
  isScalarDefault,
  canonicalTypeUrl,
} from './dynamic.js';
export type { EnumNumber, JsScalar, JsValue } from './dynamic.js';
export { MessageError } from './dynamic.js';

export {
  JsonParser,
  JsonPrinter,
  JsonFormatError,
} from './json.js';
export type { JsonParseOptions, JsonPrintOptions } from './json.js';

export { base64Decode, base64Encode, camelToSnake, snakeToCamel } from './names.js';
export {
  formatDuration,
  formatTimestamp,
  parseDuration,
  parseTimestamp,
  TimeParseError,
} from './time.js';
export type { SecondsNanos } from './time.js';
