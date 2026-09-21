import { expect, it, describe } from 'vitest';
import { decodeVarint } from '../src/index.js';
import {
  DescriptorPool,
  DynamicMessage,
  toJson,
  fromJson,
  JsonFormatError,
  messagesEqual,
  base64Encode,
  type FileProto,
} from '../src/index.js';

it('decodes varint', () =>
  expect(decodeVarint(Uint8Array.from([172, 2]))?.value).toBe(300n));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function proto3File(): FileProto {
  return {
    name: 'p3.proto',
    package: 'p3',
    syntax: 'proto3',
    messages: [
      {
        kind: 'message',
        name: 'Scalars',
        fields: [
          { name: 'd', number: 1, type: 'double' },
          { name: 'f', number: 2, type: 'float' },
          { name: 'i32', number: 3, type: 'int32' },
          { name: 'i64', number: 4, type: 'int64' },
          { name: 'u64', number: 5, type: 'uint64' },
          { name: 's64', number: 6, type: 'sint64' },
          { name: 'f64', number: 7, type: 'fixed64' },
          { name: 'b', number: 8, type: 'bool' },
          { name: 's', number: 9, type: 'string' },
          { name: 'raw', number: 10, type: 'bytes' },
          { name: 'color', number: 11, type: 'Color' },
        ],
      },
      {
        kind: 'message',
        name: 'Presence',
        fields: [
          { name: 'plain', number: 1, type: 'int32' },
          { name: 'opt', number: 2, type: 'int32', proto3Optional: true },
          { name: 'opt_msg', number: 3, type: 'Scalars', proto3Optional: true },
          { name: 'sub', number: 4, type: 'Scalars' },
          { name: 'a', number: 5, type: 'string', oneof: 'pick' },
          { name: 'b', number: 6, type: 'int64', oneof: 'pick' },
          { name: 'c', number: 7, type: 'Color', oneof: 'pick' },
        ],
        oneofs: [{ name: 'pick' }],
      },
      {
        kind: 'message',
        name: 'Containers',
        fields: [
          { name: 'list', number: 1, type: 'int32', label: 'repeated' },
          { name: 'colors', number: 2, type: 'Color', label: 'repeated' },
          { name: 'names', number: 3, type: 'string', mapKey: 'string', mapValue: 'string' },
          { name: 'codes', number: 4, type: 'int64', mapKey: 'int64', mapValue: 'int32' },
          { name: 'flags', number: 5, type: 'bool', mapKey: 'string', mapValue: 'bool' },
        ],
      },
      {
        kind: 'message',
        name: 'Wkt',
        fields: [
          { name: 'ts', number: 1, type: 'google.protobuf.Timestamp' },
          { name: 'dur', number: 2, type: 'google.protobuf.Duration' },
          { name: 'mask', number: 3, type: 'google.protobuf.FieldMask' },
          { name: 'any', number: 4, type: 'google.protobuf.Any' },
          { name: 'wrap', number: 5, type: 'google.protobuf.Int64Value' },
          { name: 'empty', number: 6, type: 'google.protobuf.Empty' },
        ],
      },
      {
        kind: 'message',
        name: 'Outer',
        fields: [{ name: 'inner', number: 1, type: 'Inner' }],
        nested: [
          {
            kind: 'message',
            name: 'Inner',
            fields: [{ name: 'v', number: 1, type: 'int32' }],
          },
        ],
      },
      {
        kind: 'message',
        name: 'Camel',
        fields: [
          { name: 'snake_case_field', number: 1, type: 'string' },
          { name: 'alreadyCamel', number: 2, type: 'int32' },
        ],
      },
    ],
  };
}

// enums live in their own file but the same package, exercising cross-file
// type resolution within a pool.
function colorFile(): FileProto {
  return {
    name: 'p3_enums.proto',
    package: 'p3',
    syntax: 'proto3',
    messages: [
      {
        kind: 'enum',
        name: 'Color',
        values: [
          { name: 'UNKNOWN', number: 0 },
          { name: 'RED', number: 1 },
          { name: 'GREEN', number: 2 },
          // alias of GREEN (allow_alias semantics: both names map to 2)
          { name: 'GREEN_ALIAS', number: 2 },
          { name: 'BLUE', number: 10 },
        ],
      },
    ],
  };
}

