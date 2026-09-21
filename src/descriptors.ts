// Minimal descriptor model (proto syntax / labels / types) plus a
// DescriptorPool that resolves fully-qualified names and `Any` type URLs.

export type Syntax = 'proto2' | 'proto3';

export type FieldType =
  | 'double'
  | 'float'
  | 'int64'
  | 'uint64'
  | 'int32'
  | 'fixed64'
  | 'fixed32'
  | 'bool'
  | 'string'
  | 'group'
  | 'message'
  | 'bytes'
  | 'uint32'
  | 'enum'
  | 'sfixed32'
  | 'sfixed64'
  | 'sint32'
  | 'sint64';

export interface EnumValueDescriptor {
  name: string;
  number: number;
}

export class EnumDescriptor {
  readonly values: EnumValueDescriptor[];
  private readonly byNumber = new Map<number, string>();

  constructor(
    readonly fullName: string,
    values: EnumValueDescriptor[],
  ) {
    // JSON mapping uses the first declared name for an aliased number
    // (canonical enum value names are the first one declared).
    this.values = values;
    for (const v of values) if (!this.byNumber.has(v.number)) this.byNumber.set(v.number, v.name);
  }

  nameFor(number: number): string | undefined {
    return this.byNumber.get(number);
  }

  numberFor(name: string): number | undefined {
    return this.values.find((v) => v.name === name)?.number;
  }

  /** Every name that resolves to a number (includes alias names). */
  hasName(name: string): boolean {
    return this.values.some((v) => v.name === name);
  }
}

export interface OneofDescriptor {
  readonly name: string;
}

export class FieldDescriptor {
  /** Has a value been set explicitly (tracked on the field descriptor itself
   * is wrong; presence lives on values, see PresentValue). */
  readonly oneof?: OneofDescriptor;
  /** True for proto3 `optional` and proto2 optional/required scalars, and
   * always for message fields. */
  readonly hasPresence: boolean;
  readonly jsonName: string;
  /** Alternate JSON names that parse must accept (snake_case and json_name). */
  readonly acceptedNames: string[];

  constructor(
    readonly name: string,
    readonly number: number,
    readonly type: FieldType,
    readonly label: 'optional' | 'required' | 'repeated',
    readonly syntax: Syntax,
    readonly containingOneof: OneofDescriptor | undefined,
    readonly messageType: MessageDescriptor | undefined,
    readonly enumType: EnumDescriptor | undefined,
    readonly proto3Optional: boolean,
    readonly customJsonName: string | undefined,
    readonly isMap: boolean,
    readonly isPackable: boolean,
  ) {
    this.oneof = containingOneof;
    this.jsonName = customJsonName ?? defaultJsonName(name);
    const names = new Set<string>([this.jsonName]);
    if (this.jsonName !== name) names.add(name);
    this.acceptedNames = [...names];
    this.hasPresence =
      label !== 'repeated' &&
      (syntax === 'proto2' ||
        proto3Optional ||
        containingOneof !== undefined ||
        type === 'message');
  }

  get isRepeated(): boolean {
    return this.label === 'repeated';
  }
}

export class MessageDescriptor {
  readonly fields: FieldDescriptor[] = [];
  readonly oneofs: OneofDescriptor[] = [];
  private readonly byJsonName = new Map<string, FieldDescriptor>();
  readonly mapEntry: { key: FieldDescriptor; value: FieldDescriptor } | undefined;

  constructor(
    readonly fullName: string,
    readonly syntax: Syntax,
    mapEntry?: { key: FieldDescriptor; value: FieldDescriptor },
  ) {
    this.mapEntry = mapEntry;
  }

  /** @internal */
  _addField(field: FieldDescriptor): void {
    this.fields.push(field);
    for (const n of field.acceptedNames) {
      // First field wins; duplicate accepted names only occur for hand-built
      // descriptors and are reported during pool finalization.
      if (!this.byJsonName.has(n)) this.byJsonName.set(n, field);
    }
  }

  /** @internal */
  _addOneof(oneof: OneofDescriptor): void {
    this.oneofs.push(oneof);
  }

  fieldByName(jsonName: string): FieldDescriptor | undefined {
    return this.byJsonName.get(jsonName);
  }

  fieldByNumber(number: number): FieldDescriptor | undefined {
    return this.fields.find((f) => f.number === number);
  }
}

