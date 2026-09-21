// Canonical protobuf JSON mapping.
//
// Serialization always emits the canonical form:
//   - 64-bit integers as decimal strings, bytes as padded standard base64;
//   - enums as names (numeric for unknown numbers);
//   - Timestamp/Duration/FieldMask strings and Any as "@type" envelopes;
//   - map keys sorted; lowerCamelCase names; proto3 implicit defaults omitted.
//
// Parsing accepts every alternative the spec allows:
//   - snake_case and lowerCamelCase names;
//   - 64-bit ints as numbers (when safe) or strings;
//   - base64 with/without padding and URL-safe alphabet;
//   - enum names or numbers;
//   - negative zero and NaN/Infinity strings.
//
// Unknown JSON keys are rejected by default (strict) or skipped in
// ignore mode. Duplicate keys, colliding aliases and oneof conflicts are
// always errors.

import {
  DescriptorPool,
  FieldDescriptor,
  MessageDescriptor,
  ANY_TYPE,
  DURATION_TYPE,
  EMPTY_TYPE,
  FIELD_MASK_TYPE,
  TIMESTAMP_TYPE,
} from './descriptors.js';
import {
  DynamicMessage,
  JsScalar,
  JsValue,
  canonicalTypeUrl,
  is32Bit,
  is64Bit,
  isScalarDefault,
} from './dynamic.js';
import { base64Encode, camelToSnake } from './names.js';
import {
  formatDuration,
  formatTimestamp,
  parseDuration,
  parseTimestamp,
  TimeParseError,
} from './time.js';

export class JsonFormatError extends Error {}

export interface JsonPrintOptions {
  /** Emit plain proto3 scalar fields even when they hold the default value. */
  emitImplicitDefaults?: boolean;
  /** Indentation string (e.g. '  '); omit for compact output. */
  indent?: string;
}

export interface JsonParseOptions {
  /** Skip unknown fields instead of throwing (default: throw). */
  ignoreUnknownFields?: boolean;
}

interface PrintContext {
  indent: string;
  emitDefaults: boolean;
}

// ---- JSON text writer ------------------------------------------------------
// A tiny IR lets us emit `-0.0` (not representable through JSON.stringify).

type JsonIr =
  | { kind: 'object'; entries: [string, JsonIr][] }
  | { kind: 'array'; items: JsonIr[] }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'number'; value: number } // finite
  | { kind: 'raw'; text: string }; // NaN / Infinity / -0.0

const NEG_ZERO: JsonIr = { kind: 'raw', text: '-0.0' };

function writeIr(ir: JsonIr, indent: string | undefined, depth = 0): string {
  switch (ir.kind) {
    case 'object': {
      if (ir.entries.length === 0) return '{}';
      if (!indent) {
        return '{' + ir.entries.map(([k, v]) => JSON.stringify(k) + ':' + writeIr(v, indent)).join(',') + '}';
      }
      const inner = indent.repeat(depth + 1);
      const outer = indent.repeat(depth);
      return (
        '{\n' +
        ir.entries
          .map(([k, v]) => inner + JSON.stringify(k) + ': ' + writeIr(v, indent, depth + 1))
          .join(',\n') +
        '\n' + outer + '}'
      );
    }
    case 'array': {
      if (ir.items.length === 0) return '[]';
      if (!indent) {
        return '[' + ir.items.map((v) => writeIr(v, indent)).join(',') + ']';
      }
      const inner = indent.repeat(depth + 1);
      const outer = indent.repeat(depth);
      return (
        '[\n' +
        ir.items.map((v) => inner + writeIr(v, indent, depth + 1)).join(',\n') +
        '\n' + outer + ']'
      );
    }
    case 'string':
      return JSON.stringify(ir.value);
    case 'boolean':
      return ir.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'number':
      return formatFiniteNumber(ir.value);
    case 'raw':
      return ir.text;
  }
}

/** Canonical finite number text: shortest round-trippable, integral floats keep ".0"?
 * No — proto JSON emits plain JSON numbers; "1" is the canonical form of 1.0. */
function formatFiniteNumber(n: number): string {
  if (Number.isSafeInteger(n)) return String(n);
  return JSON.stringify(n);
}

// ---- Printing --------------------------------------------------------------

export class JsonPrinter {
  constructor(private readonly options: JsonPrintOptions = {}) {}

  print(message: DynamicMessage): string {
    const ir = this.messageToIr(message);
    return writeIr(ir, this.options.indent);
  }