function proto2File(): FileProto {
  return {
    name: 'p2.proto',
    package: 'p2',
    syntax: 'proto2',
    messages: [
      {
        kind: 'message',
        name: 'Legacy',
        fields: [
          { name: 'required_s', number: 1, type: 'string', label: 'required' },
          { name: 'with_default', number: 2, type: 'int32', label: 'optional', defaultValue: 7 },
          { name: 'str_default', number: 3, type: 'string', label: 'optional', defaultValue: 'hi' },
          { name: 'enum_default', number: 4, type: 'p3.Color', label: 'optional', defaultValue: 'BLUE' },
          { name: 'explicit_zero', number: 5, type: 'int32', label: 'optional' },
          { name: 'explicit_empty', number: 6, type: 'string', label: 'optional' },
        ],
      },
    ],
  };
}

function buildPool(): DescriptorPool {
  const pool = new DescriptorPool();
  pool.addFile(colorFile());
  pool.addFile(proto3File());
  pool.addFile(proto2File());
  return pool;
}

// ---------------------------------------------------------------------------

describe('64-bit integers as strings', () => {
  const pool = buildPool();
  const D = pool.findMessage('p3.Scalars')!;

  it('serializes signed/unsigned/fixed 64-bit values as decimal strings', () => {
    const m = new DynamicMessage(D);
    m.set('i64', -9223372036854775808n);
    m.set('u64', 18446744073709551615n);
    m.set('s64', -1n);
    m.set('f64', 42n);
    expect(toJson(m)).toBe(
      '{"i64":"-9223372036854775808","u64":"18446744073709551615","s64":"-1","f64":"42"}',
    );
  });

  it('accepts numbers, decimal strings and hex strings when parsing', () => {
    const m = fromJson(D, '{"i64":"-42","u64":"0xff","f64":7}', pool);
    expect(m.get('i64')).toBe(-42n);
    expect(m.get('u64')).toBe(255n);
    expect(m.get('f64')).toBe(7n);
  });

  it('rejects out-of-range values', () => {
    expect(() => fromJson(D, '{"u64":"-1"}', pool)).toThrow(JsonFormatError);
    expect(() => fromJson(D, '{"i64":"9223372036854775808"}', pool)).toThrow(JsonFormatError);
    expect(() => fromJson(D, '{"u64":"18446744073709551616"}', pool)).toThrow(JsonFormatError);
  });

  it('omits unset and default 64-bit fields in proto3', () => {
    expect(toJson(new DynamicMessage(D))).toBe('{}');
    const m = fromJson(D, '{"i64":"0"}', pool);
    expect(m.has('i64')).toBe(false);
    expect(toJson(m)).toBe('{}');
  });
});

describe('bytes base64', () => {
  const pool = buildPool();
  const D = pool.findMessage('p3.Scalars')!;

  it('prints canonical padded standard-alphabet base64', () => {
    const m = new DynamicMessage(D);
    m.set('raw', new Uint8Array([1, 2, 3, 4, 5]));
    expect(toJson(m)).toBe('{"raw":"AQIDBAU="}');
    expect(base64Encode(new Uint8Array())).toBe('');
  });

  it('accepts url-safe and unpadded variants', () => {
    const a = fromJson(D, '{"raw":"AQIDBAU"}', pool).get('raw');
    const b = fromJson(D, '{"raw":"AQID_x8"}', pool).get('raw');
    expect([...(a as Uint8Array)]).toEqual([1, 2, 3, 4, 5]);
    expect([...(b as Uint8Array)]).toEqual([1, 2, 3, 255, 31]);
  });

  it('rejects malformed base64', () => {
    expect(() => fromJson(D, '{"raw":"A!ID"}', pool)).toThrow(JsonFormatError);
    expect(() => fromJson(D, '{"raw":"A==="}', pool)).toThrow(JsonFormatError);
  });
});

describe('enums', () => {
  const pool = buildPool();
  const D = pool.findMessage('p3.Scalars')!;

  it('prints the canonical (first-declared) name for aliases', () => {
    const m = new DynamicMessage(D);
    m.set('color', 2); // GREEN and GREEN_ALIAS share number 2
    expect(toJson(m)).toBe('{"color":"GREEN"}');
    const m2 = fromJson(D, '{"color":"GREEN_ALIAS"}', pool);
    expect(m2.get('color')).toBe(2);
    expect(toJson(m2)).toBe('{"color":"GREEN"}');
  });

  it('prints unknown numeric enum values as numbers and round-trips', () => {
    const m = fromJson(D, '{"color":12345}', pool);
    expect(m.get('color')).toBe(12345);
    expect(toJson(m)).toBe('{"color":12345}');
  });

  it('rejects unknown enum names', () => {
    expect(() => fromJson(D, '{"color":"PURPLE"}', pool)).toThrow(JsonFormatError);
  });
});

