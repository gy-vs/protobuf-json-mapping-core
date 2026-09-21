import { snakeToLowerCamel } from './names.js';

// ---------------------------------------------------------------------------
// Scalar types
// ---------------------------------------------------------------------------

export type ScalarName =
  | 'double' | 'float'
  | 'int32' | 'int64' | 'uint32' | 'uint64'
  | 'sint32' | 'sint64' | 'fixed32' | 'fixed64'
  | 'sfixed32' | 'sfixed64'
  | 'bool' | 'string' | 'bytes';

export const SCALAR_TYPES: ReadonlySet<string> = new Set([
  'double', 'float',
  'int32', 'int64', 'uint32', 'uint64',
  'sint32', 'sint64', 'fixed32', 'fixed64',
  'sfixed32', 'sfixed64',
  'bool', 'string', 'bytes',
]);

export const SIXTY_FOUR_BIT: ReadonlySet<string> = new Set([
  'int64', 'uint64', 'sint64', 'fixed64', 'sfixed64',
]);

/** Runtime value stored for a scalar field. */
export type ScalarValue = number | bigint | string | boolean | Uint8Array;

export type Syntax = 'proto2' | 'proto3';

// ---------------------------------------------------------------------------
// Descriptor input shape (hand-written / programmatically constructed)
// ---------------------------------------------------------------------------

export interface EnumValueProto {
  name: string;
  number: number;
}

export interface EnumProto {
  kind: 'enum';
  name: string;
  values: EnumValueProto[];
}

export interface OneofProto {
  name: string;
}

export interface FieldProto {
  name: string;
  number: number;
  /** scalar name, '.fully.qualified.Type' or a name resolvable in scope.
   *  Required unless this is a map field (use mapKey/mapValue then). */
  type?: string;
  label?: 'optional' | 'required' | 'repeated';
  /** proto3 optional (synthetic oneof, tracks presence). */
  proto3Optional?: boolean;
  oneof?: string;
  /** proto2 explicit default, scalar only. */
  defaultValue?: ScalarValue;
  jsonName?: string;
  /** map field: key scalar + value type, label is implicitly repeated. */
  mapKey?: ScalarName;
  mapValue?: string;
}

export interface MessageProto {
  kind: 'message';
  name: string;
  fields?: FieldProto[];
  oneofs?: OneofProto[];
  nested?: Array<MessageProto | EnumProto>;
  /** marker placed on google.protobuf.Any.value; treated as untyped bytes. */
  untypedBytes?: boolean;
}

export interface FileProto {
  name: string;
  package?: string;
  syntax?: Syntax;
  messages?: Array<MessageProto | EnumProto>;
}

// ---------------------------------------------------------------------------
// Resolved descriptors
// ---------------------------------------------------------------------------

export class EnumValueDescriptor {
  constructor(
    readonly name: string,
    readonly number: number,
  ) {}
}

export class EnumDescriptor {
  readonly fullName: string;
  readonly values: EnumValueDescriptor[] = [];
  /** canonical (first-declared) name per number */
  private readonly byNumber = new Map<number, EnumValueDescriptor>();
  private readonly byName = new Map<string, EnumValueDescriptor>();

  constructor(
    readonly name: string,
    readonly file: FileDescriptor,
    readonly parent: Descriptor | undefined,
  ) {
    this.fullName = parent ? `${parent.fullName}.${name}` : file.packagePrefix() + name;
  }

  _add(v: EnumValueDescriptor) {
    this.values.push(v);
    this.byName.set(v.name, v);
    if (!this.byNumber.has(v.number)) this.byNumber.set(v.number, v);
  }

  findValueByName(name: string): EnumValueDescriptor | undefined {
    return this.byName.get(name);
  }

  findValueByNumber(n: number): EnumValueDescriptor | undefined {
    return this.byNumber.get(n);
  }
}

export class OneofDescriptor {
  constructor(readonly name: string) {}
}

export class FieldDescriptor {
  label: 'optional' | 'required' | 'repeated' = 'optional';
  kind: 'scalar' | 'message' | 'enum' = 'scalar';
  scalar?: ScalarName;
  messageType?: Descriptor;
  enumType?: EnumDescriptor;
  oneof?: OneofDescriptor;
  proto3Optional = false;
  isMap = false;
  mapKey?: FieldDescriptor;
  mapValue?: FieldDescriptor;
  defaultValue?: ScalarValue | number;
  jsonName: string;
  /** google.protobuf.Any.value stores a DynamicMessage despite its bytes type. */
  untypedBytes = false;
  /**
   * A scalar-declared field whose JSON layer carries a DynamicMessage
   * (google.protobuf.Any.value): presence must be tracked like a message.
   */
  dynamicMessage = false;