  messageToIr(message: DynamicMessage): JsonIr {
    const desc = message.descriptor;
    switch (desc.fullName) {
      case TIMESTAMP_TYPE:
        return { kind: 'string', value: this.printTimestamp(message) };
      case DURATION_TYPE:
        return { kind: 'string', value: this.printDuration(message) };
      case FIELD_MASK_TYPE:
        return { kind: 'string', value: this.printFieldMask(message) };
      case EMPTY_TYPE:
        return { kind: 'object', entries: [] };
      case ANY_TYPE:
        return this.printAny(message);
      default:
        return this.printGeneric(message);
    }
  }

  private printTimestamp(message: DynamicMessage): string {
    const seconds = this.getInt64(message, 'seconds');
    const nanos = this.getInt32(message, 'nanos');
    return formatTimestamp({ seconds, nanos });
  }

  private printDuration(message: DynamicMessage): string {
    const seconds = this.getInt64(message, 'seconds');
    const nanos = this.getInt32(message, 'nanos');
    return formatDuration({ seconds, nanos });
  }

  private printFieldMask(message: DynamicMessage): string {
    const field = message.descriptor.fields.find((f) => f.name === 'paths')!;
    // Canonical: original order (set order is observable on the wire),
    // each path rendered in snake_case.
    return message
      .repeatedValues(field)
      .map((p) => camelToSnake(p as string))
      .join(',');
  }

  private printAny(message: DynamicMessage): JsonIr {
    const typeUrlField = message.descriptor.fields.find((f) => f.name === 'type_url')!;
    const urlEntry = message.singularEntry(typeUrlField);
    if (!message.anyPayload || !urlEntry) {
      throw new JsonFormatError(
        'cannot serialize google.protobuf.Any without a decoded payload and type_url',
      );
    }
    const payload = message.anyPayload;
    const typeUrl = urlEntry.value as string;
    const fullName = payload.descriptor.fullName;
    const wrapped = this.messageToIr(payload);

    if (fullName === EMPTY_TYPE) {
      return {
        kind: 'object',
        entries: [['@type', { kind: 'string', value: typeUrl }]],
      };
    }
    if (isJsonWrappedType(fullName)) {
      // Specialized JSON types (Timestamp, Duration, FieldMask, Value,
      // Struct, wrappers, and Any itself) are placed under "value".
      return {
        kind: 'object',
        entries: [
          ['@type', { kind: 'string', value: typeUrl }],
          ['value', wrapped],
        ],
      };
    }
    if (wrapped.kind !== 'object') {
      throw new JsonFormatError(`Any payload of type ${fullName} did not render as an object`);
    }
    // @type first, then payload fields in descriptor order.
    return {
      kind: 'object',
      entries: [['@type', { kind: 'string', value: typeUrl }], ...wrapped.entries],
    };
  }

  private printGeneric(message: DynamicMessage): JsonIr {
    const ctx: PrintContext = {
      indent: this.options.indent ?? '',
      emitDefaults: !!this.options.emitImplicitDefaults,
    };
    const entries: [string, JsonIr][] = [];
    for (const field of message.descriptor.fields) {
      const ir = this.fieldToIr(message, field, ctx);
      if (ir !== undefined) entries.push([field.jsonName, ir]);
    }
    return { kind: 'object', entries };
  }

  private fieldToIr(
    message: DynamicMessage,
    field: FieldDescriptor,
    ctx: PrintContext,
  ): JsonIr | undefined {
    if (field.isMap) {
      const entries = message.mapEntries(field);
      if (entries.length === 0) return undefined;
      const valueField = field.messageType!.mapEntry!.value;
      const pairs = entries.map((entry) => {
        const k = entry.singularEntry(entry.descriptor.mapEntry!.key)!.value as JsScalar;
        const vEntry = entry.singularEntry(valueField);
        const v =
          vEntry !== undefined
            ? vEntry.value
            : valueField.type === 'message'
              ? undefined
              : defaultScalarFor(valueField);
        return [this.mapKeyToJson(field, k), this.valueToIr(valueField, v, ctx)] as [string, JsonIr];
      });
      pairs.sort((a, b) => compareMapKeys(a[0], b[0], field.messageType!.mapEntry!.key.type));
      return { kind: 'object', entries: pairs };
    }

    if (field.isRepeated) {
      const values = message.repeatedValues(field);
      if (values.length === 0) return undefined;
      return {
        kind: 'array',
        items: values.map((v) =>
          this.valueToIr(field, v as JsScalar | DynamicMessage, ctx),
        ),
      };
    }

    const entry = message.singularEntry(field);
    if (entry === undefined) {
      if (ctx.emitDefaults && !field.hasPresence) {
        return this.valueToIr(field, defaultScalarFor(field), ctx);
      }
      return undefined;
    }

    if (field.type === 'message') {
      if (entry.value === undefined) return undefined;
      return this.messageToIr(entry.value as DynamicMessage);
    }

    // Plain proto3 scalar: defaults are omitted unless requested.
    if (!field.hasPresence && isScalarDefault(field, entry.value as JsScalar) && !ctx.emitDefaults) {
      return undefined;
    }
    return this.valueToIr(field, entry.value, ctx);
  }

