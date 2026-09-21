// Dynamic message value tree.
//
// Presence is modeled explicitly rather than inferred from values, so
// `field = 0` and `field` unset are distinguishable for every field:
//   - proto2 optional/required, proto3 `optional`, oneof and message fields
//     have explicit presence (has() reflects whether set was called);
//   - plain proto3 scalar fields have no presence: setDefault()-style values
//     are reported as absent by has()/presentFields(), matching proto
//     serialization semantics. Callers can still observe the stored value
//     through get() after setField().
//
// 64-bit integers use bigint, bytes use Uint8Array.

import {
  DescriptorPool,
  FieldDescriptor,
  MessageDescriptor,
} from './descriptors.js';
import { base64Decode } from './names.js';

export type JsScalar = string | number | bigint | boolean | Uint8Array;
export type JsValue = JsScalar | DynamicMessage | JsValue[];

/** Marker holding a typed enum number (plain number at runtime). */
export type EnumNumber = number;

function deepCopy(value: JsValue): JsValue {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof DynamicMessage) return value.clone();
  if (Array.isArray(value)) return value.map(deepCopy);
  return value;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (a instanceof DynamicMessage && b instanceof DynamicMessage) return a.equals(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => valuesEqual(v, b[i]));
  }
  return Object.is(a, b);
}

export class MessageError extends Error {}

function intRanges(type: string): [bigint, bigint] {
  switch (type) {
    case 'int32':
    case 'sint32':
    case 'sfixed32':
      return [-2147483648n, 2147483647n];
    case 'uint32':
    case 'fixed32':
      return [0n, 4294967295n];
    case 'int64':
    case 'sint64':
    case 'sfixed64':
      return [-9223372036854775808n, 9223372036854775807n];
    case 'uint64':
    case 'fixed64':
      return [0n, 18446744073709551615n];
    default:
      throw new MessageError(`not an integer type: ${type}`);
  }
}

function coerceInteger(field: FieldDescriptor, input: unknown): bigint {
  let value: bigint;
  if (typeof input === 'bigint') value = input;
  else if (typeof input === 'number') {
    if (!Number.isInteger(input)) {
      throw new MessageError(`field ${field.name}: integer expected, got ${String(input)}`);
    }
    value = BigInt(input);
  } else if (typeof input === 'string' && /^-?\d+$/.test(input)) {
    value = BigInt(input);
  } else {
    throw new MessageError(
      `field ${field.name}: integer expected, got ${describeValue(input)}`,
    );
  }
  const [lo, hi] = intRanges(field.type);
  if (value < lo || value > hi) {
    throw new MessageError(`field ${field.name}: value ${value} out of ${field.type} range`);
  }
  return value;
}

function coerceFloat(field: FieldDescriptor, input: unknown): number {
  if (typeof input === 'number') return input;
  if (typeof input === 'string') {
    if (input === 'NaN') return NaN;
    if (input === 'Infinity') return Infinity;
    if (input === '-Infinity') return -Infinity;
    if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$|^-?\.\d+(?:[eE][+-]?\d+)?$/.test(input)) {
      return Number(input);
    }
  }
  throw new MessageError(`field ${field.name}: float expected, got ${describeValue(input)}`);
}

function coerceBool(field: FieldDescriptor, input: unknown): boolean {
  if (typeof input === 'boolean') return input;
  throw new MessageError(`field ${field.name}: bool expected, got ${describeValue(input)}`);
}

function coerceString(field: FieldDescriptor, input: unknown): string {
  if (typeof input === 'string') return input;
  throw new MessageError(`field ${field.name}: string expected, got ${describeValue(input)}`);
}

function coerceBytes(field: FieldDescriptor, input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return Uint8Array.from(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  if (ArrayBuffer.isView(input)) {
    return Uint8Array.from(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  }
  if (typeof input === 'string') {
    // Programmatic access accepts canonical base64 strings as a convenience.
    return base64Decode(input);
  }
  throw new MessageError(`field ${field.name}: bytes expected, got ${describeValue(input)}`);
}

function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Uint8Array) return 'bytes';
  return typeof v;
}

/** Default scalar/enum value per field type. */
export function defaultValue(field: FieldDescriptor): JsScalar {
  switch (field.type) {
    case 'double':
    case 'float':
      return 0;
    case 'int64':
    case 'uint64':
    case 'fixed64':
    case 'sfixed64':
    case 'sint64':
      return 0n;
    case 'int32':
    case 'uint32':
    case 'fixed32':
    case 'sfixed32':
    case 'sint32':
    case 'enum':
      return 0;
    case 'bool':
      return false;
    case 'string':
      return '';
    case 'bytes':
      return new Uint8Array(0);
    default:
      throw new MessageError(`no scalar default for type ${field.type}`);
  }
}