describe('default values and explicit presence (proto2/proto3)', () => {
  const pool = buildPool();
  const P = pool.findMessage('p3.Presence')!;
  const L = pool.findMessage('p2.Legacy')!;

  it('proto3 plain scalar set to default is not present', () => {
    const m = fromJson(P, '{"plain":0}', pool);
    expect(m.has('plain')).toBe(false);
    expect(toJson(m)).toBe('{}');
  });

  it('proto3 optional retains explicit zero presence', () => {
    const m = fromJson(P, '{"opt":0}', pool);
    expect(m.has('opt')).toBe(true);
    expect(m.get('opt')).toBe(0);
    expect(toJson(m)).toBe('{"opt":0}');
  });

  it('message fields have presence; null clears', () => {
    const m = new DynamicMessage(P);
    expect(m.has('sub')).toBe(false);
    const sub = fromJson(P, '{"sub":{}}', pool);
    expect(sub.has('sub')).toBe(true);
    const cleared = fromJson(P, '{"sub":null}', pool);
    expect(cleared.has('sub')).toBe(false);
  });

  it('proto2 fields are present by default and emit defaults', () => {
    const m = new DynamicMessage(L);
    expect(m.has('with_default')).toBe(false);
    expect(m.get('with_default')).toBe(7);
    const json = toJson(m, { alwaysPrintPrimitiveFields: true });
    expect(json).toContain('"withDefault":7');
    expect(json).toContain('"strDefault":"hi"');
    expect(json).toContain('"enumDefault":"BLUE"');
  });

  it('proto2 explicit zero/empty are observable', () => {
    const m = fromJson(L, '{"required_s":"","explicit_zero":0,"explicit_empty":""}', pool);
    expect(m.has('explicit_zero')).toBe(true);
    expect(m.has('explicit_empty')).toBe(true);
    const json = toJson(m);
    expect(json).toContain('"explicitZero":0');
    expect(json).toContain('"explicitEmpty":""');
  });

  it('proto2 required validation', () => {
    expect(new DynamicMessage(L).isInitialized()).toBe(false);
    const m = new DynamicMessage(L);
    m.set('required_s', 'x');
    expect(m.isInitialized()).toBe(true);
  });
});

describe('negative zero, NaN and Infinity', () => {
  const pool = buildPool();
  const D = pool.findMessage('p3.Scalars')!;

  it('preserves -0 token for explicit-presence fields', () => {
    // proto3 plain scalar: -0 is numerically the default +0 but preserved
    // as a distinguishable value for IEEE float fields.
    const plain = fromJson(D, '{"d":-0.0}', pool);
    expect(Object.is(plain.get('d'), -0)).toBe(true);
    expect(toJson(plain)).toBe('{"d":-0}');

    // proto2 field and wrapper fields have explicit presence: -0 is kept
    const pool2 = new DescriptorPool();
    pool2.addFile({
      name: 'z.proto',
      package: 'z',
      syntax: 'proto2',
      messages: [
        {
          kind: 'message',
          name: 'Z',
          fields: [{ name: 'x', number: 1, type: 'double', label: 'optional' }],
        },
      ],
    });
    const Z = pool2.findMessage('z.Z')!;
    const zm = fromJson(Z, '{"x":-0.0}', pool2);
    expect(zm.has('x')).toBe(true);
    expect(Object.is(zm.get('x'), -0)).toBe(true);
    expect(toJson(zm)).toBe('{"x":-0}');

    const W = pool.findMessage('google.protobuf.DoubleValue')!;
    const wm = fromJson(W, '-0', pool);
    expect(Object.is(wm.get('value'), -0)).toBe(true);
    expect(toJson(wm)).toBe('-0');
  });

  it('parses string forms and emits quoted canonical forms', () => {
    const m = fromJson(D, '{"d":"NaN","f":"Infinity"}', pool);
    expect(Number.isNaN(m.get('d'))).toBe(true);
    expect(m.get('f')).toBe(Infinity);
    expect(toJson(m)).toBe('{"d":"NaN","f":"Infinity"}');
    const m2 = fromJson(D, '{"f":"-Infinity"}', pool);
    expect(toJson(m2)).toBe('{"f":"-Infinity"}');
  });

  it('rejects junk floats', () => {
    expect(() => fromJson(D, '{"d":"nope"}', pool)).toThrow(JsonFormatError);
  });
});

