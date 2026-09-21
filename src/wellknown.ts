import type { DescriptorPool, FileProto, MessageProto } from './descriptors.js';

// The canonical JSON mapping has special forms for these types.
export const WELL_KNOWN = {
  any: 'google.protobuf.Any',
  timestamp: 'google.protobuf.Timestamp',
  duration: 'google.protobuf.Duration',
  fieldMask: 'google.protobuf.FieldMask',
  empty: 'google.protobuf.Empty',
} as const;

/** Wrappers whose JSON form is the bare scalar value. */
export const WRAPPER_TYPES: ReadonlySet<string> = new Set([
  'google.protobuf.DoubleValue',
  'google.protobuf.FloatValue',
  'google.protobuf.Int64Value',
  'google.protobuf.UInt64Value',
  'google.protobuf.Int32Value',
  'google.protobuf.UInt32Value',
  'google.protobuf.StringValue',
  'google.protobuf.BytesValue',
  'google.protobuf.BoolValue',
]);

export function registerWellKnown(pool: DescriptorPool): void {
  if (pool.findMessage(WELL_KNOWN.any)) return;

  const file: FileProto = {
    name: 'google/protobuf/wellknown.proto',
    package: 'google.protobuf',
    syntax: 'proto3',
    messages: [
      {
        kind: 'message',
        name: 'Any',
        fields: [
          { name: 'type_url', number: 1, type: 'string' },
          { name: 'value', number: 2, type: 'bytes' },
        ],
      },
      {
        kind: 'message',
        name: 'Timestamp',
        fields: [
          { name: 'seconds', number: 1, type: 'int64' },
          { name: 'nanos', number: 2, type: 'int32' },
        ],
      },
      {
        kind: 'message',
        name: 'Duration',
        fields: [
          { name: 'seconds', number: 1, type: 'int64' },
          { name: 'nanos', number: 2, type: 'int32' },
        ],
      },
      {
        kind: 'message',
        name: 'FieldMask',
        fields: [{ name: 'paths', number: 1, type: 'string', label: 'repeated' }],
      },
      { kind: 'message', name: 'Empty' },
      wrapper('DoubleValue', 'double'),
      wrapper('FloatValue', 'float'),
      wrapper('Int64Value', 'int64'),
      wrapper('UInt64Value', 'uint64'),
      wrapper('Int32Value', 'int32'),
      wrapper('UInt32Value', 'uint32'),
      wrapper('StringValue', 'string'),
      wrapper('BytesValue', 'bytes'),
      wrapper('BoolValue', 'bool'),
    ],
  };
  pool.addFile(file);
}

function wrapper(name: string, scalar: string): MessageProto {
  return {
    kind: 'message',
    name,
    fields: [{ name: 'value', number: 1, type: scalar }],
  };
}