  constructor(
    readonly name: string,
    readonly number: number,
    readonly containingType: Descriptor,
  ) {
    this.jsonName = snakeToLowerCamel(name);
  }

  get repeated(): boolean {
    return this.label === 'repeated';
  }

  /** Presence is observable for singular fields of this kind (proto3 rules). */
  get hasExplicitPresence(): boolean {
    if (this.repeated || this.isMap) return false;
    if (this.dynamicMessage) return true; // Any.value behaves like a message
    if (this.containingType.file.syntax === 'proto2') return true;
    if (this.kind === 'message') return true;
    if (this.proto3Optional || this.oneof) return true;
    return false;
  }
}

export class Descriptor {
  readonly fullName: string;
  readonly fields: FieldDescriptor[] = [];
  readonly oneofs: OneofDescriptor[] = [];
  readonly nested: Descriptor[] = [] ;
  readonly nestedEnums: EnumDescriptor[] = [];
  private readonly fieldByName = new Map<string, FieldDescriptor>();
  private readonly fieldByNumber = new Map<number, FieldDescriptor>();
  private readonly fieldByJsonName = new Map<string, FieldDescriptor>();

  constructor(
    readonly name: string,
    readonly file: FileDescriptor,
    readonly parent: Descriptor | undefined,
    readonly untypedBytes = false,
  ) {
    this.fullName = parent ? `${parent.fullName}.${name}` : file.packagePrefix() + name;
  }

  _addField(f: FieldDescriptor) {
    this.fields.push(f);
    this.fieldByName.set(f.name, f);
    this.fieldByNumber.set(f.number, f);
    // A jsonName collision is only reported when both names are actually
    // ambiguous; identical fields never reach here.
    if (!this.fieldByJsonName.has(f.jsonName)) this.fieldByJsonName.set(f.jsonName, f);
  }

  findFieldByName(name: string): FieldDescriptor | undefined {
    return this.fieldByName.get(name);
  }

  findFieldByNumber(n: number): FieldDescriptor | undefined {
    return this.fieldByNumber.get(n);
  }

  /** Look up by proto field name or the JSON (camelCase) name. */
  findFieldByJsonName(name: string): FieldDescriptor | undefined {
    return this.fieldByName.get(name) ?? this.fieldByJsonName.get(name);
  }

  findNestedType(name: string): Descriptor | EnumDescriptor | undefined {
    return this.nested.find((m) => m.name === name) ?? this.nestedEnums.find((e) => e.name === name);
  }
}

export class FileDescriptor {
  readonly syntax: Syntax;
  readonly packageName: string;
  readonly messages: Descriptor[] = [];
  readonly enums: EnumDescriptor[] = [];
  /** owning pool, attached by DescriptorPool.addFile */
  pool?: DescriptorPool;

  constructor(
    readonly name: string,
    pkg: string | undefined,
    syntax: Syntax | undefined,
  ) {
    this.packageName = pkg ?? '';
    this.syntax = syntax ?? 'proto2';
  }

  packagePrefix(): string {
    return this.packageName ? `${this.packageName}.` : '';
  }
}

// ---------------------------------------------------------------------------
// Descriptor pool
// ---------------------------------------------------------------------------

export class DescriptorPool {
  private readonly files = new Map<string, FileDescriptor>();
  private readonly messages = new Map<string, Descriptor>();
  private readonly enums = new Map<string, EnumDescriptor>();
  /** files whose types still need resolving */
  private readonly pending: FileDescriptor[] = [];

  constructor(options: { includeWellKnown?: boolean } = {}) {
    if (options.includeWellKnown !== false) {
      registerWellKnown(this);
    }
  }

  addFile(proto: FileProto): FileDescriptor {
    if (this.files.has(proto.name)) {
      throw new Error(`file already registered: ${proto.name}`);
    }
    const file = new FileDescriptor(proto.name, proto.package, proto.syntax);
    file.pool = this;
    this.files.set(proto.name, file);

    // Pass 1: create descriptors and fields, register all names.
    for (const m of proto.messages ?? []) {
      if (m.kind === 'message') this.createMessage(m, file, undefined);
      else this.createEnum(m, file, undefined);
    }
    // Resolve once everything currently registered is visible; if the file
    // references types in files that have not been added yet, defer.
    this.pending.push(file);
    this.tryResolve();
    return file;
  }