describe('oneof', () => {
  const pool = buildPool();
  const P = pool.findMessage('p3.Presence')!;

  it('round-trips the selected case and keeps presence observable', () => {
    const m = fromJson(P, '{"b":"42"}', pool);
    expect(m.oneofCase('pick')?.name).toBe('b');
    expect(m.has('a')).toBe(false);
    const back = fromJson(P, toJson(m), pool);
    expect(back.oneofCase('pick')?.name).toBe('b');
  });

  it('rejects two members in one object', () => {
    expect(() => fromJson(P, '{"a":"x","b":"1"}', pool)).toThrow(/oneof/);
  });

  it('setting a new case clears the previous one', () => {
    const m = new DynamicMessage(P);
    m.set('a', 'x');
    m.set('c', 10);
    expect(m.oneofCase('pick')?.name).toBe('c');
    expect(m.has('a')).toBe(false);
  });
});

describe('snake_case / camelCase dual names', () => {
  const pool = buildPool();
  const C = pool.findMessage('p3.Camel')!;

  it('serializes camelCase JSON names', () => {
    const m = fromJson(C, '{"snake_case_field":"v","alreadyCamel":3}', pool);
    expect(toJson(m)).toBe('{"snakeCaseField":"v","alreadyCamel":3}');
  });

  it('accepts both names and rejects aliases in the same object', () => {
    const m = fromJson(C, '{"snakeCaseField":"v"}', pool);
    expect(m.get('snake_case_field')).toBe('v');
    expect(() => fromJson(C, '{"snakeCaseField":"v","snake_case_field":"w"}', pool)).toThrow(
      /conflicting aliases/,
    );
  });

  it('rejects literal duplicate JSON keys', () => {
    expect(() => fromJson(C, '{"snakeCaseField":"v","snakeCaseField":"w"}', pool)).toThrow(
      /duplicate JSON key/,
    );
  });
});

describe('unknown JSON fields: strict vs ignore', () => {
  const pool = buildPool();
  const C = pool.findMessage('p3.Camel')!;

  it('strict (default) rejects', () => {
    expect(() => fromJson(C, '{"mystery":1}', pool)).toThrow(/unknown field/);
  });

  it('ignore skips', () => {
    const m = fromJson(C, '{"mystery":1,"alreadyCamel":2}', pool, { unknownFields: 'ignore' });
    expect(m.get('alreadyCamel')).toBe(2);
    expect(toJson(m)).toBe('{"alreadyCamel":2}');
  });
});

describe('repeated / map containers', () => {
  const pool = buildPool();
  const D = pool.findMessage('p3.Containers')!;

  it('repeated order and empty handling', () => {
    const m = fromJson(D, '{"list":[1,2,3],"colors":["RED",10]}', pool);
    expect(m.get('list')).toEqual([1, 2, 3]);
    expect(toJson(m)).toBe('{"list":[1,2,3],"colors":["RED","BLUE"]}');
    expect(() => fromJson(D, '{"list":[1,null]}', pool)).toThrow(JsonFormatError);
  });

  it('maps sort keys canonically', () => {
    const m = fromJson(
      D,
      '{"names":{"b":"2","a":"1"},"codes":{"10":1,"2":2,"100":3}}',
      pool,
    );
    const json = toJson(m);
    // string keys lexical, int keys numeric
    expect(json.indexOf('"a"')).toBeLessThan(json.indexOf('"b"'));
    expect(json).toContain('"codes":{"2":2,"10":1,"100":3}');
  });

  it('map values 64-bit etc; duplicate object keys rejected', () => {
    expect(() => fromJson(D, '{"names":{"a":"1","a":"2"}}', pool)).toThrow(/duplicate JSON key/);
  });
});