  private valueToIr(
    field: FieldDescriptor,
    value: JsScalar | DynamicMessage | undefined,
    ctx: PrintContext,
  ): JsonIr {
    void ctx;
    switch (field.type) {
      case 'double':
      case 'float':
        return this.floatToIr(value as number, field.type === 'float');
      case 'int64':
      case 'uint64':
      case 'fixed64':
      case 'sfixed64':
      case 'sint64':
        return { kind: 'string', value: (value as bigint).toString() };
      case 'int32':
      case 'uint32':
      case 'fixed32':
      case 'sfixed32':
      case 'sint32':
        return { kind: 'number', value: value as number };
      case 'bool':
        return { kind: 'boolean', value: value as boolean };
      case 'string':
        return { kind: 'string', value: value as string };
      case 'bytes':
        return { kind: 'string', value: base64Encode(value as Uint8Array) };
      case 'enum': {
        const num = value as number;
        const name = field.enumType!.nameFor(num);
        return name !== undefined
          ? { kind: 'string', value: name }
          : { kind: 'number', value: num };
      }
      case 'message':
      case 'group':
        return value === undefined
          ? { kind: 'null' }
          : this.messageToIr(value as DynamicMessage);
      default:
        throw new JsonFormatError(`unsupported field type ${field.type}`);
    }
  }

  private floatToIr(value: number, isFloat: boolean): JsonIr {
    void isFloat;
    if (Number.isNaN(value)) return { kind: 'raw', text: '"NaN"' };
    if (value === Infinity) return { kind: 'raw', text: '"Infinity"' };
    if (value === -Infinity) return { kind: 'raw', text: '"-Infinity"' };
    if (Object.is(value, -0)) return NEG_ZERO;
    return { kind: 'number', value };
  }

  private mapKeyToJson(field: FieldDescriptor, key: JsScalar): string {
    const keyType = field.messageType!.mapEntry!.key.type;
    if (keyType === 'string') return key as string;
    if (keyType === 'bool') return key ? 'true' : 'false';
    if (is64Bit(keyType)) return (key as bigint).toString();
    return String(key);
  }

  private getInt64(message: DynamicMessage, name: string): bigint {
    const field = message.descriptor.fields.find((f) => f.name === name)!;
    const entry = message.singularEntry(field);
    return entry === undefined ? 0n : (entry.value as bigint);
  }

  private getInt32(message: DynamicMessage, name: string): number {
    const field = message.descriptor.fields.find((f) => f.name === name)!;
    const entry = message.singularEntry(field);
    return entry === undefined ? 0 : (entry.value as number);
  }
}

function defaultScalarFor(field: FieldDescriptor): JsScalar {
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
      throw new JsonFormatError(`no default for ${field.type}`);
  }
}

function isJsonWrappedType(fullName: string): boolean {
  return (
    fullName === TIMESTAMP_TYPE ||
    fullName === DURATION_TYPE ||
    fullName === FIELD_MASK_TYPE ||
    fullName === '.google.protobuf.Value' ||
    fullName === '.google.protobuf.Struct' ||
    fullName === '.google.protobuf.ListValue' ||
    fullName === ANY_TYPE ||
    fullName.startsWith('.google.protobuf.') && fullName.endsWith('Value')
  );
}