export function isScalarDefault(field: FieldDescriptor, value: JsScalar): boolean {
  switch (field.type) {
    case 'double':
    case 'float':
      // -0 is distinct from the default +0 and must be serialized.
      return value === 0 && !Object.is(value, -0);
    case 'int64':
    case 'uint64':
    case 'fixed64':
    case 'sfixed64':
    case 'sint64':
      return typeof value === 'bigint' && value === 0n;
    case 'int32':
    case 'uint32':
    case 'fixed32':
    case 'sfixed32':
    case 'sint32':
    case 'enum':
      return value === 0;
    case 'bool':
      return value === false;
    case 'string':
      return value === '';
    case 'bytes':
      return value instanceof Uint8Array && value.length === 0;
    default:
      return false;
  }
}

interface Present {
  present: true;
  value: JsScalar | DynamicMessage;
}

/**
 * A protobuf message instance.
 *
 * Repeated values are arrays; map fields are arrays of synthetic map-entry
 * DynamicMessages (converted to/from JS Maps at the API boundary).
 */
export class DynamicMessage {
  /** Decoded `Any` payload, attached separately so the `type_url`/`value`
   * fields retain normal field semantics. */
  anyPayload: DynamicMessage | undefined;

  private readonly singular = new Map<number, Present>();

  constructor(
    readonly descriptor: MessageDescriptor,
    readonly pool: DescriptorPool,
  ) {}

  static create(descriptor: MessageDescriptor, pool: DescriptorPool): DynamicMessage {
    return new DynamicMessage(descriptor, pool);
  }

  // ---- singular fields -----------------------------------------------------

  setField(field: FieldDescriptor, value: unknown): void {
    this.assertField(field);
    if (field.isMap) {
      this.setMap(field, value as ReadonlyMap<JsScalar, unknown> | Record<string, unknown>);
      return;
    }
    if (field.isRepeated) {
      if (!Array.isArray(value)) {
        throw new MessageError(`field ${field.name}: array expected`);
      }
      const coerced = value.map((v) => this.coerceSingular(field, v));
      // Setting a oneof field clears its siblings (repeated cannot be in a
      // oneof, but keep the guard for symmetry).
      this.clearOneofSiblings(field);
      this.singular.set(field.number, { present: true, value: coerced as unknown as JsScalar });
      return;
    }
    if (value === undefined || value === null) {
      // null clears singular fields; message fields accept null as "unset".
      this.clearField(field);
      return;
    }
    const coerced = this.coerceSingular(field, value);
    this.clearOneofSiblings(field);
    this.singular.set(field.number, { present: true, value: coerced });
  }

  /** Coerce a JSON/plain-JS value to the field's stored value type. */
  coerceSingular(field: FieldDescriptor, input: unknown): JsScalar | DynamicMessage {
    switch (field.type) {
      case 'double':
      case 'float':
        return coerceFloat(field, input);
      case 'int32':
      case 'uint32':
      case 'fixed32':
      case 'sfixed32':
      case 'sint32':
      case 'int64':
      case 'uint64':
      case 'fixed64':
      case 'sfixed64':
      case 'sint64': {
        const bi = coerceInteger(field, input);
        return is32Bit(field.type) ? Number(bi) : bi;
      }
      case 'bool':
        return coerceBool(field, input);
      case 'string':
        return coerceString(field, input);
      case 'bytes':
        return coerceBytes(field, input);
      case 'enum': {
        if (typeof input === 'number' && Number.isInteger(input)) return input;
        if (typeof input === 'string') {
          const n = field.enumType!.numberFor(input);
          if (n === undefined) {
            throw new MessageError(`field ${field.name}: unknown enum value ${JSON.stringify(input)}`);
          }
          return n;
        }
        throw new MessageError(`field ${field.name}: enum expected, got ${describeValue(input)}`);
      }
      case 'message':
      case 'group': {
        if (input instanceof DynamicMessage) {
          if (field.messageType && input.descriptor !== field.messageType) {
            throw new MessageError(
              `field ${field.name}: message type ${input.descriptor.fullName} ` +
                `does not match ${field.messageType.fullName}`,
            );
          }
          return input;
        }
        throw new MessageError(`field ${field.name}: message expected`);
      }
      default:
        throw new MessageError(`field ${field.name}: unsupported type ${field.type}`);
    }
  }

