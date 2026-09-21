import type {
  Descriptor,
  FieldDescriptor,
  OneofDescriptor,
  ScalarValue,
} from './descriptors.js';

export type Cell =
  | ScalarValue
  | DynamicMessage
  | null
  | undefined;

/**
 * Descriptor-driven protobuf message.
 *
 * Presence rules:
 *  - proto2 / proto3 optional / oneof / message fields: singular cells live
 *    in `present`; has() reflects explicit assignment.
 *  - plain proto3 scalar/enum fields: cell is kept directly; setting the
 *    default value is indistinguishable from unset (proto3 semantics).
 *  - repeated fields: an array; map fields: an ordered Map.
 */
export class DynamicMessage {
  /** singular non-implicit-presence cells, keyed by field */
  private readonly cells = new Map<FieldDescriptor, Cell>();
  /** explicit presence flags (proto2, proto3 optional, oneof, messages) */
  private readonly present = new Set<FieldDescriptor>();
  private readonly repeatedCells = new Map<FieldDescriptor, Cell[]>();
  private readonly mapCells = new Map<FieldDescriptor, Map<string, Cell>>();

  constructor(readonly descriptor: Descriptor) {}

  static create(descriptor: Descriptor): DynamicMessage {
    return new DynamicMessage(descriptor);
  }

  get(fieldName: string): Cell | Cell[] | Map<string, Cell> {
    const f = this.mustField(fieldName);
    if (f.isMap) return this.getMap(f.name);
    if (f.repeated) return this.getRepeated(f.name);
    if (this.cells.has(f)) return this.cells.get(f);
    return this.defaultOf(f);
  }

  set(fieldName: string, value: Cell): void {
    const f = this.mustField(fieldName);
    if (f.isMap) throw new Error(`use setMapEntry for map field ${f.name}`);
    if (f.repeated) throw new Error(`use addRepeated for repeated field ${f.name}`);
    if (f.oneof) this.clearOneof(f.oneof);
    this.storeSingular(f, value);
  }

  has(fieldName: string): boolean {
    const f = this.mustField(fieldName);
    if (f.isMap) return (this.mapCells.get(f)?.size ?? 0) > 0;
    if (f.repeated) return (this.repeatedCells.get(f)?.length ?? 0) > 0;
    if (f.hasExplicitPresence) return this.present.has(f);
    // plain proto3 scalar: a stored cell means a non-default value
    return this.cells.has(f);
  }

  clear(fieldName: string): void {
    const f = this.mustField(fieldName);
    this.cells.delete(f);
    this.present.delete(f);
    this.repeatedCells.delete(f);
    this.mapCells.delete(f);
  }

  oneofCase(oneofName: string): FieldDescriptor | undefined {
    const oneof = this.descriptor.oneofs.find((o) => o.name === oneofName);
    if (!oneof) throw new Error(`no oneof named ${oneofName}`);
    for (const f of this.descriptor.fields) {
      if (f.oneof === oneof && this.present.has(f)) return f;
    }
    return undefined;
  }

  // -- repeated ------------------------------------------------------------

  getRepeated(fieldName: string): Cell[] {
    const f = this.mustField(fieldName);
    let arr = this.repeatedCells.get(f);
    if (!arr) {
      arr = [];
      this.repeatedCells.set(f, arr);
    }
    return arr;
  }

  addRepeated(fieldName: string, value: Cell): void {
    const f = this.mustField(fieldName);
    if (!f.repeated || f.isMap) throw new Error(`${f.name} is not a repeated field`);
    this.getRepeated(f.name).push(value);
  }

  // -- maps ----------------------------------------------------------------

  getMap(fieldName: string): Map<string, Cell> {
    const f = this.mustField(fieldName);
    if (!f.isMap) throw new Error(`${f.name} is not a map field`);
    let m = this.mapCells.get(f);
    if (!m) {
      m = new Map();
      this.mapCells.set(f, m);
    }
    return m;
  }

  setMapEntry(fieldName: string, key: string | number | bigint | boolean, value: Cell): void {
    const f = this.mustField(fieldName);
    if (!f.isMap) throw new Error(`${f.name} is not a map field`);
    this.getMap(f.name).set(String(key), value);
  }

  // -- iteration / introspection ------------------------------------------

  *presentFields(): IterableIterator<FieldDescriptor> {
    for (const f of this.descriptor.fields) {
      if (f.isMap) {
        if ((this.mapCells.get(f)?.size ?? 0) > 0) yield f;
      } else if (f.repeated) {
        if ((this.repeatedCells.get(f)?.length ?? 0) > 0) yield f;
      } else if (this.has(f.name)) {
        yield f;
      }
    }
  }

  presentMap(f: FieldDescriptor): Map<string, Cell> {
    return this.mapCells.get(f) ?? new Map();
  }

  presentRepeated(f: FieldDescriptor): Cell[] {
    return this.repeatedCells.get(f) ?? [];
  }