export function defaultJsonName(fieldName: string): string {
  // Inline snake->camel to avoid a module cycle; rules identical to names.ts.
  let out = '';
  let cap = false;
  for (let i = 0; i < fieldName.length; i++) {
    const ch = fieldName[i];
    if (ch === '_') {
      if (i === 0) {
        out += ch;
        continue;
      }
      if (i + 1 >= fieldName.length || fieldName[i + 1] === '_') {
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

/** Declarative field specification for {@link DescriptorPool.builder}. */
export interface FieldSpec {
  name: string;
  number: number;
  type: FieldType;
  label?: 'optional' | 'required' | 'repeated';
  typeName?: string; // fully-qualified message/enum name
  jsonName?: string;
  oneof?: string;
  proto3Optional?: boolean;
  map?: { key: FieldType; value: FieldType; valueTypeName?: string };
}

export interface MessageSpec {
  name: string; // fully qualified, e.g. ".foo.Bar"
  syntax?: Syntax; // default proto3
  fields?: FieldSpec[];
  /** Register this message as a synthetic map-entry message (handled
   * automatically when a field uses `map`). */
  oneofs?: string[];
}

export interface EnumSpec {
  name: string; // fully qualified
  values: { name: string; number: number }[];
}

export interface FileSpec {
  messages?: MessageSpec[];
  enums?: EnumSpec[];
}

/**
 * Resolves message/enum descriptors by fully-qualified name and by
 * `type.googleapis.com/<full.name>` URL (used by `Any`).
 */
export class DescriptorPool {
  private readonly messages = new Map<string, MessageDescriptor>();
  private readonly enums = new Map<string, EnumDescriptor>();

  constructor(files: FileSpec[] = []) {
    for (const file of files) this.registerFile(file);
  }

  registerFile(file: FileSpec): void {
    // Phase 1: create all messages and enums so forward references work.
    const pending: { msg: MessageDescriptor; spec: MessageSpec }[] = [];
    for (const spec of file.messages ?? []) {
      const full = normalize(spec.name);
      if (this.messages.has(full)) throw new Error(`duplicate message ${full}`);
      const msg = new MessageDescriptor(full, spec.syntax ?? 'proto3');
      this.messages.set(full, msg);
      pending.push({ msg, spec });
    }
    for (const spec of file.enums ?? []) {
      const full = normalize(spec.name);
      if (this.enums.has(full)) throw new Error(`duplicate enum ${full}`);
      this.enums.set(full, new EnumDescriptor(full, spec.values));
    }
    // Phase 2: fields (and synthetic map entries).
    for (const { msg, spec } of pending) this.buildFields(msg, spec);
  }

  private buildFields(msg: MessageDescriptor, spec: MessageSpec): void {
    const oneofs = new Map<string, OneofDescriptor>();
    for (const name of spec.oneofs ?? []) {
      const o = { name };
      oneofs.set(name, o);
      msg._addOneof(o);
    }
    const jsonOwners = new Map<string, string>(); // json name -> field name
    for (const f of spec.fields ?? []) {
      let messageType: MessageDescriptor | undefined;
      let enumType: EnumDescriptor | undefined;
      let isMap = false;
      const packable =
        f.type !== 'message' &&
        f.type !== 'group' &&
        f.type !== 'string' &&
        f.type !== 'bytes';

      if (f.map) {
        isMap = true;
        const entryName = `${msg.fullName}.${f.name[0].toUpperCase()}${f.name.slice(1)}Entry`;
        const keyField = new FieldDescriptor(
          'key', 1, f.map.key, 'optional', msg.syntax, undefined,
          undefined, undefined, false, undefined, false,
          f.map.key !== 'string' && f.map.key !== 'bytes',
        );
        const valueMsgType =
          f.map.value === 'message'
            ? this.lookupMessage(f.map.valueTypeName ?? '')
            : undefined;
        const valueEnumType =
          f.map.value === 'enum' ? this.lookupEnum(f.map.valueTypeName ?? '') : undefined;
        const valueField = new FieldDescriptor(
          'value', 2, f.map.value, 'optional', msg.syntax, undefined,
          valueMsgType, valueEnumType, false, undefined, false,
          f.map.value !== 'string' && f.map.value !== 'message' && f.map.value !== 'bytes',
        );
        const entry = new MessageDescriptor(entryName, msg.syntax, {
          key: keyField,
          value: valueField,
        });
        entry._addField(keyField);
        entry._addField(valueField);
        this.messages.set(entryName, entry);
        messageType = entry;
      } else if (f.type === 'message') {
        messageType = this.lookupMessage(f.typeName ?? '');
      } else if (f.type === 'enum') {
        enumType = this.lookupEnum(f.typeName ?? '');
      }

      let oneof: OneofDescriptor | undefined;
      if (f.oneof) {
        oneof = oneofs.get(f.oneof);
        if (!oneof) {
          oneof = { name: f.oneof };
          oneofs.set(f.oneof, oneof);
          msg._addOneof(oneof);
        }
      }
      const label = isMap ? 'repeated' : (f.label ?? 'optional');
      const field = new FieldDescriptor(
        f.name, f.number, f.type,
        isMap ? 'repeated' : label,
        msg.syntax, oneof, messageType, enumType,
        !!f.proto3Optional, f.jsonName, isMap,
        isMap ? false : packable,
      );
      msg._addField(field);
      for (const n of field.acceptedNames) {
        const owner = jsonOwners.get(n);
        if (owner !== undefined && owner !== f.name) {
          throw new Error(
            `JSON name ${JSON.stringify(n)} on ${msg.fullName}.${f.name} ` +
              `is also accepted by field ${owner}`,
          );
        }
        jsonOwners.set(n, f.name);
      }
    }
  }

  lookupMessage(fullName: string): MessageDescriptor {
    const full = normalize(fullName);
    const msg = this.messages.get(full);
    if (!msg) throw new Error(`unknown message type: ${fullName}`);
    return msg;
  }

  lookupEnum(fullName: string): EnumDescriptor {
    const full = normalize(fullName);
    const en = this.enums.get(full);
    if (!en) throw new Error(`unknown enum type: ${fullName}`);
    return en;
  }

  findMessage(fullName: string): MessageDescriptor | undefined {
    return this.messages.get(normalize(fullName));
  }

  /**
   * Resolve an Any type URL. Both `type.googleapis.com/foo.Bar` and
   * `type.googleprod.com/foo.Bar` host prefixes are accepted; anything else
   * must still use the path suffix as the fully-qualified name.
   */
  resolveTypeUrl(typeUrl: string): MessageDescriptor | undefined {
    const slash = typeUrl.indexOf('/');
    const full = slash < 0 ? typeUrl : typeUrl.slice(slash + 1);
    return this.messages.get(normalize(full));
  }
}

function normalize(name: string): string {
  return name.startsWith('.') ? name : '.' + name;
}

// ---- Well-known type constants ---------------------------------------------

export const ANY_TYPE = '.google.protobuf.Any';
export const TIMESTAMP_TYPE = '.google.protobuf.Timestamp';
export const DURATION_TYPE = '.google.protobuf.Duration';
export const FIELD_MASK_TYPE = '.google.protobuf.FieldMask';
export const STRUCT_TYPE = '.google.protobuf.Struct';
export const VALUE_TYPE = '.google.protobuf.Value';
export const LIST_VALUE_TYPE = '.google.protobuf.ListValue';
export const EMPTY_TYPE = '.google.protobuf.Empty';

/** Descriptor pool pre-populated with the JSON-special well-known types. */
export function standardPool(extraFiles: FileSpec[] = []): DescriptorPool {
  const pool = new DescriptorPool([
    {
      messages: [
        {
          name: ANY_TYPE,
          syntax: 'proto3',
          fields: [
            { name: 'type_url', number: 1, type: 'string' },
            { name: 'value', number: 2, type: 'bytes' },
          ],
        },
        {
          name: TIMESTAMP_TYPE,
          syntax: 'proto3',
          fields: [
            { name: 'seconds', number: 1, type: 'int64' },
            { name: 'nanos', number: 2, type: 'int32' },
          ],
        },
        {
          name: DURATION_TYPE,
          syntax: 'proto3',
          fields: [
            { name: 'seconds', number: 1, type: 'int64' },
            { name: 'nanos', number: 2, type: 'int32' },
          ],
        },
        {
          name: FIELD_MASK_TYPE,
          syntax: 'proto3',
          fields: [{ name: 'paths', number: 1, type: 'string', label: 'repeated' }],
        },
        { name: EMPTY_TYPE, syntax: 'proto3' },
      ],
    },
  ]);
  for (const f of extraFiles) pool.registerFile(f);
  return pool;
}