function compareMapKeys(a: string, b: string, keyType: string): number {
  // Integer-typed keys sort numerically; bool and string keys sort
  // lexicographically (canonical proto JSON order).
  if (keyType !== 'string' && keyType !== 'bool' && /^-?\d+$/.test(a) && /^-?\d+$/.test(b)) {
    const an = BigInt(a);
    const bn = BigInt(b);
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- Parsing ---------------------------------------------------------------

export class JsonParser {
  constructor(
    private readonly pool: DescriptorPool,
    private readonly options: JsonParseOptions = {},
  ) {}

  parse(text: string, descriptor: MessageDescriptor): DynamicMessage {
    const root = parseJsonStrict(text);
    // Timestamp / Duration / FieldMask are encoded as a bare JSON string.
    if (
      (descriptor.fullName === TIMESTAMP_TYPE ||
        descriptor.fullName === DURATION_TYPE ||
        descriptor.fullName === FIELD_MASK_TYPE) &&
      typeof root === 'string'
    ) {
      return this.convertMessage({ '': root }, descriptor, '$');
    }
    return this.fromJson(root, descriptor, '$');
  }

  /** Parse an already-decoded JSON value (used for nested recursion/tests). */
  fromJson(json: unknown, descriptor: MessageDescriptor, path = '$'): DynamicMessage {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw new JsonFormatError(`${path}: message must be a JSON object`);
    }
    return this.convertMessage(json as Record<string, unknown>, descriptor, path);
  }

  private convertMessage(
    json: Record<string, unknown>,
    descriptor: MessageDescriptor,
    path: string,
  ): DynamicMessage {
    switch (descriptor.fullName) {
      case TIMESTAMP_TYPE: {
        const msg = new DynamicMessage(descriptor, this.pool);
        const parsed = this.wrapTimeError(() => parseTimestamp(asString(json, descriptor, path)), path);
        msg.setField(descriptor.fields[0], parsed.seconds);
        msg.setField(descriptor.fields[1], parsed.nanos);
        return msg;
      }
      case DURATION_TYPE: {
        const msg = new DynamicMessage(descriptor, this.pool);
        const parsed = this.wrapTimeError(() => parseDuration(asString(json, descriptor, path)), path);
        msg.setField(descriptor.fields[0], parsed.seconds);
        msg.setField(descriptor.fields[1], parsed.nanos);
        return msg;
      }
      case FIELD_MASK_TYPE: {
        const msg = new DynamicMessage(descriptor, this.pool);
        const text = asString(json, descriptor, path);
        if (text !== '') {
          const pathsField = descriptor.fields[0];
          for (const pathSegment of text.split(',')) {
            if (!isValidMaskPath(pathSegment)) {
              throw new JsonFormatError(`${path}: invalid FieldMask path ${JSON.stringify(pathSegment)}`);
            }
            msg.addRepeated(pathsField, camelToSnake(pathSegment));
          }
        }
        return msg;
      }
      case EMPTY_TYPE: {
        this.rejectExtras(json, [], descriptor, path);
        return new DynamicMessage(descriptor, this.pool);
      }
      case ANY_TYPE:
        return this.convertAny(json, path);
      default:
        return this.mergeGeneric(json, descriptor, path);
    }
  }

  private wrapTimeError<T>(fn: () => T, path: string): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof TimeParseError) throw new JsonFormatError(`${path}: ${e.message}`);
      throw e;
    }
  }

  private convertAny(json: Record<string, unknown>, path: string): DynamicMessage {
    const typeUrl = json['@type'];
    if (typeof typeUrl !== 'string') {
      throw new JsonFormatError(`${path}: google.protobuf.Any requires a string "@type"`);
    }
    const descriptor = this.pool.resolveTypeUrl(typeUrl);
    if (!descriptor) {
      throw new JsonFormatError(`${path}: cannot resolve Any type URL ${JSON.stringify(typeUrl)}`);
    }
    const anyDescriptor = this.pool.lookupMessage(ANY_TYPE);
    const any = new DynamicMessage(anyDescriptor, this.pool);
    const canonical = canonicalTypeUrl(descriptor.fullName);
    // Both Google-owned hosts are equivalent and canonicalize to type.googleapis.com.
    const storedUrl = /^type\.google(?:apis|prod)?\.com\//.test(typeUrl)
      ? canonical
      : typeUrl;
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(json)) if (k !== '@type') rest[k] = v;

    let payload: DynamicMessage;
    if (descriptor.fullName === EMPTY_TYPE) {
      this.rejectExtras(rest, [], descriptor, path);
      payload = new DynamicMessage(descriptor, this.pool);
    } else if (isJsonWrappedType(descriptor.fullName)) {
      if (!('value' in rest)) {
        throw new JsonFormatError(`${path}: Any of ${descriptor.fullName} requires "value"`);
      }
      payload = this.convertWrapped(rest.value, descriptor, path + '.value');
      const extraKeys = Object.keys(rest).filter((k) => k !== 'value');
      if (extraKeys.length > 0) {
        throw new JsonFormatError(
          `${path}: unexpected fields for wrapped Any: ${extraKeys.map((k) => JSON.stringify(k)).join(', ')}`,
        );
      }
    } else {
      payload = this.mergeGeneric(rest, descriptor, path, '@type');
    }

    any.setField(anyDescriptor.fields[0], storedUrl);
    any.setAny(payload, storedUrl);
    return any;
  }

  private convertWrapped(
    json: unknown,
    descriptor: MessageDescriptor,
    path: string,
  ): DynamicMessage {
    // Timestamp/Duration/FieldMask are JSON strings; Value/Struct and
    // wrappers are JSON values handled by the generic merger's fields.
    if (
      descriptor.fullName === TIMESTAMP_TYPE ||
      descriptor.fullName === DURATION_TYPE ||
      descriptor.fullName === FIELD_MASK_TYPE
    ) {
      if (typeof json !== 'string') {
        throw new JsonFormatError(`${path}: ${descriptor.fullName} must be a JSON string`);
      }
      const holder: Record<string, unknown> = { '': json };
      return this.convertMessage(holder, descriptor, path);
    }
    if (descriptor.fullName === ANY_TYPE) {
      // Recursive Any: the "value" is itself an Any envelope.
      if (json === null || typeof json !== 'object' || Array.isArray(json)) {
        throw new JsonFormatError(`${path}: google.protobuf.Any must be a JSON object`);
      }
      return this.convertAny(json as Record<string, unknown>, path);
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw new JsonFormatError(`${path}: ${descriptor.fullName} must be a JSON object`);
    }
    return this.mergeGeneric(json as Record<string, unknown>, descriptor, path);
  }

  /**
   * Merge a plain JSON object into a fresh message.
   * `reservedKeys` (e.g. "@type" inside an Any payload) are accepted without
   * mapping to a field.
   */
  private mergeGeneric(
    json: Record<string, unknown>,
    descriptor: MessageDescriptor,
    path: string,
    ...reservedKeys: string[]
  ): DynamicMessage {
    const message = new DynamicMessage(descriptor, this.pool);
    const seenFields = new Map<number, string>(); // field number -> first json key
    const seenOneofs = new Map<string, string>(); // oneof name -> first json key

    for (const [key, raw] of Object.entries(json)) {
      if (reservedKeys.includes(key)) continue;
      const field = descriptor.fieldByName(key);
      if (!field) {
        if (this.options.ignoreUnknownFields) continue;
        throw new JsonFormatError(
          `${path}: unknown field ${JSON.stringify(key)} for ${descriptor.fullName}`,
        );
      }
      const fieldPath = `${path}.${field.jsonName}`;

      // Same field reached twice (e.g. both "foo_bar" and "fooBar") is an
      // error even though raw duplicate keys were already rejected.
      const firstKey = seenFields.get(field.number);
      if (firstKey !== undefined) {
        throw new JsonFormatError(
          `${path}: fields ${JSON.stringify(firstKey)} and ${JSON.stringify(key)} ` +
            `both map to ${field.jsonName}`,
        );
      }
      seenFields.set(field.number, key);

      if (field.containingOneof) {
        const owner = seenOneofs.get(field.containingOneof.name);
        if (owner !== undefined && owner !== key) {
          throw new JsonFormatError(
            `${path}: oneof "${field.containingOneof.name}" has conflicting fields ` +
              `${JSON.stringify(owner)} and ${JSON.stringify(key)}`,
          );
        }
        seenOneofs.set(field.containingOneof.name, key);
      }

      this.assignField(message, field, raw, fieldPath);
    }
    return message;
  }

  private rejectExtras(
    json: Record<string, unknown>,
    allowed: string[],
    descriptor: MessageDescriptor,
    path: string,
  ): void {
    for (const key of Object.keys(json)) {
      if (allowed.includes(key)) continue;
      if (this.options.ignoreUnknownFields) continue;
      throw new JsonFormatError(
        `${path}: unknown field ${JSON.stringify(key)} for ${descriptor.fullName}`,
      );
    }
  }

  private assignField(
    message: DynamicMessage,
    field: FieldDescriptor,
    raw: unknown,
    path: string,
  ): void {
    if (raw === null) {
      // null clears scalar/oneof fields and means unset for messages.
      if (field.isRepeated || field.isMap) {
        throw new JsonFormatError(`${path}: repeated/map fields cannot be null`);
      }
      message.clearField(field);
      return;
    }

    if (field.isMap) {
      this.assignMap(message, field, raw, path);
      return;
    }
    if (field.isRepeated) {
      if (!Array.isArray(raw)) {
        throw new JsonFormatError(`${path}: expected array for repeated field`);
      }
      for (let i = 0; i < raw.length; i++) {
        this.assignRepeatedElement(message, field, raw[i], `${path}[${i}]`);
      }
      return;
    }
    if (field.type === 'message') {
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new JsonFormatError(`${path}: expected object for message field`);
      }
      const sub = this.convertMessage(raw as Record<string, unknown>, field.messageType!, path);
      message.setField(field, sub);
      return;
    }
    const value = this.convertScalar(field, raw, path);
    message.setField(field, value);
  }

  private assignRepeatedElement(
    message: DynamicMessage,
    field: FieldDescriptor,
    raw: unknown,
    path: string,
  ): void {
    if (raw === null) {
      if (field.type !== 'message') {
        throw new JsonFormatError(`${path}: null is not a valid repeated element`);
      }
      message.addRepeated(field, new DynamicMessage(field.messageType!, this.pool));
      return;
    }
    if (field.type === 'message') {
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new JsonFormatError(`${path}: expected message object`);
      }
      message.addRepeated(
        field,
        this.convertMessage(raw as Record<string, unknown>, field.messageType!, path),
      );
      return;
    }
    message.addRepeated(field, this.convertScalar(field, raw, path));
  }

  private assignMap(
    message: DynamicMessage,
    field: FieldDescriptor,
    raw: unknown,
    path: string,
  ): void {
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new JsonFormatError(`${path}: expected object for map field`);
    }
    const entryType = field.messageType!;
    const keyField = entryType.mapEntry!.key;
    const valueField = entryType.mapEntry!.value;
    const normalizedKeys = new Set<string>();
    for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
      const key = this.convertMapKey(keyField, rawKey, path);
      const keyText = key instanceof Uint8Array ? '' : String(key);
      // Distinct JSON keys can normalize to the same map key (e.g. "1" and "01").
      if (normalizedKeys.has(keyText)) {
        throw new JsonFormatError(`${path}: duplicate map key ${JSON.stringify(rawKey)}`);
      }
      normalizedKeys.add(keyText);
      if (rawValue === null) {
        if (valueField.type !== 'message') {
          throw new JsonFormatError(`${path}: null value allowed only for message maps`);
        }
        message.setMapEntry(field, key, new DynamicMessage(valueField.messageType!, this.pool));
        continue;
      }
      if (valueField.type === 'message') {
        if (typeof rawValue !== 'object' || Array.isArray(rawValue)) {
          throw new JsonFormatError(`${path}[${JSON.stringify(rawKey)}]: expected message object`);
        }
        message.setMapEntry(
          field,
          key,
          this.convertMessage(
            rawValue as Record<string, unknown>,
            valueField.messageType!,
            `${path}[${JSON.stringify(rawKey)}]`,
          ),
        );
      } else {
        message.setMapEntry(
          field,
          key,
          this.convertScalar(valueField, rawValue, `${path}[${JSON.stringify(rawKey)}]`),
        );
      }
    }
  }

  private convertMapKey(field: FieldDescriptor, rawKey: string, path: string): JsScalar {
    // JSON object keys are strings; bool/integer/bytes keys parse from text,
    // string keys stay verbatim.
    if (field.type === 'bool') {
      if (rawKey === 'true') return true;
      if (rawKey === 'false') return false;
      throw new JsonFormatError(`${path}: invalid bool map key ${JSON.stringify(rawKey)}`);
    }
    if (field.type === 'string') return rawKey;
    try {
      return this.convertScalar(field, rawKey, path) as JsScalar;
    } catch (e) {
      if (e instanceof JsonFormatError) {
        throw new JsonFormatError(`${path}: invalid map key ${JSON.stringify(rawKey)}`);
      }
      throw e;
    }
  }

  private convertScalar(field: FieldDescriptor, raw: unknown, path: string): JsScalar {
    switch (field.type) {
      case 'double':
      case 'float':
        return this.parseFloat(raw, field, path);
      case 'int64':
      case 'uint64':
      case 'fixed64':
      case 'sfixed64':
      case 'sint64':
        return this.parseInt64(raw, field, path);
      case 'int32':
      case 'uint32':
      case 'fixed32':
      case 'sfixed32':
      case 'sint32':
        return this.parseInt32(raw, field, path);
      case 'bool':
        if (typeof raw !== 'boolean') {
          throw new JsonFormatError(`${path}: bool expected, got ${describeJson(raw)}`);
        }
        return raw;
      case 'string':
        if (typeof raw !== 'string') {
          throw new JsonFormatError(`${path}: string expected, got ${describeJson(raw)}`);
        }
        return raw;
      case 'bytes': {
        if (typeof raw !== 'string') {
          throw new JsonFormatError(`${path}: bytes must be a base64 string`);
        }
        try {
          return decodeBase64Lenient(raw);
        } catch (e) {
          throw new JsonFormatError(`${path}: ${(e as Error).message}`);
        }
      }
      case 'enum':
        return this.parseEnum(raw, field, path);
      default:
        throw new JsonFormatError(`${path}: unsupported scalar type ${field.type}`);
    }
  }

  private parseFloat(raw: unknown, field: FieldDescriptor, path: string): number {
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
      if (raw === 'NaN') return NaN;
      if (raw === 'Infinity') return Infinity;
      if (raw === '-Infinity') return -Infinity;
      // Canonical numeric grammar; reject '', '0x1', '1.', '.', '+1', 'Infinity '.
      if (/^-?(?:\d+|\d+\.\d+|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
        const n = Number(raw);
        if (Number.isNaN(n)) {
          throw new JsonFormatError(`${path}: invalid ${field.type} ${JSON.stringify(raw)}`);
        }
        return n;
      }
    }
    throw new JsonFormatError(`${path}: ${field.type} expected, got ${describeJson(raw)}`);
  }

  private parseInt64(raw: unknown, field: FieldDescriptor, path: string): bigint {
    let text: string;
    if (typeof raw === 'bigint') text = raw.toString();
    else if (typeof raw === 'number') {
      if (!Number.isSafeInteger(raw)) {
        throw new JsonFormatError(
          `${path}: ${field.type} number ${String(raw)} is outside the safe integer range; use a string`,
        );
      }
      text = String(raw);
    } else if (typeof raw === 'string') text = raw;
    else {
      throw new JsonFormatError(`${path}: ${field.type} expected, got ${describeJson(raw)}`);
    }
    if (!/^-?\d+$/.test(text) || text === '-') {
      throw new JsonFormatError(`${path}: invalid ${field.type} ${JSON.stringify(text)}`);
    }
    let value: bigint;
    try {
      value = BigInt(text);
    } catch {
      throw new JsonFormatError(`${path}: invalid ${field.type} ${JSON.stringify(text)}`);
    }
    const [lo, hi] = integerRange(field.type);
    if (value < lo || value > hi) {
      throw new JsonFormatError(`${path}: ${field.type} ${text} out of range`);
    }
    return value;
  }

  private parseInt32(raw: unknown, field: FieldDescriptor, path: string): number {
    // parseInt64 already validated the type-specific range; bigint values in
    // the 32-bit ranges convert losslessly.
    const bi = this.parseInt64(raw, field, path);
    return Number(bi);
  }

  private parseEnum(raw: unknown, field: FieldDescriptor, path: string): number {
    if (typeof raw === 'string') {
      const n = field.enumType!.numberFor(raw);
      if (n === undefined) {
        throw new JsonFormatError(
          `${path}: unknown enum name ${JSON.stringify(raw)} for ${field.enumType!.fullName}`,
        );
      }
      return n;
    }
    if (typeof raw === 'number') {
      if (!Number.isInteger(raw)) {
        throw new JsonFormatError(`${path}: enum number must be an integer`);
      }
      // Enum numbers are int32-scoped; unknown numbers are stored as-is.
      if (raw < -2147483648 || raw > 4294967295) {
        throw new JsonFormatError(`${path}: enum value ${raw} out of range`);
      }
      return raw;
    }
    throw new JsonFormatError(`${path}: enum expected, got ${describeJson(raw)}`);
  }
}