  getField(field: FieldDescriptor): JsValue | undefined {
    this.assertField(field);
    const entry = this.singular.get(field.number);
    if (!entry) {
      if (field.isMap || field.isRepeated) return [];
      if (field.type === 'message') return undefined;
      return undefined;
    }
    return entry.value as JsValue;
  }

  /** Returns the default (not undefined) even when the field is unset. */
  getFieldOrDefault(field: FieldDescriptor): JsScalar | DynamicMessage {
    const v = this.getField(field);
    if (v !== undefined) return v as JsScalar | DynamicMessage;
    if (field.type === 'message') {
      // Mutable access: materialize the sub-message on access.
      const msg = new DynamicMessage(field.messageType!, this.pool);
      this.singular.set(field.number, { present: true, value: msg });
      return msg;
    }
    return defaultValue(field);
  }

  has(field: FieldDescriptor): boolean {
    this.assertField(field);
    if (field.isMap || field.isRepeated) {
      const entry = this.singular.get(field.number);
      return Array.isArray(entry?.value) && (entry.value as unknown[]).length > 0;
    }
    const entry = this.singular.get(field.number);
    if (!entry) return false;
    if (field.hasPresence) return true;
    // Plain proto3 scalar: presence follows non-default-ness.
    return !isScalarDefault(field, entry.value as JsScalar);
  }

  /**
   * Whether the field was explicitly set, including a plain proto3 scalar
   * set to its default. Needed for presence-preserving round-trips.
   */
  isExplicitlySet(field: FieldDescriptor): boolean {
    this.assertField(field);
    return this.singular.has(field.number);
  }

  clearField(field: FieldDescriptor): void {
    this.assertField(field);
    this.singular.delete(field.number);
    if (field.type === 'message' && field.messageType?.fullName === '.google.protobuf.Any') {
      this.anyPayload = undefined;
    }
  }

  private clearOneofSiblings(field: FieldDescriptor): void {
    if (!field.containingOneof) return;
    for (const f of this.descriptor.fields) {
      if (f.containingOneof === field.containingOneof && f.number !== field.number) {
        this.singular.delete(f.number);
      }
    }
  }

  /** Which field of a oneof is set, or undefined. */
  whichOneof(name: string): FieldDescriptor | undefined {
    const oneof = this.descriptor.oneofs.find((o) => o.name === name);
    if (!oneof) throw new MessageError(`no such oneof: ${name}`);
    for (const f of this.descriptor.fields) {
      if (f.containingOneof === oneof && this.singular.has(f.number)) return f;
    }
    return undefined;
  }

  // ---- repeated helpers ----------------------------------------------------

  addRepeated(field: FieldDescriptor, value: unknown): JsScalar | DynamicMessage {
    this.assertField(field);
    if (field.isMap) throw new MessageError(`field ${field.name} is a map`);
    if (!field.isRepeated) throw new MessageError(`field ${field.name} is not repeated`);
    const coerced = this.coerceSingular(field, value);
    const entry = this.singular.get(field.number);
    const arr: JsValue[] = entry ? (entry.value as unknown as JsValue[]) : [];
    arr.push(coerced);
    this.singular.set(field.number, { present: true, value: arr as unknown as JsScalar });
    return coerced;
  }

  // ---- map fields ----------------------------------------------------------

  getMap(field: FieldDescriptor): Map<JsScalar, JsScalar | DynamicMessage> {
    this.assertField(field);
    if (!field.isMap) throw new MessageError(`field ${field.name} is not a map`);
    const entry = field.messageType!.mapEntry!;
    const out = new Map<JsScalar, JsScalar | DynamicMessage>();
    const arr = (this.singular.get(field.number)?.value as DynamicMessage[] | undefined) ?? [];
    for (const item of arr) {
      const k = item.singular.get(1)!.value as JsScalar;
      const vItem = item.singular.get(2);
      const v =
        vItem !== undefined
          ? (vItem.value as JsScalar | DynamicMessage)
          : entry.value.type === 'message'
            ? (undefined as unknown as DynamicMessage)
            : defaultValue(entry.value);
      out.set(k, v);
    }
    return out;
  }

  setMapEntry(
    field: FieldDescriptor,
    key: JsScalar,
    value: unknown,
  ): void {
    const entryType = field.messageType!;
    const { key: keyField, value: valueField } = entryType.mapEntry!;
    const coercedKey = this.coerceSingular(keyField, key) as JsScalar;
    const arr = (this.singular.get(field.number)?.value as DynamicMessage[] | undefined) ?? [];
    let target = arr.find((item) =>
      valuesEqual(item.singular.get(1)!.value, coercedKey),
    );
    if (!target) {
      target = new DynamicMessage(entryType, this.pool);
      target.singular.set(1, { present: true, value: coercedKey });
      arr.push(target);
      this.singular.set(field.number, { present: true, value: arr as unknown as JsScalar });
    }
    if (value === null || value === undefined) {
      if (valueField.type === 'message') target.singular.delete(2);
      else target.singular.set(2, { present: true, value: defaultValue(valueField) });
    } else {
      target.singular.set(2, { present: true, value: this.coerceSingular(valueField, value) });
    }
  }