  /** Low-level access used by the JSON mapper. */
  _store(f: FieldDescriptor, value: Cell): void {
    if (f.oneof) this.clearOneof(f.oneof);
    this.storeSingular(f, value);
  }

  _cell(f: FieldDescriptor): Cell {
    if (this.cells.has(f)) return this.cells.get(f);
    return this.defaultOf(f);
  }

  // -- proto2 required-field validation ------------------------------------

  isInitialized(): boolean {
    for (const f of this.descriptor.fields) {
      if (f.label === 'required' && !this.has(f.name)) return false;
      const sub = (v: Cell): boolean => {
        if (v instanceof DynamicMessage) return v.isInitialized();
        return true;
      };
      if (f.isMap) {
        for (const v of this.presentMap(f).values()) if (!sub(v)) return false;
      } else if (f.repeated) {
        for (const v of this.presentRepeated(f)) if (!sub(v)) return false;
      } else if (this.has(f.name)) {
        if (!sub(this._cell(f))) return false;
      }
    }
    return true;
  }

  // -- internals -----------------------------------------------------------

  private storeSingular(f: FieldDescriptor, value: Cell) {
    // null for a message-typed field is the JSON form of clearing it.
    if (value === null && (f.kind === 'message' || f.dynamicMessage)) {
      this.cells.delete(f);
      this.present.delete(f);
      return;
    }
    this.cells.set(f, value);
    if (f.hasExplicitPresence) {
      // proto2 / proto3 optional / oneof / message / Any.value track
      // presence even when the value equals the default (incl. -0).
      this.present.add(f);
      return;
    }
    // plain proto3 scalar/enum: a value equal to the default is
    // indistinguishable from the field being unset.
    if (isDefaultValue(f, value)) this.cells.delete(f);
  }

  private clearOneof(oneof: OneofDescriptor) {
    for (const f of this.descriptor.fields) {
      if (f.oneof === oneof) {
        this.cells.delete(f);
        this.present.delete(f);
      }
    }
  }

  private defaultOf(f: FieldDescriptor): Cell {
    if (f.kind === 'message') return null;
    if (f.kind === 'enum') {
      if (f.defaultValue !== undefined) return f.defaultValue as number;
      // proto3 open enums default to zero even when unnamed
      return f.enumType!.findValueByNumber(0)?.number ?? 0;
    }
    if (f.defaultValue !== undefined) return f.defaultValue as ScalarValue;
    return scalarDefault(f.scalar!);
  }

  private mustField(name: string): FieldDescriptor {
    const f = this.descriptor.findFieldByName(name);
    if (!f) throw new Error(`no field ${name} on ${this.descriptor.fullName}`);
    return f;
  }
}

export function scalarDefault(scalar: string): ScalarValue {
  switch (scalar) {
    case 'double':
    case 'float':
    case 'int32':
    case 'sint32':
    case 'sfixed32':
    case 'uint32':
    case 'fixed32':
      return 0;
    case 'int64':
    case 'sint64':
    case 'sfixed64':
    case 'uint64':
    case 'fixed64':
      return 0n;
    case 'bool':
      return false;
    case 'string':
      return '';
    case 'bytes':
      return new Uint8Array(0);
    default:
      throw new Error(`not a scalar: ${scalar}`);
  }
}

function isDefaultValue(f: FieldDescriptor, value: Cell): boolean {
  if (f.kind === 'enum') {
    const zero = f.enumType!.findValueByNumber(0);
    return zero !== undefined && value === zero.number;
  }
  const d = scalarDefault(f.scalar!);
  if (typeof d === 'bigint') return (value as bigint) === 0n;
  if (d instanceof Uint8Array) return value instanceof Uint8Array && value.length === 0;
  if (typeof d === 'number') {
    // -0 is distinct from the default +0 so negative zero can round-trip.
    if (Object.is(value, -0)) return false;
    return value === d;
  }
  return value === d;
}

/** Deep, NaN-aware equality used for round-trip assertions. */
export function messagesEqual(a: Cell, b: Cell): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  if (a instanceof DynamicMessage && b instanceof DynamicMessage) {
    if (a.descriptor !== b.descriptor) return false;
    for (const f of a.descriptor.fields) {
      if (a.has(f.name) !== b.has(f.name)) return false;
      if (f.isMap) {
        const am = a.presentMap(f);
        const bm = b.presentMap(f);
        if (am.size !== bm.size) return false;
        for (const [k, v] of am) if (!messagesEqual(v, bm.get(k))) return false;
      } else if (f.repeated) {
        const ar = a.presentRepeated(f);
        const br = b.presentRepeated(f);
        if (ar.length !== br.length) return false;
        for (let i = 0; i < ar.length; i++) if (!messagesEqual(ar[i], br[i])) return false;
      } else if (a.has(f.name)) {
        if (!messagesEqual(a._cell(f), b._cell(f))) return false;
      }
    }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => messagesEqual(v, b[i]));
  }
  return false;
}