describe('Timestamp', () => {
  const pool = buildPool();
  const T = pool.findMessage('google.protobuf.Timestamp')!;

  it('canonical UTC formatting', () => {
    let m = fromJson(T, '"2017-01-15T01:30:15.000000300Z"', pool);
    expect(toJson(m)).toBe('"2017-01-15T01:30:15.0000003Z"');

    m = fromJson(T, '"1970-01-01T00:00:00Z"', pool);
    expect(toJson(m)).toBe('"1970-01-01T00:00:00Z"');

    m = fromJson(T, '"1970-01-01T00:00:00.5Z"', pool);
    expect(m.get('nanos')).toBe(500000000);
  });

  it('accepts offsets and lower-case t/z', () => {
    const m = fromJson(T, '"1970-01-01t01:00:00+01:00"', pool);
    expect(m.get('seconds')).toBe(0n);
  });

  it('normalizes negative nanos via borrow', () => {
    const m = new DynamicMessage(T);
    m.set('seconds', -1n);
    m.set('nanos', -500000000);
    // -1.5s canonicalizes to seconds=-2, nanos=+500ms
    expect(toJson(m)).toBe('"1969-12-31T23:59:58.5Z"');

    const m2 = new DynamicMessage(T);
    m2.set('seconds', 0n);
    m2.set('nanos', -1);
    // 0s - 1ns -> -1s + 999999999ns
    expect(toJson(m2)).toBe('"1969-12-31T23:59:59.999999999Z"');
  });

  it('rejects out-of-range and malformed timestamps', () => {
    expect(() => fromJson(T, '"0000-01-01T00:00:00Z"', pool)).toThrow(JsonFormatError);
    expect(() => fromJson(T, '"10000-01-01T00:00:00Z"', pool)).toThrow(JsonFormatError);
    expect(() => fromJson(T, '"2020-13-01T00:00:00Z"', pool)).toThrow(JsonFormatError);
    expect(() => fromJson(T, '"2020-02-30T00:00:00Z"', pool)).toThrow(JsonFormatError);
  });
});

describe('Duration', () => {
  const pool = buildPool();
  const U = pool.findMessage('google.protobuf.Duration')!;

  it('canonical forms', () => {
    expect(toJson(fromJson(U, '"0s"', pool))).toBe('"0s"');
    expect(toJson(fromJson(U, '"1.5s"', pool))).toBe('"1.5s"');
    expect(toJson(fromJson(U, '"1.000000001s"', pool))).toBe('"1.000000001s"');
    expect(toJson(fromJson(U, '"-1.25s"', pool))).toBe('"-1.25s"');
  });

  it('canonicalizes opposite-sign components', () => {
    const m = new DynamicMessage(U);
    m.set('seconds', 0n);
    m.set('nanos', -1);
    // 0s with -1ns canonicalizes to -0.000000001s
    expect(toJson(m)).toBe('"-0.000000001s"');
  });

  it('rejects out-of-range durations', () => {
    expect(() => fromJson(U, '"315576000002s"', pool)).toThrow(JsonFormatError);
    expect(() => fromJson(U, '"315576000001.1s"', pool)).toThrow(JsonFormatError);
    expect(() => fromJson(U, '"1.xs"', pool)).toThrow(JsonFormatError);
  });
});

describe('FieldMask', () => {
  const pool = buildPool();
  const M = pool.findMessage('google.protobuf.FieldMask')!;

  it('empty mask serializes as empty string', () => {
    expect(toJson(new DynamicMessage(M))).toBe('""');
    const back = fromJson(M, '""', pool);
    expect(back.get('paths')).toEqual([]);
  });

  it('converts snake_case paths to lowerCamel and back', () => {
    const m = fromJson(M, '"userDisplayName,foo.barBaz"', pool);
    expect(m.get('paths')).toEqual(['user_display_name', 'foo.bar_baz']);
    expect(toJson(m)).toBe('"userDisplayName,foo.barBaz"');
  });
});