  /** Flush any deferred resolution (used after a batch of addFile calls). */
  resolveAll(): void {
    this.tryResolve(true);
  }

  private tryResolve(force = false) {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const file = this.pending[i];
      try {
        for (const m of file.messages) this.resolveMessage(m);
        this.pending.splice(i, 1);
      } catch (e) {
        if (force) throw e;
        const msg = (e as Error).message;
        // Defer only when a referenced type has not been registered yet.
        if (!/^unknown type:|^cannot resolve type/.test(msg)) throw e;
      }
    }
  }

  findMessage(fullName: string): Descriptor | undefined {
    return this.messages.get(fullName);
  }

  findEnum(fullName: string): EnumDescriptor | undefined {
    return this.enums.get(fullName);
  }

  findType(fullName: string): Descriptor | EnumDescriptor | undefined {
    return this.findMessage(fullName) ?? this.findEnum(fullName);
  }

  lookupType(typeUrl: string): Descriptor {
    this.resolveAll();
    // type.googleapis.com/<full.name> with any URL prefix or a leading dot.
    const slash = typeUrl.lastIndexOf('/');
    const full = slash >= 0 ? typeUrl.slice(slash + 1) : typeUrl;
    const trimmed = full.startsWith('.') ? full.slice(1) : full;
    const msg = this.findMessage(trimmed);
    if (!msg) throw new Error(`no message type registered for URL: ${typeUrl}`);
    return msg;
  }

  // -- construction --------------------------------------------------------

  private registerMessage(msg: Descriptor) {
    if (this.messages.has(msg.fullName)) {
      throw new Error(`duplicate message type: ${msg.fullName}`);
    }
    this.messages.set(msg.fullName, msg);
  }

  private registerEnum(e: EnumDescriptor) {
    if (this.enums.has(e.fullName)) {
      throw new Error(`duplicate enum type: ${e.fullName}`);
    }
    this.enums.set(e.fullName, e);
  }

  private createMessage(proto: MessageProto, file: FileDescriptor, parent: Descriptor | undefined): Descriptor {
    const msg = new Descriptor(proto.name, file, parent, proto.untypedBytes);
    if (parent) parent.nested.push(msg);
    else file.messages.push(msg);
    this.registerMessage(msg);

    // Nested types first, so field type references can resolve later.
    for (const n of proto.nested ?? []) {
      if (n.kind === 'message') this.createMessage(n, file, msg);
      else this.createEnum(n, file, msg);
    }

    // Oneofs before fields (fields refer to them).
    for (const oneof of proto.oneofs ?? []) msg.oneofs.push(new OneofDescriptor(oneof.name));

    for (const fp of proto.fields ?? []) this.createField(fp, msg);

    return msg;
  }

  private createField(fp: FieldProto, msg: Descriptor): FieldDescriptor {
    const f = new FieldDescriptor(fp.name, fp.number, msg);
    f.label = fp.label ?? (msg.file.syntax === 'proto3' ? 'optional' : 'optional');
    if (fp.type) rawFieldTypes.set(f, fp.type);
    if (fp.proto3Optional) {
      if (msg.file.syntax !== 'proto3') {
        throw new Error(`proto3Optional on proto2 field: ${msg.fullName}.${fp.name}`);
      }
      f.proto3Optional = true;
      f.oneof = new OneofDescriptor(`_${fp.name}`);
      msg.oneofs.push(f.oneof);
    }
    if (fp.oneof) {
      const oneof = msg.oneofs.find((o) => o.name === fp.oneof);
      if (!oneof) throw new Error(`unknown oneof ${fp.oneof} on ${msg.fullName}`);
      f.oneof = oneof;
    }
    if (fp.jsonName !== undefined) f.jsonName = fp.jsonName;
    if (fp.defaultValue !== undefined) f.defaultValue = fp.defaultValue;
    if (fp.mapKey !== undefined || fp.mapValue !== undefined) {
      if (!fp.mapKey || !fp.mapValue) {
        throw new Error(`map field ${msg.fullName}.${fp.name} needs both key and value types`);
      }
      f.isMap = true;
      f.label = 'repeated';
      const entry = new Descriptor(`${fp.name}Entry`, msg.file, msg);
      const keyF = new FieldDescriptor('key', 1, entry);
      const valF = new FieldDescriptor('value', 2, entry);
      rawFieldTypes.set(keyF, fp.mapKey);
      rawFieldTypes.set(valF, fp.mapValue!);
      entry._addField(keyF);
      entry._addField(valF);
      f.mapKey = keyF;
      f.mapValue = valF;
    }
    if (fp.type === 'google.protobuf.Any' && fp.name === 'value' && msg.fullName === 'google.protobuf.Any') {
      f.untypedBytes = true;
      f.dynamicMessage = true;
    }
    msg._addField(f);
    return f;
  }

  private createEnum(proto: EnumProto, file: FileDescriptor, parent: Descriptor | undefined): EnumDescriptor {
    const e = new EnumDescriptor(proto.name, file, parent);
    if (parent) parent.nestedEnums.push(e);
    else file.enums.push(e);
    this.registerEnum(e);
    for (const v of proto.values) {
      if (e.findValueByName(v.name)) throw new Error(`duplicate enum value name: ${e.fullName}.${v.name}`);
      e._add(new EnumValueDescriptor(v.name, v.number));
    }
    return e;
  }

  private resolveMessage(msg: Descriptor) {
    for (const f of msg.fields) {
      if (f.isMap) {
        this.resolveField(f.mapKey!, msg);
        this.resolveField(f.mapValue!, msg);
      }
      this.resolveField(f, msg);
    }
    for (const n of msg.nested) this.resolveMessage(n);
  }

  private resolveField(f: FieldDescriptor, msg: Descriptor) {
    if (f.isMap) return; // entry children are resolved separately by caller
    const fpType = this.fieldProtoType(f);
    if (!fpType) return;
    if (SCALAR_TYPES.has(fpType)) {
      f.kind = 'scalar';
      f.scalar = fpType as ScalarName;
      if (f.defaultValue !== undefined) {
        f.defaultValue = coerceScalarDefault(f.scalar, f.defaultValue as ScalarValue);
      }
    } else {
      const resolved = this.resolveType(fpType, msg);
      if (resolved instanceof EnumDescriptor) {
        f.kind = 'enum';
        f.enumType = resolved;
        if (f.defaultValue !== undefined) {
          const name = String(f.defaultValue);
          const v = resolved.findValueByName(name);
          if (!v) throw new Error(`unknown enum default ${name} for ${msg.fullName}.${f.name}`);
          f.defaultValue = v.number;
        }
      } else {
        f.kind = 'message';
        f.messageType = resolved;
        if (resolved.untypedBytes) f.untypedBytes = true;
      }
    }
  }

  private fieldProtoType(f: FieldDescriptor): string | undefined {
    // Type string was consumed at creation; stash via WeakMap below.
    return rawFieldTypes.get(f);
  }

  private resolveType(ref: string, scope: Descriptor | FileDescriptor): Descriptor | EnumDescriptor {
    if (ref.startsWith('.')) {
      const full = ref.slice(1);
      const t = this.findType(full);
      if (!t) throw new Error(`unknown type: ${ref}`);
      return t;
    }
    // Candidate enclosing packages/scopes, innermost first.
    const prefixes: string[] = [];
    const file = scope instanceof FileDescriptor ? scope : scope.file;
    const segs = file.packageName ? file.packageName.split('.') : [];
    for (let i = segs.length; i >= 0; i--) prefixes.push(segs.slice(0, i).join(''));
    let m: Descriptor | undefined = scope instanceof Descriptor ? scope : undefined;
    while (m) {
      prefixes.push(m.fullName);
      m = m.parent;
    }
    for (const p of prefixes) {
      const full = p ? `${p}.${ref}` : ref;
      const t = this.findType(full);
      if (t) return t;
    }
    throw new Error(`cannot resolve type ${ref} in scope`);
  }
}

// Creation-time type strings are stashed here (keeps FieldDescriptor fields
// limited to resolved information).
const rawFieldTypes = new WeakMap<FieldDescriptor, string>();

function coerceScalarDefault(scalar: ScalarName, value: ScalarValue): ScalarValue {
  switch (scalar) {
    case 'double':
    case 'float':
      return typeof value === 'number' ? value : Number(value);
    case 'int32':
    case 'sint32':
    case 'sfixed32':
    case 'uint32':
    case 'fixed32':
      return typeof value === 'number' ? value : Number(value);
    case 'int64':
    case 'sint64':
    case 'sfixed64':
    case 'uint64':
    case 'fixed64':
      return typeof value === 'bigint' ? value : BigInt(value as string | number | boolean);
    case 'bool':
      return typeof value === 'boolean' ? value : value === 'true';
    case 'string':
      return String(value);
    case 'bytes':
      return value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
  }
}

// late-binding to avoid a circular import
import { registerWellKnown } from './wellknown.js';