function integerRange(type: string): [bigint, bigint] {
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
      throw new JsonFormatError(`not an integer type: ${type}`);
  }
}

function asString(
  json: Record<string, unknown>,
  descriptor: MessageDescriptor,
  path: string,
): string {
  const keys = Object.keys(json);
  const extra = keys.filter((k) => k !== '');
  if (extra.length > 0) {
    throw new JsonFormatError(
      `${path}: unexpected field(s) ${extra.map((k) => JSON.stringify(k)).join(', ')} for ${descriptor.fullName}`,
    );
  }
  const value = json[''];
  if (typeof value !== 'string') {
    throw new JsonFormatError(`${path}: ${descriptor.fullName} must be a JSON string`);
  }
  return value;
}

// FieldMask path: dot-separated snake/lower-camel identifiers. Must contain
// at least one letter; all-lower or camelCase both accepted on parse.
const MASK_SEGMENT_RE = /^_*[a-z0-9]+(?:_+[a-z0-9]+)*$/;
function isValidMaskPath(p: string): boolean {
  if (p === '' || p.startsWith('.') || p.endsWith('.') || p.includes('..')) return false;
  return p.split('.').every((seg) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(seg) && /[a-zA-Z]/.test(seg));
}

function describeJson(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// ---- base64 (parse accepts url-safe / unpadded alternatives) ---------------

const B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function decodeBase64Lenient(text: string): Uint8Array {
  if (text.includes('=') && !/=+$/.test(text)) {
    throw new Error(`invalid base64 padding: ${JSON.stringify(text)}`);
  }
  let s = text.replace(/=+$/, '');
  const usesUrl = s.includes('-') || s.includes('_');
  const usesStdExtra = s.includes('+') || s.includes('/');
  if (usesUrl && usesStdExtra) throw new Error('mixed base64 alphabets');
  const alphabet = usesUrl ? B64_URL : B64_STD;
  if (s.length === 0) return new Uint8Array(0);
  if (s.length % 4 === 1) throw new Error('invalid base64 length');
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  s += '='.repeat(pad);
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

// ---- strict JSON parser with duplicate-key rejection ------------------------
//
// JSON.parse's reviver cannot observe duplicate raw keys (the later value
// overwrites the earlier one before the reviver ever runs), so the spec's
// strict duplicate detection requires a dedicated scanner.

function parseJsonStrict(text: string): unknown {
  let pos = 0;

  function skipWhitespace(): void {
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c === 32 || c === 9 || c === 10 || c === 13) pos++;
      else break;
    }
  }

  function error(msg: string): never {
    throw new JsonFormatError(`invalid JSON at position ${pos}: ${msg}`);
  }

  function parseValue(): unknown {
    skipWhitespace();
    if (pos >= text.length) error('unexpected end of input');
    const c = text[pos];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (c === 't') return parseLiteral('true', true);
    if (c === 'f') return parseLiteral('false', false);
    if (c === 'n') return parseLiteral('null', null);
    return parseNumber();
  }

  function parseLiteral(literal: string, value: unknown): unknown {
    if (!text.startsWith(literal, pos)) error(`expected ${literal}`);
    pos += literal.length;
    return value;
  }

  function parseObject(): Record<string, unknown> {
    pos++; // {
    const obj: Record<string, unknown> = {};
    const seen = new Set<string>();
    skipWhitespace();
    if (text[pos] === '}') {
      pos++;
      return obj;
    }
    while (true) {
      skipWhitespace();
      if (text[pos] !== '"') error('expected string key');
      const key = parseString();
      if (seen.has(key)) throw new JsonFormatError(`duplicate JSON key ${JSON.stringify(key)}`);
      seen.add(key);
      skipWhitespace();
      if (text[pos] !== ':') error('expected ":"');
      pos++;
      obj[key] = parseValue();
      skipWhitespace();
      const sep = text[pos];
      if (sep === ',') {
        pos++;
        continue;
      }
      if (sep === '}') {
        pos++;
        return obj;
      }
      error('expected "," or "}"');
    }
  }

  function parseArray(): unknown[] {
    pos++; // [
    const arr: unknown[] = [];
    skipWhitespace();
    if (text[pos] === ']') {
      pos++;
      return arr;
    }
    while (true) {
      arr.push(parseValue());
      skipWhitespace();
      const sep = text[pos];
      if (sep === ',') {
        pos++;
        continue;
      }
      if (sep === ']') {
        pos++;
        return arr;
      }
      error('expected "," or "]"');
    }
  }

  function parseString(): string {
    // JSON strings are UTF-16-friendly: surrogate pairs and escapes handled.
    const start = pos;
    pos++; // opening quote
    let result = '';
    let chunkStart = pos;
    while (pos < text.length) {
      const ch = text[pos];
      if (ch === '"') {
        result += text.slice(chunkStart, pos);
        pos++;
        return result;
      }
      if (ch === '\\') {
        result += text.slice(chunkStart, pos);
        pos++;
        const esc = text[pos];
        switch (esc) {
          case '"':
          case '\\':
          case '/':
            result += esc;
            break;
          case 'b':
            result += '\b';
            break;
          case 'f':
            result += '\f';
            break;
          case 'n':
            result += '\n';
            break;
          case 'r':
            result += '\r';
            break;
          case 't':
            result += '\t';
            break;
          case 'u': {
            const hex = text.slice(pos + 1, pos + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) error('invalid unicode escape');
            const code = parseInt(hex, 16);
            pos += 4;
            result += String.fromCharCode(code);
            break;
          }
          default:
            error('invalid escape');
        }
        pos++;
        chunkStart = pos;
      } else {
        const cc = text.charCodeAt(pos);
        if (cc < 0x20) error('unescaped control character');
        pos++;
      }
    }
    void start;
    error('unterminated string');
  }

  function parseNumber(): number {
    const start = pos;
    if (text[pos] === '-') pos++;
    while (pos < text.length && /[0-9eE+\-.]/.test(text[pos])) pos++;
    const raw = text.slice(start, pos);
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
      error(`invalid number ${JSON.stringify(raw)}`);
    }
    return Number(raw);
  }

  const result = parseValue();
  skipWhitespace();
  if (pos !== text.length) error('trailing characters');
  return result;
}