describe('Any', () => {
  const pool = buildPool();
  const W = pool.findMessage('p3.Wkt')!;
  const S = pool.findMessage('p3.Scalars')!;

  it('general form flattens fields with @type first', () => {
    const m = fromJson(
      W,
      '{"any":{"@type":"type.googleapis.com/p3.Scalars","i64":"5","s":"x"}}',
      pool,
    );
    const any = m.get('any') as DynamicMessage;
    expect(any.get('type_url')).toBe('type.googleapis.com/p3.Scalars');
    const inner = any.get('value') as DynamicMessage;
    expect(inner.get('i64')).toBe(5n);
    expect(toJson(m)).toBe(
      '{"any":{"@type":"type.googleapis.com/p3.Scalars","i64":"5","s":"x"}}',
    );
  });

  it('scalar form for Timestamp/Duration/FieldMask and wrappers', () => {
    const m = fromJson(
      W,
      '{"any":{"@type":"type.googleapis.com/google.protobuf.Int64Value","value":"42"}}',
      pool,
    );
    expect(toJson(m)).toBe(
      '{"any":{"@type":"type.googleapis.com/google.protobuf.Int64Value","value":"42"}}',
    );

    const t = fromJson(
      W,
      '{"any":{"@type":"type.googleapis.com/google.protobuf.Timestamp","value":"1970-01-01T00:00:00Z"}}',
      pool,
    );
    expect(toJson(t)).toBe(
      '{"any":{"@type":"type.googleapis.com/google.protobuf.Timestamp","value":"1970-01-01T00:00:00Z"}}',
    );
  });

  it('empty Any is {}', () => {
    const m = fromJson(W, '{"any":{}}', pool);
    expect(toJson(m)).toBe('{"any":{}}');
  });

  it('unknown type URL fails; ignored in ignore mode? (always fails)', () => {
    expect(() =>
      fromJson(W, '{"any":{"@type":"type.googleapis.com/p3.Nope"}}', pool),
    ).toThrow(/no message type/);
  });

  it('missing @type with fields errors', () => {
    expect(() => fromJson(W, '{"any":{"i64":"1"}}', pool)).toThrow(JsonFormatError);
  });

  it('recursive Any: Any packed inside Any resolves via the pool', () => {
    const A = pool.findMessage('google.protobuf.Any')!;
    const leaf = new DynamicMessage(S);
    leaf.set('s', 'deep');
    const innerAny = new DynamicMessage(A);
    innerAny.set('type_url', 'type.googleapis.com/p3.Scalars');
    innerAny.set('value', leaf);
    const outerAny = new DynamicMessage(A);
    outerAny.set('type_url', 'type.googleapis.com/google.protobuf.Any');
    outerAny.set('value', innerAny);
    const wkt = new DynamicMessage(W);
    wkt.set('any', outerAny);

    const json = toJson(wkt);
    expect(json).toBe(
      '{"any":{"@type":"type.googleapis.com/google.protobuf.Any",' +
        '"value":{"@type":"type.googleapis.com/p3.Scalars","s":"deep"}}}',
    );
    const back = fromJson(W, json, pool);
    expect(messagesEqual(back.get('any'), wkt.get('any'))).toBe(true);
  });

  it('accepts alternate URL prefixes', () => {
    const m = fromJson(
      W,
      '{"any":{"@type":"foo.example.com/p3.Scalars","s":"z"}}',
      pool,
    );
    const any = m.get('any') as DynamicMessage;
    expect(any.get('type_url')).toBe('foo.example.com/p3.Scalars');
  });
});

describe('JSON round-trip preserves presence and oneof selection', () => {
  const pool = buildPool();
  const P = pool.findMessage('p3.Presence')!;
  const O = pool.findMessage('p3.Outer')!;
  const W = pool.findMessage('p3.Wkt')!;

  it('presence matrix', () => {
    const text =
      '{"opt":0,"opt_msg":{},"sub":{"i64":"0"},"b":"9"}';
    const m = fromJson(P, text, pool);
    expect([m.has('plain'), m.has('opt'), m.has('opt_msg'), m.has('sub')]).toEqual([
      false, true, true, true,
    ]);
    expect(m.oneofCase('pick')?.name).toBe('b');
    const again = fromJson(P, toJson(m), pool);
    expect(messagesEqual(m, again)).toBe(true);
    expect(again.oneofCase('pick')?.name).toBe('b');
  });

  it('nested empty message stays present', () => {
    const m = fromJson(O, '{"inner":{"v":0}}', pool);
    expect(m.has('inner')).toBe(true);
    expect((m.get('inner') as DynamicMessage).has('v')).toBe(false);
    const back = fromJson(O, toJson(m), pool);
    expect(messagesEqual(m, back)).toBe(true);
    expect(toJson(m)).toBe('{"inner":{}}');
  });

  it('full mixed fixture round trip', () => {
    const text =
      '{"ts":"2021-06-15T12:00:00.25Z","dur":"-2s","mask":"aB.cD",' +
      '"wrap":"100","empty":{},"any":{"@type":"type.googleapis.com/p3.Scalars","color":"RED"}}';
    const m = fromJson(W, text, pool);
    const back = fromJson(W, toJson(m), pool);
    expect(messagesEqual(m, back)).toBe(true);
    expect(toJson(back)).toBe(
      '{"ts":"2021-06-15T12:00:00.25Z","dur":"-2s","mask":"aB.cD",' +
        '"any":{"@type":"type.googleapis.com/p3.Scalars","color":"RED"},' +
        '"wrap":"100","empty":{}}',
    );
  });
});
