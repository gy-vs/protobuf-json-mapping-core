import { expect, it, describe } from 'vitest';
import {
  DescriptorPool,
  DynamicMessage,
  toJson,
  fromJson,
  JsonFormatError,
  type FileProto,
} from '../src/index.js';

function pool(): DescriptorPool {
  const p = new DescriptorPool();
  p.addFile({
    name: 'x.proto',
    package: 'x',
    syntax: 'proto3',
    messages: [
      {
        kind: 'message',
        name: 'Root',
        fields: [
          { name: 'any', number: 1, type: 'google.protobuf.Any' },
          { name: 'subs', number: 2, type: 'Sub', label: 'repeated' },
          { name: 'sub_map', number: 3, type: 'Sub', mapKey: 'string', mapValue: 'Sub' },
          { name: 'opt_enum', number: 4, type: 'E', proto3Optional: true },
          { name: 'fm', number: 5, type: 'google.protobuf.FieldMask' },
          { name: 'd', number: 6, type: 'google.protobuf.Duration' },
        ],
      },
      {
        kind: 'message',
        name: 'Sub',
        fields: [
          { name: 'n', number: 1, type: 'int32' },
          { name: 'e', number: 2, type: 'E' },
        ],
      },
    ],
  } as FileProto);
  p.addFile({
    name: 'xe.proto',
    package: 'x',
    syntax: 'proto3',
    messages: [
      {
        kind: 'enum',
        name: 'E',
        values: [
          { name: 'E0', number: 0 },
          { name: 'E1', number: 1 },
        ],
      },
    ],
  } as FileProto);
  return p;
}