  private setMap(field: FieldDescriptor, value: ReadonlyMap<JsScalar, unknown> | Record<string, unknown>): void {
    this.singular.delete(field.number);
    const entries: [JsScalar, unknown][] =
      value instanceof Map
        ? [...value.entries()]
        : Object.entries(value).map(([k, v]) => [k, v] as [string, unknown]);
    for (const [k, v] of entries) this.setMapEntry(field, k, v);
  }

  /** Iterate set map-entry messages (used by serialization). */
  mapEntries(field: FieldDescriptor): DynamicMessage[] {
    if (!field.isMap) throw new MessageError(`field ${field.name} is not a map`);
    return ((this.singular.get(field.number)?.value as DynamicMessage[] | undefined) ?? []).slice();
  }

  repeatedValues(field: FieldDescriptor): JsValue[] {
    if (!field.isRepeated || field.isMap) {
      throw new MessageError(`field ${field.name} is not a plain repeated field`);
    }
    return ((this.singular.get(field.number)?.value as JsValue[] | undefined) ?? []).slice();
  }

  singularEntry(field: FieldDescriptor): { value: JsScalar | DynamicMessage } | undefined {
    const e = this.singular.get(field.number);
    return e ? { value: e.value } : undefined;
  }

  /** Fields that must be emitted / are observable as present. */
  presentFields(): FieldDescriptor[] {
    return this.descriptor.fields.filter((f) => this.has(f));
  }

  /** All fields with an explicit store entry (preserves proto3 default sets). */
  explicitlySetFields(): FieldDescriptor[] {
    return this.descriptor.fields.filter((f) => this.singular.has(f.number));
  }

  // ---- Any -----------------------------------------------------------------

  /** Attach a decoded Any payload (type_url is set canonically). */
  setAny(payload: DynamicMessage, typeUrl?: string): void {
    const anyField = this.descriptor.fields.find((f) => f.name === 'type_url');
    if (this.descriptor.fullName !== '.google.protobuf.Any' || !anyField) {
      throw new MessageError('setAny called on a non-Any message');
    }
    const url = typeUrl ?? canonicalTypeUrl(payload.descriptor.fullName);
    this.setField(anyField, url);
    this.anyPayload = payload;
  }

  // ---- misc ----------------------------------------------------------------

  clone(): DynamicMessage {
    const copy = new DynamicMessage(this.descriptor, this.pool);
    for (const [num, entry] of this.singular) {
      copy.singular.set(num, { present: true, value: deepCopy(entry.value) as JsScalar | DynamicMessage });
    }
    copy.anyPayload = this.anyPayload?.clone();
    return copy;
  }

  equals(other: DynamicMessage): boolean {
    if (this.descriptor !== other.descriptor) return false;
    if (this.singular.size !== other.singular.size) return false;
    for (const [num, a] of this.singular) {
      const b = other.singular.get(num);
      if (!b || !valuesEqual(a.value, b.value)) return false;
    }
    if (this.anyPayload || other.anyPayload) {
      if (!this.anyPayload || !other.anyPayload) return false;
      if (!this.anyPayload.equals(other.anyPayload)) return false;
    }
    return true;
  }

  private assertField(field: FieldDescriptor): void {
    if (!this.descriptor.fields.includes(field)) {
      throw new MessageError(`field ${field.name} does not belong to ${this.descriptor.fullName}`);
    }
  }
}

export function is32Bit(type: string): boolean {
  return (
    type === 'int32' ||
    type === 'uint32' ||
    type === 'fixed32' ||
    type === 'sfixed32' ||
    type === 'sint32'
  );
}

export function is64Bit(type: string): boolean {
  return (
    type === 'int64' ||
    type === 'uint64' ||
    type === 'fixed64' ||
    type === 'sfixed64' ||
    type === 'sint64'
  );
}

export function isSigned64(type: string): boolean {
  return type === 'int64' || type === 'sfixed64' || type === 'sint64';
}

export function canonicalTypeUrl(fullName: string): string {
  const name = fullName.startsWith('.') ? fullName.slice(1) : fullName;
  return `type.googleapis.com/${name}`;
}
