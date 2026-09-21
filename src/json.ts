import type {
  Descriptor,
  DescriptorPool,
  EnumDescriptor,
  FieldDescriptor,
  ScalarName,
  ScalarValue,
} from './descriptors.js';
import { SIXTY_FOUR_BIT } from './descriptors.js';
import { DynamicMessage, scalarDefault } from './dynamic.js';
import { base64Decode, base64Encode } from './base64.js';
import { lowerCamelToSnake, snakeToLowerCamel } from './names.js';
import {
  WELL_KNOWN,
  WRAPPER_TYPES,
} from './wellknown.js';

export class JsonFormatError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${path || '<root>'}: ${message}`);
    this.name = 'JsonFormatError';
  }
}

export interface ToJsonOptions {
  /** Emit fields whose value equals the default (proto2 semantics). */
  alwaysPrintPrimitiveFields?: boolean;
  /** Pretty-print with the given indent width. */
  indent?: number;
}

export interface FromJsonOptions {
  /** 'strict' rejects unknown JSON keys; 'ignore' skips them. */
  unknownFields?: 'strict' | 'ignore';
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

class Writer {
  private parts: string[] = [];
  readonly step: string;
  constructor(indent: number | undefined) {
    this.step = indent ? ' '.repeat(indent) : '';
  }
  raw(s: string) {
    this.parts.push(s);
  }
  newline(depth: number) {
    if (this.step) {
      this.parts.push('\n');
      this.parts.push(this.step.repeat(depth));
    }
  }
  result() {
    return this.parts.join('');
  }
}

export function toJson(message: DynamicMessage, options: ToJsonOptions = {}): string {
  const w = new Writer(options.indent);
  printMessage(message, w, 0, options);
  return w.result();
}

export function toJsonValue(message: DynamicMessage, options: ToJsonOptions = {}): JsonValue {
  return JSON.parse(toJson(message, options));
}

function nl(w: Writer, depth: number, _opts: ToJsonOptions) {
  w.newline(depth);
}

function printMessage(msg: DynamicMessage, w: Writer, depth: number, opts: ToJsonOptions) {
  const special = printSpecialMessage(msg, w, depth, opts);
  if (special) return;

  const entries: Array<[FieldDescriptor, unknown]> = [];
  for (const f of msg.descriptor.fields) {
    if (f.isMap) {
      const m = msg.presentMap(f);
      if (m.size > 0) entries.push([f, m]);
    } else if (f.repeated) {
      const arr = msg.presentRepeated(f);
      if (arr.length > 0) entries.push([f, arr]);
    } else if (msg.has(f.name)) {
      entries.push([f, msg._cell(f)]);
    } else if (opts.alwaysPrintPrimitiveFields && f.kind !== 'message' && !f.oneof && !f.repeated) {
      entries.push([f, msg._cell(f)]);
    }
  }
  // Canonical, declaration-order-independent output: sort by field number.
  entries.sort((a, b) => a[0].number - b[0].number);

  if (entries.length === 0) {
    w.raw('{}');
    return;
  }
  w.raw('{');
  entries.forEach(([f, value], i) => {
    if (i > 0) w.raw(',');
    nl(w, depth + 1, opts);
    writeJsonString(w, f.jsonName);
    w.raw(':');
    if (opts.indent) w.raw(' ');
    printField(f, value, w, depth + 1, opts);
  });
  nl(w, depth, opts);
  w.raw('}');
}

function printField(f: FieldDescriptor, value: unknown, w: Writer, depth: number, opts: ToJsonOptions) {
  if (f.isMap) {
    printMap(f, value as Map<string, unknown>, w, depth, opts);
    return;
  }
  if (f.repeated) {
    const arr = value as unknown[];
    w.raw('[');
    arr.forEach((v, i) => {
      if (i > 0) w.raw(',');
      if (opts.indent) w.raw(' ');
      printSingular(f, v, w, depth, opts);
    });
    if (opts.indent && arr.length > 0) w.raw(' ');
    w.raw(']');
    return;
  }
  printSingular(f, value, w, depth, opts);
}

function printSingular(f: FieldDescriptor, value: unknown, w: Writer, depth: number, opts: ToJsonOptions) {
  if (f.kind === 'message') {
    if (value === null || value === undefined) {
      w.raw('null');
      return;
    }
    printMessage(value as DynamicMessage, w, depth, opts);
    return;
  }
  if (f.kind === 'enum') {
    if (typeof value !== 'number') throw new JsonFormatError(`enum value must be a number`, f.name);
    const ev = f.enumType!.findValueByNumber(value);
    if (ev) writeJsonString(w, ev.name);
    else writeNumber(w, value); // unknown numeric enum value -> number
    return;
  }
  printScalar(f.scalar!, value as ScalarValue, w);
}

function printScalar(scalar: ScalarName, value: ScalarValue, w: Writer) {
  switch (scalar) {
    case 'double':
    case 'float': {
      const n = value as number;
      if (Number.isNaN(n)) return writeJsonString(w, 'NaN');
      if (n === Infinity) return writeJsonString(w, 'Infinity');
      if (n === -Infinity) return writeJsonString(w, '-Infinity');
      writeNumber(w, n);
      return;
    }
    case 'int32':
    case 'sint32':
    case 'sfixed32':
    case 'uint32':
    case 'fixed32':
      writeNumber(w, value as number);
      return;
    case 'int64':
    case 'sint64':
    case 'sfixed64':
    case 'uint64':
    case 'fixed64':
      writeJsonString(w, (value as bigint).toString());
      return;
    case 'bool':
      w.raw(value ? 'true' : 'false');
      return;
    case 'string':
      writeJsonString(w, value as string);
      return;
    case 'bytes':
      writeJsonString(w, base64Encode(value as Uint8Array));
      return;
  }
}

function writeNumber(w: Writer, n: number) {
  // JSON.stringify renders -0 as "0"; emit the sign explicitly so negative
  // zero round-trips through the canonical mapping.
  if (Object.is(n, -0)) w.raw('-0');
  else w.raw(JSON.stringify(n));
}

function printMap(f: FieldDescriptor, m: Map<string, unknown>, w: Writer, depth: number, opts: ToJsonOptions) {
  const valF = f.mapValue!;
  const keys = [...m.keys()].sort((a, b) => compareMapKeys(f, a, b));
  if (keys.length === 0) {
    w.raw('{}');
    return;
  }
  w.raw('{');
  keys.forEach((k, i) => {
    if (i > 0) w.raw(',');
    nl(w, depth + 1, opts);
    writeJsonString(w, mapKeyToJson(f, k));
    w.raw(':');
    if (opts.indent) w.raw(' ');
    printSingular(valF, m.get(k), w, depth + 1, opts);
  });
  nl(w, depth, opts);
  w.raw('}');
}

function compareMapKeys(f: FieldDescriptor, a: string, b: string): number {
  const scalar = f.mapKey!.scalar!;
  if (scalar === 'bool') return a === b ? 0 : a === 'false' ? -1 : 1;
  if (SIXTY_FOUR_BIT.has(scalar)) {
    const ba = BigInt(a);
    const bb = BigInt(b);
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  }
  if (scalar === 'string') return a < b ? -1 : a > b ? 1 : 0;
  const na = Number(a);
  const nb = Number(b);
  return na - nb;
}

function mapKeyToJson(f: FieldDescriptor, storedKey: string): string {
  const scalar = f.mapKey!.scalar!;
  if (scalar === 'bool') return storedKey === 'true' ? 'true' : 'false';
  if (SIXTY_FOUR_BIT.has(scalar)) {
    // stringify the bigint to normalize (e.g. +01 -> 1)
    return BigInt(storedKey).toString();
  }
  return storedKey;
}

// -- special messages (WKTs) ------------------------------------------------

function printSpecialMessage(msg: DynamicMessage, w: Writer, depth: number, opts: ToJsonOptions): boolean {
  const name = msg.descriptor.fullName;
  switch (name) {
    case WELL_KNOWN.any:
      printAny(msg, w, depth, opts);
      return true;
    case WELL_KNOWN.timestamp:
      writeJsonString(w, formatTimestamp(msg));
      return true;
    case WELL_KNOWN.duration:
      writeJsonString(w, formatDuration(msg));
      return true;
    case WELL_KNOWN.fieldMask: {
      const paths = msg.presentRepeated(msg.descriptor.fields[0]) as string[];
      if (paths.length === 0) {
        w.raw('""');
      } else {
        writeJsonString(w, paths.map(pathsToCamel).join(','));
      }
      return true;
    }
    case WELL_KNOWN.empty:
      w.raw('{}');
      return true;
    default:
      if (WRAPPER_TYPES.has(name)) {
        printWrapper(msg, w);
        return true;
      }
      return false;
  }
}

function printWrapper(msg: DynamicMessage, w: Writer) {
  const valueField = msg.descriptor.fields[0];
  const value = msg.has('value') ? msg._cell(valueField) : scalarDefault(valueField.scalar!);
  if (valueField.scalar === 'string') {
    writeJsonString(w, value as string);
  } else if (valueField.scalar === 'bytes') {
    writeJsonString(w, base64Encode(value as Uint8Array));
  } else if (valueField.scalar === 'bool') {
    w.raw(value ? 'true' : 'false');
  } else if (valueField.scalar === 'float' || valueField.scalar === 'double') {
    printScalar(valueField.scalar, value as ScalarValue, w);
  } else if (SIXTY_FOUR_BIT.has(valueField.scalar!)) {
    writeJsonString(w, (value as bigint).toString());
  } else {
    writeNumber(w, value as number);
  }
}

function printAny(msg: DynamicMessage, w: Writer, depth: number, opts: ToJsonOptions) {
  const typeUrl = msg._cell(msg.descriptor.fields[0]) as string;
  const inner = msg._cell(msg.descriptor.fields[1]);
  if (!typeUrl) {
    // empty Any serializes as {}
    w.raw('{}');
    return;
  }
  const pool = poolOf(msg);
  const type = pool.lookupType(typeUrl);
  let payload: DynamicMessage;
  if (inner instanceof DynamicMessage) {
    payload = inner;
  } else {
    throw new JsonFormatError(`Any ${typeUrl} payload is not decoded`, 'value');
  }
  if (payload.descriptor !== type) {
    throw new JsonFormatError(`Any payload descriptor does not match ${typeUrl}`, 'value');
  }

  if (WRAPPER_TYPES.has(type.fullName)) {
    w.raw('{');
    emitAtType(w, depth + 1, opts, typeUrl, true);
    nl(w, depth + 1, opts);
    writeJsonString(w, 'value');
    w.raw(':');
    if (opts.indent) w.raw(' ');
    printWrapper(payload, w);
    nl(w, depth, opts);
    w.raw('}');
    return;
  }

  const scalarForm =
    type.fullName === WELL_KNOWN.timestamp ||
    type.fullName === WELL_KNOWN.duration ||
    type.fullName === WELL_KNOWN.fieldMask;

  if (scalarForm) {
    w.raw('{');
    emitAtType(w, depth + 1, opts, typeUrl, true);
    nl(w, depth + 1, opts);
    writeJsonString(w, 'value');
    w.raw(':');
    if (opts.indent) w.raw(' ');
    printSpecialMessage(payload, w, depth + 1, opts);
    nl(w, depth, opts);
    w.raw('}');
    return;
  }

  // Recursive Any: an Any packed inside an Any uses the same
  // {"@type", "value"} envelope (value being the inner Any object).
  if (type.fullName === WELL_KNOWN.any) {
    w.raw('{');
    emitAtType(w, depth + 1, opts, typeUrl, true);
    nl(w, depth + 1, opts);
    writeJsonString(w, 'value');
    w.raw(':');
    if (opts.indent) w.raw(' ');
    printMessage(payload, w, depth + 1, opts);
    nl(w, depth, opts);
    w.raw('}');
    return;
  }

  // General form: {"@type": url, ...fields...}
  if (!payloadHasContent(payload)) {
    w.raw('{');
    emitAtType(w, depth + 1, opts, typeUrl, false);
    nl(w, depth, opts);
    w.raw('}');
    return;
  }
  w.raw('{');
  emitAtType(w, depth + 1, opts, typeUrl, false);
  const flatEntries: Array<[FieldDescriptor, unknown]> = [];
  for (const f of payload.descriptor.fields) {
    if (f.isMap) {
      const mv = payload.presentMap(f);
      if (mv.size > 0) flatEntries.push([f, mv]);
    } else if (f.repeated) {
      const rv = payload.presentRepeated(f);
      if (rv.length > 0) flatEntries.push([f, rv]);
    } else if (payload.has(f.name)) {
      flatEntries.push([f, payload._cell(f)]);
    }
  }
  flatEntries.sort((a, b) => a[0].number - b[0].number);
  for (const [f, value] of flatEntries) {
    w.raw(',');
    nl(w, depth + 1, opts);
    writeJsonString(w, f.jsonName);
    w.raw(':');
    if (opts.indent) w.raw(' ');
    printField(f, value, w, depth + 1, opts);
  }
  nl(w, depth, opts);
  w.raw('}');
}

function payloadHasContent(payload: DynamicMessage): boolean {
  for (const f of payload.descriptor.fields) {
    if (f.isMap) {
      if (payload.presentMap(f).size > 0) return true;
    } else if (f.repeated) {
      if (payload.presentRepeated(f).length > 0) return true;
    } else if (payload.has(f.name)) return true;
  }
  return false;
}

function emitAtType(w: Writer, depth: number, opts: ToJsonOptions, typeUrl: string, trailingComma: boolean) {
  nl(w, depth, opts);
  writeJsonString(w, '@type');
  w.raw(':');
  if (opts.indent) w.raw(' ');
  writeJsonString(w, typeUrl);
  if (trailingComma) w.raw(',');
}

// -- Timestamp / Duration formatting ----------------------------------------

function formatTimestamp(msg: DynamicMessage): string {
  const seconds = msg._cell(msg.descriptor.fields[0]) as bigint;
  let nanos = msg._cell(msg.descriptor.fields[1]) as number;
  if (!Number.isInteger(nanos)) throw new JsonFormatError('nanos must be an integer', 'nanos');
  const limit = 253402300800n; // 9999-12-31T23:59:59Z + 1s
  if (seconds < -62135596800n || seconds >= limit) {
    throw new JsonFormatError(`timestamp out of range: ${seconds}`, 'seconds');
  }
  let s = seconds;
  let n = nanos;
  if (n < 0) {
    s -= 1n;
    n += 1_000_000_000;
  }
  const day = floordiv(s, 86400n);
  const tod = s - day * 86400n;
  const { year, month, day: dom } = civilFromDays(day);
  const hour = Number(tod / 3600n);
  const minute = Number((tod % 3600n) / 60n);
  const second = Number(tod % 60n);
  return (
    `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(dom)}` +
    `T${pad2(hour)}:${pad2(minute)}:${pad2(second)}` +
    fracPart(n) + 'Z'
  );
}

function formatDuration(msg: DynamicMessage): string {
  let seconds = msg._cell(msg.descriptor.fields[0]) as bigint;
  let nanos = msg._cell(msg.descriptor.fields[1]) as number;
  if (!Number.isInteger(nanos)) throw new JsonFormatError('nanos must be an integer', 'nanos');
  // canonical normalization: same sign, |nanos| < 1e9
  if ((seconds > 0n && nanos < 0) || (seconds < 0n && nanos > 0)) {
    seconds += 1n;
    nanos -= Math.sign(nanos) * 1_000_000_000;
  }
  const limit = 315576000001n;
  if (
    seconds < -limit || seconds > limit ||
    nanos < -999_999_999 || nanos > 999_999_999 ||
    (seconds === limit && nanos !== 0) || (seconds === -limit && nanos !== 0)
  ) {
    throw new JsonFormatError(`duration out of range: ${seconds}s ${nanos}ns`, '');
  }
  let sign = '';
  if (seconds < 0n || nanos < 0) sign = '-';
  const absS = seconds < 0n ? -seconds : seconds;
  const absN = Math.abs(nanos);
  return `${sign}${absS}${fracPart(absN)}s`;
}

function fracPart(nanos: number): string {
  if (nanos === 0) return '';
  let frac = String(nanos).padStart(9, '0');
  frac = frac.replace(/0+$/, '');
  return '.' + frac;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function floordiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  if ((r !== 0n) && ((r < 0n) !== (b < 0n))) return q - 1n;
  return q;
}

// Howard Hinnant's days_from_civil inverse.
function civilFromDays(z: bigint): { year: number; month: number; day: number } {
  const z2 = z + 719468n;
  const era = floordiv(z2 >= 0n ? z2 : z2 - 146096n, 146097n);
  const doe = z2 - era * 146097n;
  const yoe = (doe - doe / 1460n + doe / 36524n - doe / 146096n) / 365n;
  const y = yoe + era * 400n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const d = doy - (153n * mp + 2n) / 5n + 1n;
  const m = mp < 10n ? mp + 3n : mp - 9n;
  const year = Number(y + (m <= 2n ? 1n : 0n));
  return { year, month: Number(m), day: Number(d) };
}

function pathsToCamel(path: string): string {
  // Each comma-separated segment is an individual snake_case path.
  return path.split('.').map(snakeToLowerCamel).join('.');
}

// -- JSON string writer -----------------------------------------------------

function writeJsonString(w: Writer, s: string) {
  w.raw(JSON.stringify(s));
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface ParseContext {
  pool: DescriptorPool;
  opts: Required<FromJsonOptions>;
}

export function fromJson(
  descriptor: Descriptor,
  json: string | JsonValue,
  pool: DescriptorPool,
  options: FromJsonOptions = {},
): DynamicMessage {
  const ctx: ParseContext = {
    pool,
    opts: { unknownFields: options.unknownFields ?? 'strict' },
  };
  let value: JsonValue;
  if (typeof json === 'string') {
    value = parseJsonStrict(json);
  } else {
    value = json;
  }
  const msg = new DynamicMessage(descriptor);
  parseBody(msg, value, ctx, '');
  return msg;
}

// Minimal JSON parser that rejects duplicate object keys and preserves -0.
function parseJsonStrict(text: string): JsonValue {
  let i = 0;
  const s = text;

  function skipWs() {
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
      else break;
    }
  }

  function parseValue(): JsonValue {
    skipWs();
    const c = s[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    if (s.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (s.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (s.startsWith('null', i)) {
      i += 4;
      return null;
    }
    throw new JsonFormatError(`invalid JSON at offset ${i}`, '');
  }

  function parseObject(): { [k: string]: JsonValue } {
    i++; // {
    const obj: { [k: string]: JsonValue } = {};
    skipWs();
    if (s[i] === '}') {
      i++;
      return obj;
    }
    for (;;) {
      skipWs();
      if (s[i] !== '"') throw new JsonFormatError(`expected string key at offset ${i}`, '');
      const key = parseString();
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        throw new JsonFormatError(`duplicate JSON key "${key}"`, '');
      }
      skipWs();
      if (s[i] !== ':') throw new JsonFormatError(`expected ':' at offset ${i}`, '');
      i++;
      obj[key] = parseValue();
      skipWs();
      if (s[i] === ',') {
        i++;
        continue;
      }
      if (s[i] === '}') {
        i++;
        return obj;
      }
      throw new JsonFormatError(`expected ',' or '}' at offset ${i}`, '');
    }
  }

  function parseArray(): JsonValue[] {
    i++; // [
    const arr: JsonValue[] = [];
    skipWs();
    if (s[i] === ']') {
      i++;
      return arr;
    }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (s[i] === ',') {
        i++;
        continue;
      }
      if (s[i] === ']') {
        i++;
        return arr;
      }
      throw new JsonFormatError(`expected ',' or ']' at offset ${i}`, '');
    }
  }

  function parseString(): string {
    const start = i;
    i++; // opening quote
    while (i < s.length) {
      const c = s[i];
      if (c === '"') {
        const literal = s.slice(start, i + 1);
        i++;
        return JSON.parse(literal) as string;
      }
      if (c === '\\') i += 2;
      else i++;
    }
    throw new JsonFormatError('unterminated string', '');
  }

  function parseNumber(): number {
    const start = i;
    if (s[i] === '-') i++;
    while (i < s.length && /[0-9.eE+-]/.test(s[i])) i++;
    const literal = s.slice(start, i);
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(literal)) {
      throw new JsonFormatError(`invalid number "${literal}"`, '');
    }
    return Number(literal); // Number("-0") === -0
  }

  const result = parseValue();
  skipWs();
  if (i !== s.length) throw new JsonFormatError(`trailing data at offset ${i}`, '');
  return result;
}

function parseBody(msg: DynamicMessage, value: JsonValue, ctx: ParseContext, path: string) {
  // special WKT scalar-form top-level (Timestamps, Duration, FieldMask, wrappers)
  if (isScalarForm(msg.descriptor)) {
    parseScalarForm(msg, value, ctx, path);
    return;
  }
  if (msg.descriptor.fullName === WELL_KNOWN.any) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new JsonFormatError('expected a JSON object', path);
    }
    parseAnyInto(msg, value as Record<string, JsonValue>, ctx, path);
    return;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JsonFormatError('expected a JSON object', path);
  }
  const obj = value as Record<string, JsonValue>;

  const seenFields = new Set<FieldDescriptor>();
  const oneofOwners = new Map<string, FieldDescriptor>();
  for (const key of Object.keys(obj)) {
    if (key === '@type') {
      // @type only valid inside Any; treat as unknown elsewhere
      rejectUnknown(key, ctx, path);
      continue;
    }
    const f = msg.descriptor.findFieldByJsonName(key);
    if (!f) {
      rejectUnknown(key, ctx, path);
      continue;
    }
    if (seenFields.has(f)) {
      // snake_case and camelCase alias of the same field in one object
      throw new JsonFormatError(`conflicting aliases for field "${f.name}"`, joinPath(path, key));
    }
    seenFields.add(f);
    if (f.oneof && !f.proto3Optional) {
      const owner = oneofOwners.get(f.oneof.name);
      if (owner && owner !== f) {
        throw new JsonFormatError(
          `oneof "${f.oneof.name}" has conflicting fields "${owner.name}" and "${f.name}"`,
          joinPath(path, key),
        );
      }
      oneofOwners.set(f.oneof.name, f);
    }
    assignField(msg, f, obj[key], ctx, joinPath(path, key));
  }
}

function rejectUnknown(key: string, ctx: ParseContext, path: string) {
  if (ctx.opts.unknownFields === 'strict') {
    throw new JsonFormatError(`unknown field "${key}"`, path);
  }
}

function assignField(msg: DynamicMessage, f: FieldDescriptor, raw: JsonValue, ctx: ParseContext, path: string) {
  if (raw === null) {
    // null is accepted for any field and clears it (proto JSON convention).
    msg.clear(f.name);
    return;
  }
  if (f.isMap) {
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new JsonFormatError('expected object for map field', path);
    }
    const valF = f.mapValue!;
    const map = msg.getMap(f.name);
    for (const k of Object.keys(raw as object)) {
      const key = parseMapKey(f, k, path);
      const cell = parseSingularCell(valF, (raw as Record<string, JsonValue>)[k], ctx, path);
      map.set(key, cell);
    }
    return;
  }
  if (f.repeated) {
    if (!Array.isArray(raw)) throw new JsonFormatError('expected array for repeated field', path);
    const arr = msg.getRepeated(f.name);
    raw.forEach((v, i) => {
      if (v === null) throw new JsonFormatError('null is not allowed in repeated fields', `${path}[${i}]`);
      arr.push(parseSingularCell(f, v, ctx, `${path}[${i}]`));
    });
    return;
  }
  msg._store(f, parseSingularCell(f, raw, ctx, path));
}

function parseSingularCell(f: FieldDescriptor, raw: JsonValue, ctx: ParseContext, path: string): Cell {
  if (f.kind === 'message' || f.dynamicMessage) return parseMessageField(f, raw, ctx, path);
  if (f.kind === 'enum') return parseEnumValue(f.enumType!, raw, path);
  return parseScalarValue(f.scalar!, raw, path);
}

function parseMessageField(f: FieldDescriptor, raw: JsonValue, ctx: ParseContext, path: string): DynamicMessage {
  // Any.value's declared type is bytes; its actual type comes from @type.
  const targetType = f.dynamicMessage
    ? ctx.pool.findMessage(WELL_KNOWN.any)!
    : f.messageType!;
  const sub = new DynamicMessage(targetType);
  if (targetType.fullName === WELL_KNOWN.any) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new JsonFormatError('expected object for Any', path);
    }
    parseAnyInto(sub, raw as Record<string, JsonValue>, ctx, path);
    return sub;
  }
  if (isScalarForm(targetType)) {
    parseScalarForm(sub, raw, ctx, path);
    return sub;
  }
  parseBody(sub, raw, ctx, path);
  return sub;
}

function isScalarForm(d: Descriptor): boolean {
  return (
    d.fullName === WELL_KNOWN.timestamp ||
    d.fullName === WELL_KNOWN.duration ||
    d.fullName === WELL_KNOWN.fieldMask ||
    WRAPPER_TYPES.has(d.fullName)
  );
}

function parseScalarForm(msg: DynamicMessage, raw: JsonValue, _ctx: ParseContext, path: string) {
  const name = msg.descriptor.fullName;
  if (WRAPPER_TYPES.has(name)) {
    if (raw === null) {
      msg.clear('value');
      return;
    }
    const valueF = msg.descriptor.fields[0];
    msg._store(valueF, parseScalarValue(valueF.scalar!, raw, path));
    return;
  }
  if (name === WELL_KNOWN.timestamp) {
    if (typeof raw !== 'string') throw new JsonFormatError('expected RFC 3339 timestamp string', path);
    const { seconds, nanos } = parseTimestamp(raw, path);
    msg._store(msg.descriptor.fields[0], seconds);
    msg._store(msg.descriptor.fields[1], nanos);
    return;
  }
  if (name === WELL_KNOWN.duration) {
    if (typeof raw !== 'string') throw new JsonFormatError('expected duration string', path);
    const { seconds, nanos } = parseDuration(raw, path);
    msg._store(msg.descriptor.fields[0], seconds);
    msg._store(msg.descriptor.fields[1], nanos);
    return;
  }
  if (name === WELL_KNOWN.fieldMask) {
    if (typeof raw !== 'string') throw new JsonFormatError('expected comma-separated FieldMask string', path);
    const arr = msg.getRepeated('paths');
    if (raw.length > 0) {
      for (const part of raw.split(',')) {
        arr.push(part.split('.').map(lowerCamelToSnake).join('.'));
      }
    }
    return;
  }
}

// -- Any --------------------------------------------------------------------

function parseAnyInto(msg: DynamicMessage, obj: Record<string, JsonValue>, ctx: ParseContext, path: string) {
  const typeUrlRaw = obj['@type'];
  if (typeUrlRaw === undefined) {
    // Only an empty JSON object represents an unset Any.
    for (const k of Object.keys(obj)) rejectUnknown(k, ctx, path);
    return;
  }
  if (typeof typeUrlRaw !== 'string') throw new JsonFormatError('@type must be a string', joinPath(path, '@type'));
  const type = ctx.pool.lookupType(typeUrlRaw);

  // store type_url on the Any message
  msg._store(msg.descriptor.fields[0], typeUrlRaw);

  const inner = new DynamicMessage(type);

  if (WRAPPER_TYPES.has(type.fullName)) {
    const v = obj['value'];
    if (v === undefined) throw new JsonFormatError(`Any ${typeUrlRaw} missing "value"`, path);
    parseScalarForm(inner, v, ctx, joinPath(path, 'value'));
    for (const k of Object.keys(obj)) {
      if (k === '@type' || k === 'value') continue;
      rejectUnknown(k, ctx, path);
    }
  } else if (
    type.fullName === WELL_KNOWN.timestamp ||
    type.fullName === WELL_KNOWN.duration ||
    type.fullName === WELL_KNOWN.fieldMask
  ) {
    const v = obj['value'];
    if (v === undefined) throw new JsonFormatError(`Any ${typeUrlRaw} missing "value"`, path);
    parseScalarForm(inner, v, ctx, joinPath(path, 'value'));
    for (const k of Object.keys(obj)) {
      if (k === '@type' || k === 'value') continue;
      rejectUnknown(k, ctx, path);
    }
  } else if (type.fullName === WELL_KNOWN.any) {
    // Recursive Any: "value" is itself an Any JSON object.
    const v = obj['value'];
    if (v === undefined) throw new JsonFormatError(`Any ${typeUrlRaw} missing "value"`, path);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new JsonFormatError('expected object for nested Any', joinPath(path, 'value'));
    }
    parseAnyInto(inner, v as Record<string, JsonValue>, ctx, joinPath(path, 'value'));
    for (const k of Object.keys(obj)) {
      if (k === '@type' || k === 'value') continue;
      rejectUnknown(k, ctx, path);
    }
  } else {
    // General form: all remaining keys are fields of the inner type.
    for (const k of Object.keys(obj)) {
      if (k === '@type') continue;
      const f = type.findFieldByJsonName(k);
      if (!f) {
        rejectUnknown(k, ctx, path);
        continue;
      }
      assignField(inner, f, obj[k], ctx, joinPath(path, k));
    }
  }

  msg._store(msg.descriptor.fields[1], inner);
}

// -- scalar parsing ---------------------------------------------------------

const FLOAT_LITERAL = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

function parseScalarValue(scalar: ScalarName, raw: JsonValue, path: string): ScalarValue {
  switch (scalar) {
    case 'double':
    case 'float': {
      if (raw === 'NaN') return NaN;
      if (raw === 'Infinity') return Infinity;
      if (raw === '-Infinity') return -Infinity;
      if (typeof raw === 'number') return raw;
      if (typeof raw === 'string' && FLOAT_LITERAL.test(raw)) return Number(raw);
      throw new JsonFormatError(`invalid ${scalar}: ${describe(raw)}`, path);
    }
    case 'int32':
    case 'sint32':
    case 'sfixed32':
      return check32(parseInteger(raw, path), scalar, true, path);
    case 'uint32':
    case 'fixed32':
      return check32(parseInteger(raw, path), scalar, false, path);
    case 'int64':
    case 'sint64':
    case 'sfixed64':
      return check64(parseBigInt(raw, path), true, path);
    case 'uint64':
    case 'fixed64':
      return check64(parseBigInt(raw, path), false, path);
    case 'bool':
      if (raw === true || raw === 'true') return true;
      if (raw === false || raw === 'false') return false;
      throw new JsonFormatError(`invalid bool: ${describe(raw)}`, path);
    case 'string':
      if (typeof raw !== 'string') throw new JsonFormatError(`invalid string: ${describe(raw)}`, path);
      return raw;
    case 'bytes':
      if (typeof raw !== 'string') throw new JsonFormatError(`invalid bytes: ${describe(raw)}`, path);
      try {
        return base64Decode(raw);
      } catch (e) {
        throw new JsonFormatError((e as Error).message, path);
      }
  }
}

function parseInteger(raw: JsonValue, path: string): number {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) throw new JsonFormatError(`invalid integer: ${describe(raw)}`, path);
    return raw;
  }
  if (typeof raw === 'string') {
    if (!/^[+-]?(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(raw)) {
      throw new JsonFormatError(`invalid integer: ${describe(raw)}`, path);
    }
    return Number(raw);
  }
  throw new JsonFormatError(`invalid integer: ${describe(raw)}`, path);
}

function parseBigInt(raw: JsonValue, path: string): bigint {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) throw new JsonFormatError(`integer out of safe range: ${raw}`, path);
    return BigInt(raw);
  }
  if (typeof raw === 'string') {
    try {
      if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(raw)) return BigInt(raw);
      if (!/^[+-]?[0-9]+$/.test(raw)) throw new Error('bad');
      return BigInt(raw);
    } catch {
      throw new JsonFormatError(`invalid integer: ${describe(raw)}`, path);
    }
  }
  throw new JsonFormatError(`invalid integer: ${describe(raw)}`, path);
}

function check32(n: number, _scalar: string, signed: boolean, path: string): number {
  if (!Number.isInteger(n)) throw new JsonFormatError(`invalid integer: ${n}`, path);
  const min = signed ? -2147483648 : 0;
  const max = signed ? 2147483647 : 4294967295;
  if (n < min || n > max) throw new JsonFormatError(`integer out of ${_scalar} range: ${n}`, path);
  return n;
}

function check64(n: bigint, signed: boolean, path: string): bigint {
  if (signed) {
    if (n < -9223372036854775808n || n > 9223372036854775807n) {
      throw new JsonFormatError(`integer out of range: ${n}`, path);
    }
  } else if (n < 0n || n > 18446744073709551615n) {
    throw new JsonFormatError(`integer out of range: ${n}`, path);
  }
  return n;
}

function parseEnumValue(e: EnumDescriptor, raw: JsonValue, path: string): number {
  if (typeof raw === 'string') {
    const v = e.findValueByName(raw);
    if (!v) throw new JsonFormatError(`unknown enum value "${raw}" for ${e.fullName}`, path);
    return v.number;
  }
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    if (raw < -2147483648 || raw > 2147483647) {
      throw new JsonFormatError(`enum number out of range: ${raw}`, path);
    }
    // Unknown numeric values are retained verbatim (proto3 open enums).
    return raw;
  }
  throw new JsonFormatError(`invalid enum value: ${describe(raw)}`, path);
}

function parseMapKey(f: FieldDescriptor, key: string, path: string): string {
  const scalar = f.mapKey!.scalar!;
  if (scalar === 'string') return key;
  if (scalar === 'bool') {
    if (key !== 'true' && key !== 'false') throw new JsonFormatError(`invalid bool map key: ${key}`, path);
    return key;
  }
  if (SIXTY_FOUR_BIT.has(scalar)) {
    const n = parseBigInt(key, path);
    check64(n, scalar === 'uint64' || scalar === 'fixed64', path);
    return n.toString();
  }
  const n = parseInteger(key, path);
  check32(n, scalar, scalar !== 'uint32' && scalar !== 'fixed32', path);
  return String(n);
}

// -- Timestamp / Duration parsing -------------------------------------------

const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/;

function parseTimestamp(text: string, path: string): { seconds: bigint; nanos: number } {
  const m = TIMESTAMP_RE.exec(text);
  if (!m) throw new JsonFormatError(`invalid timestamp: ${text}`, path);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  let nanos = 0;
  if (m[7] !== undefined) nanos = Number(m[7].padEnd(9, '0'));
  if (year < 1 || year > 9999) throw new JsonFormatError(`timestamp year out of range: ${year}`, path);
  if (month < 1 || month > 12) throw new JsonFormatError(`invalid month: ${month}`, path);
  validateDay(year, month, day, path);
  if (hour > 23 || minute > 59 || second > 60) {
    throw new JsonFormatError(`invalid time of day in timestamp: ${text}`, path);
  }
  let offsetSec = 0;
  const tz = m[8];
  if (tz && tz !== 'Z' && tz !== 'z') {
    const sign = tz[0] === '-' ? -1 : 1;
    offsetSec = sign * (Number(tz.slice(1, 3)) * 3600 + Number(tz.slice(4, 6)) * 60);
  }
  const days = daysFromCivil(year, month, day);
  let seconds = days * 86400n + BigInt(hour * 3600 + minute * 60 + second - offsetSec);
  if (second === 60) seconds -= 1n; // accept leap second, normalize to :59
  const limit = 253402300800n;
  if (seconds < -62135596800n || seconds >= limit) {
    throw new JsonFormatError(`timestamp out of range: ${text}`, path);
  }
  return { seconds, nanos };
}

const DURATION_RE = /^(-)?(\d+)(?:\.(\d{1,9}))?s$/;

function parseDuration(text: string, path: string): { seconds: bigint; nanos: number } {
  const m = DURATION_RE.exec(text);
  if (!m) throw new JsonFormatError(`invalid duration: ${text}`, path);
  const neg = m[1] === '-';
  const wholeSeconds = BigInt(m[2]);
  let nanos = m[3] !== undefined ? Number(m[3].padEnd(9, '0')) : 0;
  const maxNanos = wholeSeconds === 315576000001n ? 0 : 999_999_999;
  if (wholeSeconds > 315576000001n || nanos > maxNanos) {
    throw new JsonFormatError(`duration out of range: ${text}`, path);
  }
  // -0s is numerically zero: normalize the signed zero to +0.
  if (neg && wholeSeconds === 0n && nanos === 0) {
    return { seconds: 0n, nanos: 0 };
  }
  if (neg) return { seconds: -wholeSeconds, nanos: -nanos };
  return { seconds: wholeSeconds, nanos };
}

function validateDay(year: number, month: number, day: number, path: string) {
  const dim = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > dim[month - 1]) {
    throw new JsonFormatError(`invalid date: day ${day}`, path);
  }
}

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysFromCivil(year: number, month: number, day: number): bigint {
  const y = BigInt(year) - (month <= 2 ? 1n : 0n);
  const era = y >= 0n ? y / 400n : (y - 399n) / 400n;
  const yoe = y - era * 400n;
  const mp = BigInt(month) > 2n ? BigInt(month) - 3n : BigInt(month) + 9n;
  const doy = (153n * mp + 2n) / 5n + BigInt(day) - 1n;
  const doe = yoe * 365n + yoe / 4n - yoe / 100n + doy;
  return era * 146097n + doe - 719468n;
}

// -- helpers ----------------------------------------------------------------

function poolOf(msg: DynamicMessage): DescriptorPool {
  const pool = msg.descriptor.file.pool;
  if (!pool) throw new Error('descriptor file has no pool attached');
  return pool;
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function describe(v: JsonValue): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[array]';
  if (v === null) return 'null';
  return String(v);
}

type Cell = import('./dynamic.js').Cell;