describe('additional edge cases', () => {
  it('unknown keys inside Any follow strict/ignore policy', () => {
    const p = pool();
    const R = p.findMessage('x.Root')!;
    const text = '{"any":{"@type":"type.googleapis.com/x.Sub","bogus":1}}';
    expect(() => fromJson(R, text, p)).toThrow(/unknown field "bogus"/);
    const m = fromJson(R, text, p, { unknownFields: 'ignore' });
    const any = m.get('any') as DynamicMessage;
    expect((any.get('value') as DynamicMessage).descriptor.fullName).toBe('x.Sub');
  });

  it('repeated and map of messages round-trip', () => {
    const p = pool();
    const R = p.findMessage('x.Root')!;
    const text = '{"subs":[{"n":1},{"n":2}],"subMap":{"k":{"n":3},"empty":{}}}';
    const m = fromJson(R, text, p);
    expect((m.get('subs') as unknown[]).length).toBe(2);
    const map = m.get('sub_map') as Map<string, DynamicMessage>;
    expect(map.get('empty')?.has('n')).toBe(false);
    expect(toJson(m)).toBe('{"subs":[{"n":1},{"n":2}],"subMap":{"empty":{},"k":{"n":3}}}');
  });

  it('proto3 optional enum tracks presence including zero', () => {
    const p = pool();
    const R = p.findMessage('x.Root')!;
    const m = fromJson(R, '{"optEnum":"E0"}', p);
    expect(m.has('opt_enum')).toBe(true);
    expect(m.get('opt_enum')).toBe(0);
    expect(toJson(m)).toBe('{"optEnum":"E0"}');
  });

  it('uint64 rejects negative numbers and strings', () => {
    const p = new DescriptorPool();
    p.addFile({
      name: 'u.proto',
      package: 'u',
      syntax: 'proto3',
      messages: [
        {
          kind: 'message',
          name: 'U',
          fields: [
            { name: 'u', number: 1, type: 'uint64' },
            { name: 'u32', number: 2, type: 'uint32' },
            { name: 'i32', number: 3, type: 'int32' },
          ],
        },
      ],
    });
    const U = p.findMessage('u.U')!;
    expect(() => fromJson(U, '{"u":-5}', p)).toThrow(JsonFormatError);
    expect(() => fromJson(U, '{"u32":-1}', p)).toThrow(JsonFormatError);
    expect(() => fromJson(U, '{"i32":2147483648}', p)).toThrow(JsonFormatError);
    expect(() => fromJson(U, '{"i32":1.5}', p)).toThrow(JsonFormatError);
  });

  it('FieldMask acronym paths parse to snake case', () => {
    const p = pool();
    const FM = p.findMessage('google.protobuf.FieldMask')!;
    const m = fromJson(FM, '"HTTPServer.configURL"', p);
    expect(m.get('paths')).toEqual(['http_server.config_url']);
    // Note: camel<->snake conversion of leading acronyms is not perfectly
    // reversible (documented protobuf FieldMask behavior); canonical output
    // is derived from the stored snake form.
    expect(toJson(m)).toBe('"httpServer.configUrl"');

    // typical lowerCamel input round-trips exactly
    expect(toJson(fromJson(FM, '"userDisplayName"', p))).toBe('"userDisplayName"');
  });

  it('duration 0 with zero nanos serializes as 0s, not -0s', () => {
    const p = pool();
    const D = p.findMessage('google.protobuf.Duration')!;
    const m = new DynamicMessage(D);
    m.set('seconds', 0n);
    m.set('nanos', 0);
    expect(toJson(m)).toBe('"0s"');
  });

  it('duration -0.000... string round-trips to canonical 0s', () => {
    const p = pool();
    const D = p.findMessage('google.protobuf.Duration')!;
    const m = fromJson(D, '"-0.0s"', p);
    // -0n is numerically 0n; canonical output has no sign
    expect(m.get('seconds')).toBe(0n);
    expect(m.get('nanos')).toBe(0);
    expect(toJson(m)).toBe('"0s"');
  });

  it('nested FieldMask inside Any in both directions', () => {
    const p = pool();
    const R = p.findMessage('x.Root')!;
    const text =
      '{"fm":"fooBar","any":{"@type":"type.googleapis.com/google.protobuf.FieldMask","value":"aB.cD"}}';
    const m = fromJson(R, text, p);
    const json = toJson(m);
    expect(json).toBe(
      '{"any":{"@type":"type.googleapis.com/google.protobuf.FieldMask","value":"aB.cD"},"fm":"fooBar"}',
    );    const back = fromJson(R, json, p);
    const any = back.get('any') as DynamicMessage;
    expect((any.get('value') as DynamicMessage).get('paths')).toEqual(['a_b.c_d']);
  });

  it('wrapper edge cases: empty bytes wrapper round-trips', () => {
    const p = new DescriptorPool();
    const A = p.findMessage('google.protobuf.Any')!;
    const text = '{"@type":"type.googleapis.com/google.protobuf.BytesValue","value":""}';
    const m = fromJson(A, text, p);
    const inner = m.get('value') as DynamicMessage;
    // empty bytes equals the scalar default (proto3 implicit presence)
    expect(inner.has('value')).toBe(false);
    expect(toJson(m)).toBe(text);
  });

  it('timestamp with explicit +00:00 offset', () => {
    const p = new DescriptorPool();
    const T = p.findMessage('google.protobuf.Timestamp')!;
    const m = fromJson(T, '"2000-02-29T12:34:56+00:00"', p);
    expect(toJson(m)).toBe('"2000-02-29T12:34:56Z"');
  });

  it('timestamp rejects leap day in non-leap year', () => {
    const p = new DescriptorPool();
    const T = p.findMessage('google.protobuf.Timestamp')!;
    expect(() => fromJson(T, '"1900-02-29T00:00:00Z"', p)).toThrow(JsonFormatError);
  });

  it('bool map keys serialize canonically and reject junk keys', () => {
    const p = new DescriptorPool();
    p.addFile({
      name: 'bm.proto',
      package: 'bm',
      syntax: 'proto3',
      messages: [
        {
          kind: 'message',
          name: 'BM',
          fields: [
            { name: 'm', number: 1, type: 'string', mapKey: 'bool', mapValue: 'string' },
          ],
        },
      ],
    });
    const BM = p.findMessage('bm.BM')!;
    const m = fromJson(BM, '{"m":{"true":"a","false":"b"}}', p);
    expect(toJson(m)).toBe('{"m":{"false":"b","true":"a"}}');
    expect(() => fromJson(BM, '{"m":{"maybe":"a"}}', p)).toThrow(JsonFormatError);
  });

  it('64-bit map keys normalize representation', () => {
    const p = new DescriptorPool();
    p.addFile({
      name: 'nm.proto',
      package: 'nm',
      syntax: 'proto3',
      messages: [
        {
          kind: 'message',
          name: 'NM',
          fields: [{ name: 'm', number: 1, type: 'int64', mapKey: 'int64', mapValue: 'string' }],
        },
      ],
    });
    const NM = p.findMessage('nm.NM')!;
    const m = fromJson(NM, '{"m":{"001":"a","0x2":"b"}}', p);
    expect(toJson(m)).toBe('{"m":{"1":"a","2":"b"}}');
  });
});
