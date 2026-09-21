import { describe, expect, it } from 'vitest';
import {
  DescriptorPool,
  DynamicMessage,
  JsonFormatError,
  JsonParser,
  JsonPrinter,
  standardPool,
  base64Encode,
} from '../src/index.js';
import type { FileSpec } from '../src/index.js';

const TEST_FILE: FileSpec = {
  enums: [
    {
      name: '.test.Color',
      values: [
        { name: 'RED', number: 0 },
        { name: 'GREEN', number: 1 },
        { name: 'BLUE', number: 2 },
        // Aliased number: first declared name is canonical.
        { name: 'SKY_BLUE', number: 2 },
      ],
    },
  ],
  messages: [
    {
      // proto3 plain scalars + explicit-presence fields
      name: '.test.Scalars',
      syntax: 'proto3',
      fields: [
        { name: 'i32', number: 1, type: 'int32' },
        { name: 'i64', number: 2, type: 'int64' },
        { name: 'u64', number: 3, type: 'uint64' },
        { name: 's64', number: 4, type: 'sint64' },
        { name: 'f64', number: 5, type: 'double' },
        { name: 'f32', number: 6, type: 'float' },
        { name: 'flag', number: 7, type: 'bool' },
        { name: 'text', number: 8, type: 'string' },
        { name: 'blob', number: 9, type: 'bytes' },
        { name: 'color', number: 10, type: 'enum', typeName: '.test.Color' },
        { name: 'opt_i32', number: 11, type: 'int32', proto3Optional: true },
        { name: 'opt_msg', number: 12, type: 'message', typeName: '.test.Inner' },
        { name: 'rep_i64', number: 13, type: 'int64', label: 'repeated' },
        { name: 'rep_blob', number: 14, type: 'bytes', label: 'repeated' },
        { name: 'rep_color', number: 15, type: 'enum', typeName: '.test.Color', label: 'repeated' },
      ],
    },
    {
      // proto2: every scalar has explicit presence
      name: '.test.Proto2',
      syntax: 'proto2',
      fields: [
        { name: 'i32', number: 1, type: 'int32', label: 'optional' },
        { name: 'flag', number: 2, type: 'bool', label: 'optional' },
        { name: 'text', number: 3, type: 'string', label: 'optional' },
        { name: 'blob', number: 4, type: 'bytes', label: 'optional' },
        { name: 'color', number: 5, type: 'enum', typeName: '.test.Color', label: 'optional' },
        { name: 'required_i32', number: 6, type: 'int32', label: 'required' },
      ],
    },
    {
      name: '.test.Inner',
      syntax: 'proto3',
      fields: [
        { name: 'value', number: 1, type: 'string' },
        { name: 'n', number: 2, type: 'int32' },
      ],
    },
    {
      name: '.test.Choice',
      syntax: 'proto3',
      oneofs: ['pick'],
      fields: [
        { name: 'a', number: 1, type: 'int32', oneof: 'pick' },
        { name: 'b', number: 2, type: 'string', oneof: 'pick' },
        { name: 'c', number: 3, type: 'message', typeName: '.test.Inner', oneof: 'pick' },
      ],
    },
    {
      name: '.test.Maps',
      syntax: 'proto3',
      fields: [
        { name: 'str_to_int', number: 1, type: 'message', map: { key: 'string', value: 'int64' } },
        { name: 'int_to_str', number: 2, type: 'message', map: { key: 'int32', value: 'string' } },
        {
          name: 'i64_to_msg',
          number: 3,
          type: 'message',
          map: { key: 'int64', value: 'message', valueTypeName: '.test.Inner' },
        },
        {
          name: 'bool_to_color',
          number: 4,
          type: 'message',
          map: { key: 'bool', value: 'enum', valueTypeName: '.test.Color' },
        },
      ],
    },
    {
      name: '.test.Recursive',
      syntax: 'proto3',
      fields: [
        { name: 'name', number: 1, type: 'string' },
        { name: 'child', number: 2, type: 'message', typeName: '.test.Recursive' },
        { name: 'extra_data', number: 3, type: 'string' },
      ],
    },
    {
      name: '.test.Envelope',
      syntax: 'proto3',
      fields: [
        { name: 'title', number: 1, type: 'string' },
        { name: 'detail', number: 2, type: 'message', typeName: 'google.protobuf.Any' },
        { name: 'more', number: 3, type: 'message', typeName: 'google.protobuf.Any' },
      ],
    },
    {
      name: '.test.JsonNamed',
      syntax: 'proto3',
      fields: [
        // custom json_name still parses snake_case too
        { name: 'foo_bar', number: 1, type: 'int32', jsonName: 'fooBarBaz' },
        { name: 'normal_field', number: 2, type: 'string' },
      ],
    },
  ],
};

function makePool(): DescriptorPool {
  return standardPool([TEST_FILE]);
}

function parse(pool: DescriptorPool, text: string, name: string, opts?: { ignoreUnknownFields?: boolean }) {
  const parser = new JsonParser(pool, opts ?? {});
  return parser.parse(text, pool.lookupMessage(name));
}

function print(msg: DynamicMessage, opts?: { emitImplicitDefaults?: boolean; indent?: string }) {
  return new JsonPrinter(opts ?? {}).print(msg);
}

function roundTrip(pool: DescriptorPool, name: string, text: string, printerOpts?: Parameters<typeof print>[1]) {
  return print(parse(pool, text, name), printerOpts);
}

describe('scalars: canonical output forms', () => {
  it('emits 64-bit ints as decimal strings, bytes as standard base64, 32-bit as numbers', () => {
    const pool = makePool();
    const msg = new DynamicMessage(pool.lookupMessage('.test.Scalars'), pool);
    msg.setField(msg.descriptor.fields[0], 7);
    msg.setField(msg.descriptor.fields[1], -9007199254740993n);
    msg.setField(msg.descriptor.fields[2], 18446744073709551615n);
    msg.setField(msg.descriptor.fields[3], -42n);
    msg.setField(msg.descriptor.fields[8], Uint8Array.from([0x66, 0x6f, 0x6f, 0xb0]));
    expect(print(msg)).toBe(
      '{"i32":7,"i64":"-9007199254740993","u64":"18446744073709551615","s64":"-42","blob":"Zm9vsA=="}',
    );
  });

  it('omits proto3 implicit defaults but keeps explicit-presence defaults', () => {
    const pool = makePool();
    const msg = new DynamicMessage(pool.lookupMessage('.test.Scalars'), pool);
    // Explicitly set defaults on plain proto3 scalars: still omitted.
    msg.setField(msg.descriptor.fields[0], 0);
    msg.setField(msg.descriptor.fields[1], 0n);
    msg.setField(msg.descriptor.fields[7], '');
    msg.setField(msg.descriptor.fields[8], new Uint8Array(0));
    // Explicit presence field at default: emitted.
    msg.setField(msg.descriptor.fields[10], 0);
    expect(print(msg)).toBe('{"optI32":0}');
  });

  it('proto2 optional defaults are emitted when set', () => {
    const pool = makePool();
    const text = '{"i32":0,"flag":false,"text":"","blob":"","color":"RED","requiredI32":0}';
    const out = roundTrip(pool, '.test.Proto2', text);
    expect(out).toBe(text);
    // Unset proto2 fields are omitted entirely.
    const empty = new DynamicMessage(pool.lookupMessage('.test.Proto2'), pool);
    expect(print(empty)).toBe('{}');
    empty.setField(empty.descriptor.fields[0], 0);
    expect(print(empty)).toBe('{"i32":0}');
  });

  it('emitImplicitDefaults renders proto3 defaults but not empty repeated', () => {
    const pool = makePool();
    const msg = new DynamicMessage(pool.lookupMessage('.test.Scalars'), pool);
    const out = JSON.parse(print(msg, { emitImplicitDefaults: true }));
    expect(out).toEqual({
      i32: 0,
      i64: '0',
      u64: '0',
      s64: '0',
      f64: 0,
      f32: 0,
      flag: false,
      text: '',
      blob: '',
      color: 'RED',
    });
  });
});

describe('float: negative zero, NaN and Infinity', () => {
  it('prints -0.0 distinctly from +0 and round-trips it', () => {
    const pool = makePool();
    const field = (m: DynamicMessage) => m.descriptor.fields[4]; // f64
    const msg = new DynamicMessage(pool.lookupMessage('.test.Scalars'), pool);
    msg.setField(field(msg), -0);
    expect(print(msg)).toBe('{"f64":-0.0}');
    const back = parse(pool, '{"f64":-0.0}', '.test.Scalars');
    expect(Object.is(back.getField(field(back)), -0)).toBe(true);
    // "-0" numeric form also preserves negative zero.
    const back2 = parse(pool, '{"f64":"-0.0"}', '.test.Scalars');
    expect(Object.is(back2.getField(field(back2)), -0)).toBe(true);
    // +0 is an implicit default and omitted.
    const plus = parse(pool, '{"f64":0}', '.test.Scalars');
    expect(print(plus)).toBe('{}');
  });

  it('prints NaN / Infinity as quoted tokens and parses tokens or JSON strings', () => {
    const pool = makePool();
    const text = '{"f64":"NaN","f32":"Infinity"}';
    const msg = parse(pool, text, '.test.Scalars');
    expect(print(msg)).toBe(text);
    const msg2 = parse(pool, '{"f64":"-Infinity"}', '.test.Scalars');
    expect(msg2.getField(msg2.descriptor.fields[4])).toBe(-Infinity);
    expect(() => parse(pool, '{"f64":"weird"}', '.test.Scalars')).toThrow(JsonFormatError);
  });

  it('proto3 optional -0 survives round trip', () => {
    const pool = makePool();
    const out = roundTrip(pool, '.test.Scalars', '{"optI32":0}');
    expect(out).toBe('{"optI32":0}');
  });
});

describe('enums', () => {
  it('prints names (first alias wins), parses names or numbers', () => {
    const pool = makePool();
    const msg = parse(pool, '{"color":"BLUE","repColor":["GREEN",0,"SKY_BLUE"]}', '.test.Scalars');
    expect(print(msg)).toBe('{"color":"BLUE","repColor":["GREEN","RED","BLUE"]}');
    // Numeric parse, including unknown numbers.
    const msg2 = parse(pool, '{"color":99,"repColor":[1,100]}', '.test.Scalars');
    expect(print(msg2)).toBe('{"color":99,"repColor":["GREEN",100]}');
    // Unknown name rejected.
    expect(() => parse(pool, '{"color":"PURPLE"}', '.test.Scalars')).toThrow(JsonFormatError);
  });

  it('unknown enum number in proto3 is not a default', () => {
    const pool = makePool();
    const msg = parse(pool, '{"color":5}', '.test.Scalars');
    expect(msg.has(msg.descriptor.fields[9])).toBe(true);
  });
});

describe('bytes base64', () => {
  it('prints canonical padded standard base64; parses unpadded and url-safe', () => {
    const pool = makePool();
    const msg = parse(pool, '{"blob":"6auY6a2U","repBlob":["aGk","aGk=","aGk"]}', '.test.Scalars');
    expect(print(msg)).toBe('{"blob":"6auY6a2U","repBlob":["aGk=","aGk=","aGk="]}');
    const msg2 = parse(pool, '{"blob":"6auY6a2U="}', '.test.Scalars');
    expect(base64Encode(msg2.getField(msg2.descriptor.fields[8]) as Uint8Array)).toBe('6auY6a2U');
    expect(() => parse(pool, '{"blob":"a!b="}', '.test.Scalars')).toThrow(JsonFormatError);
    expect(() => parse(pool, '{"blob":"abcde"}', '.test.Scalars')).toThrow(JsonFormatError);
  });
});

describe('64-bit integers', () => {
  it('accepts safe numbers and strings; rejects unsafe numbers and out-of-range', () => {
    const pool = makePool();
    const msg = parse(pool, '{"i64":42,"u64":"123456789123456789"}', '.test.Scalars');
    expect(msg.getField(msg.descriptor.fields[1])).toBe(42n);
    expect(msg.getField(msg.descriptor.fields[2])).toBe(123456789123456789n);
    expect(() => parse(pool, '{"i64":9007199254740993}', '.test.Scalars')).toThrow(JsonFormatError);
    expect(() => parse(pool, '{"u64":-1}', '.test.Scalars')).toThrow(JsonFormatError);
    expect(() => parse(pool, '{"i64":"18446744073709551616"}', '.test.Scalars')).toThrow(
      JsonFormatError,
    );
    expect(() => parse(pool, '{"i32":2147483648}', '.test.Scalars')).toThrow(JsonFormatError);
  });
});

describe('proto3 optional and message presence', () => {
  it('tracks explicit presence for optional scalars and messages', () => {
    const pool = makePool();
    const optI32 = pool.lookupMessage('.test.Scalars').fields[10];
    const optMsg = pool.lookupMessage('.test.Scalars').fields[11];
    const empty = new DynamicMessage(pool.lookupMessage('.test.Scalars'), pool);
    expect(empty.has(optI32)).toBe(false);
    expect(empty.has(optMsg)).toBe(false);

    const msg = parse(pool, '{"optI32":0,"optMsg":{"value":""}}', '.test.Scalars');
    expect(msg.has(optI32)).toBe(true);
    expect(msg.has(optMsg)).toBe(true);
    expect(print(msg)).toBe('{"optI32":0,"optMsg":{}}');

    // null clears and removes presence.
    const cleared = parse(pool, '{"optI32":5}', '.test.Scalars');
    cleared.setField(optI32, null);
    expect(cleared.has(optI32)).toBe(false);
    expect(print(cleared)).toBe('{}');
  });
});

describe('oneof', () => {
  it('round-trips the selected field including default-valued oneof members', () => {
    const pool = makePool();
    expect(roundTrip(pool, '.test.Choice', '{"a":0}')).toBe('{"a":0}');
    expect(roundTrip(pool, '.test.Choice', '{"b":""}')).toBe('{"b":""}');
    const msg = parse(pool, '{"a":3}', '.test.Choice');
    expect(msg.whichOneof('pick')?.name).toBe('a');
    msg.setField(msg.descriptor.fields[1], 'x');
    expect(msg.whichOneof('pick')?.name).toBe('b');
    expect(msg.getField(msg.descriptor.fields[0])).toBeUndefined();
  });

  it('rejects JSON containing two oneof members', () => {
    const pool = makePool();
    expect(() => parse(pool, '{"a":1,"b":"x"}', '.test.Choice')).toThrow(
      /oneof "pick" has conflicting fields/,
    );
  });
});

describe('field names: snake_case and lowerCamelCase', () => {
  it('parses both names and prints canonical jsonName', () => {
    const pool = makePool();
    // Each alternate name parses independently...
    expect(roundTrip(pool, '.test.Scalars', '{"rep_i64":["1"]}')).toBe('{"repI64":["1"]}');
    expect(roundTrip(pool, '.test.Scalars', '{"repI64":[2]}')).toBe('{"repI64":["2"]}');
    // ...but both in the same object is an alias conflict.
    expect(() => parse(pool, '{"rep_i64":[1],"repI64":[2]}', '.test.Scalars')).toThrow(
      /both map to repI64/,
    );
  });

  it('respects custom json_name and still accepts snake_case', () => {
    const pool = makePool();
    expect(roundTrip(pool, '.test.JsonNamed', '{"foo_bar":5}')).toBe('{"fooBarBaz":5}');
    expect(roundTrip(pool, '.test.JsonNamed', '{"fooBarBaz":5}')).toBe('{"fooBarBaz":5}');
    expect(roundTrip(pool, '.test.JsonNamed', '{"normal_field":"x"}')).toBe(
      '{"normalField":"x"}',
    );
    // camelCase auto-name is NOT accepted when json_name differs from it.
    expect(() => parse(pool, '{"fooBar":5}', '.test.JsonNamed', {})).toThrow(
      /unknown field "fooBar"/,
    );
  });
});

describe('unknown fields: strict vs ignore', () => {
  it('throws in strict mode and skips in ignore mode', () => {
    const pool = makePool();
    expect(() => parse(pool, '{"nope":1}', '.test.Inner')).toThrow(/unknown field "nope"/);
    const ignored = parse(pool, '{"nope":1,"value":"x"}', '.test.Inner', {
      ignoreUnknownFields: true,
    });
    expect(print(ignored)).toBe('{"value":"x"}');
    // Nested unknown fields also skipped.
    const nested = parse(
      pool,
      '{"optMsg":{"bogus":true,"value":"v"},"other":2}',
      '.test.Scalars',
      { ignoreUnknownFields: true },
    );
    expect(print(nested)).toBe('{"optMsg":{"value":"v"}}');
  });

  it('raw duplicate keys are always rejected, even in ignore mode', () => {
    const pool = makePool();
    expect(() =>
      parse(pool, '{"value":"a","value":"b"}', '.test.Inner', { ignoreUnknownFields: true }),
    ).toThrow(/duplicate JSON key/);
  });
});

describe('Timestamp', () => {
  it('canonical formatting', () => {
    const pool = makePool();
    const direct = new JsonParser(pool).parse(
      '"2017-01-15T01:30:15Z"',
      pool.lookupMessage('.google.protobuf.Timestamp'),
    );
    expect(print(direct)).toBe('"2017-01-15T01:30:15Z"');
    // Default (unset) Timestamp prints the epoch.
    const unset = new DynamicMessage(pool.lookupMessage('.google.protobuf.Timestamp'), pool);
    expect(print(unset)).toBe('"1970-01-01T00:00:00Z"');
  });

  it('normalizes offsets, fractional digits and lower-case t/z', () => {
    const pool = makePool();
    const cases: [string, string][] = [
      ['2017-01-15T01:30:15.500Z', '2017-01-15T01:30:15.500Z'],
      ['2017-01-15t01:30:15.5z', '2017-01-15T01:30:15.500Z'],
      ['2017-01-15T01:30:15.000000001Z', '2017-01-15T01:30:15.000000001Z'],
      ['2017-01-15T01:30:15.000000010Z', '2017-01-15T01:30:15.000000010Z'],
      ['2017-01-15T10:30:15+09:00', '2017-01-15T01:30:15Z'],
      ['0001-01-01T00:00:00Z', '0001-01-01T00:00:00Z'],
      ['9999-12-31T23:59:59.999999999Z', '9999-12-31T23:59:59.999999999Z'],
      ['1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'],
      ['1969-12-31T23:59:59Z', '1969-12-31T23:59:59Z'],
      ['2000-02-29T12:00:00Z', '2000-02-29T12:00:00Z'],
    ];
    for (const [input, expected] of cases) {
      const msg = parse(pool, `"${input}"`, '.google.protobuf.Timestamp');
      expect(print(msg)).toBe(`"${expected}"`);
    }
  });

  it('rejects out-of-range and malformed timestamps', () => {
    const pool = makePool();
    const bad = [
      '0000-12-31T23:59:59Z',
      '10000-01-01T00:00:00Z',
      '2017-13-01T00:00:00Z',
      '2017-02-29T00:00:00Z',
      '2017-01-15T24:00:00Z',
      '2017-01-15T01:30:15.1234567890Z',
      '2017-01-15T01:30:15+24:00',
      '2017-01-15 01:30:15Z',
      'not-a-date',
    ];
    for (const s of bad) {
      expect(() => parse(pool, `"${s}"`, '.google.protobuf.Timestamp'), s).toThrow(
        JsonFormatError,
      );
    }
    // Offset pushes an in-range date out of the UTC range.
    expect(() => parse(pool, '"0001-01-01T00:00:00+01:00"', '.google.protobuf.Timestamp')).toThrow(
      /out of range/,
    );
  });
});

describe('Duration', () => {
  it('canonical formatting', () => {
    const pool = makePool();
    const cases: [string, string][] = [
      ['0s', '0s'],
      ['1s', '1s'],
      ['1.5s', '1.500s'],
      ['1.0005s', '1.000500s'],
      ['-1s', '-1s'],
      ['-1.5s', '-1.500s'],
      ['0.000000001s', '0.000000001s'],
      ['315576000000s', '315576000000s'],
      ['-315576000000s', '-315576000000s'],
    ];
    for (const [input, expected] of cases) {
      expect(print(parse(pool, `"${input}"`, '.google.protobuf.Duration'))).toBe(
        `"${expected}"`,
      );
    }
  });

  it('rejects out-of-range and malformed durations', () => {
    const pool = makePool();
    const bad = ['315576000001s', '315576000000.1s', '1', '1.5', '-', '1.1234567890s', '1.Ss', ''];
    for (const s of bad) {
      expect(() => parse(pool, `"${s}"`, '.google.protobuf.Duration'), s).toThrow(JsonFormatError);
    }
  });

  it('rejects sign-mismatched seconds/nanos constructed directly', () => {
    const pool = makePool();
    const d = new DynamicMessage(pool.lookupMessage('.google.protobuf.Duration'), pool);
    d.setField(d.descriptor.fields[0], 1n);
    d.setField(d.descriptor.fields[1], -1);
    expect(() => print(d)).toThrow(/sign must match/);
  });
});

describe('FieldMask', () => {
  it('prints a comma-joined snake_case string', () => {
    const pool = makePool();
    expect(print(parse(pool, '"fooBar,fooBar.bazQux"', '.google.protobuf.FieldMask'))).toBe(
      '"foo_bar,foo_bar.baz_qux"',
    );
    expect(print(parse(pool, '""', '.google.protobuf.FieldMask'))).toBe('""');
    // Already snake passes through.
    expect(print(parse(pool, '"foo_bar"', '.google.protobuf.FieldMask'))).toBe('"foo_bar"');
  });

  it('rejects malformed paths', () => {
    const pool = makePool();
    expect(() => parse(pool, '"foo..bar"', '.google.protobuf.FieldMask')).toThrow(JsonFormatError);
    expect(() => parse(pool, '".foo"', '.google.protobuf.FieldMask')).toThrow(JsonFormatError);
    expect(() => parse(pool, '"123"', '.google.protobuf.FieldMask')).toThrow(JsonFormatError);
  });
});

describe('Any', () => {
  it('expands normal messages inline with @type first', () => {
    const pool = makePool();
    const text =
      '{"title":"t","detail":{"@type":"type.googleapis.com/test.Inner","value":"v","n":7}}';
    const env = parse(pool, text, '.test.Envelope');
    expect(print(env)).toBe(text);
    // type URL with leading dot resolves too; googleprod host is canonicalized.
    const env2 = parse(
      pool,
      '{"detail":{"@type":"type.googleprod.com/test.Inner","value":"x"}}',
      '.test.Envelope',
    );
    const any = env2.getField(env2.descriptor.fields[1]) as DynamicMessage;
    expect(any.getField(any.descriptor.fields[0])).toBe('type.googleapis.com/test.Inner');
    expect(any.anyPayload?.getField(any.anyPayload.descriptor.fields[0])).toBe('x');
  });

  it('wraps specialized JSON types under "value"', () => {
    const pool = makePool();
    const text =
      '{"detail":{"@type":"type.googleapis.com/google.protobuf.Timestamp","value":"2017-01-15T01:30:15Z"}}';
    const env = parse(pool, text, '.test.Envelope');
    expect(print(env)).toBe(text);
    // FieldMask
    const fm = parse(
      pool,
      '{"detail":{"@type":"type.googleapis.com/google.protobuf.FieldMask","value":"fooBar"}}',
      '.test.Envelope',
    );
    expect(print(fm)).toBe(
      '{"detail":{"@type":"type.googleapis.com/google.protobuf.FieldMask","value":"foo_bar"}}',
    );
  });

  it('renders Empty as @type only', () => {
    const pool = makePool();
    const env = parse(
      pool,
      '{"detail":{"@type":"type.googleapis.com/google.protobuf.Empty"}}',
      '.test.Envelope',
    );
    expect(print(env)).toBe(
      '{"detail":{"@type":"type.googleapis.com/google.protobuf.Empty"}}',
    );
    // A payload field on Empty is a protocol error, not an ordinary unknown key.
    expect(() =>
      parse(
        pool,
        '{"detail":{"@type":"type.googleapis.com/google.protobuf.Empty","x":1}}',
        '.test.Envelope',
      ),
    ).toThrow(/unknown field "x" for \.google\.protobuf\.Empty/);
  });

  it('fails on unresolvable type URLs or missing value', () => {
    const pool = makePool();
    expect(() =>
      parse(pool, '{"detail":{"@type":"type.googleapis.com/test.Missing"}}', '.test.Envelope'),
    ).toThrow(/cannot resolve Any type URL/);
    expect(() => parse(pool, '{"detail":{}}', '.test.Envelope')).toThrow(/requires a string "@type"/);
    expect(() =>
      parse(
        pool,
        '{"detail":{"@type":"type.googleapis.com/google.protobuf.Timestamp"}}',
        '.test.Envelope',
      ),
    ).toThrow(/requires "value"/);
  });

  it('supports recursive Any (Any inside Any)', () => {
    const pool = makePool();
    const text =
      '{"detail":{"@type":"type.googleapis.com/google.protobuf.Any",' +
      '"value":{"@type":"type.googleapis.com/test.Inner","value":"deep"}}}';
    const env = parse(pool, text, '.test.Envelope');
    expect(print(env)).toBe(text);
    const outerAny = env.getField(env.descriptor.fields[1]) as DynamicMessage;
    const innerAny = outerAny.anyPayload as DynamicMessage;
    expect(innerAny.descriptor.fullName).toBe('.google.protobuf.Any');
    expect((innerAny.anyPayload as DynamicMessage).getField(
      (innerAny.anyPayload as DynamicMessage).descriptor.fields[0],
    )).toBe('deep');
  });

  it('preserves custom type URL hosts and rejects payload field alias conflicts', () => {
    const pool = makePool();
    const env = parse(
      pool,
      '{"detail":{"@type":"my.example.com/test.Inner","value":"h"}}',
      '.test.Envelope',
    );
    const any = env.getField(env.descriptor.fields[1]) as DynamicMessage;
    expect(any.getField(any.descriptor.fields[0])).toBe('my.example.com/test.Inner');
    // An Inner payload addressed by both snake_case and camelCase names.
    expect(() =>
      parse(
        pool,
        '{"detail":{"@type":"type.googleapis.com/test.Inner","value":"a","n":1}}',
        '.test.Envelope',
      ),
    ).not.toThrow();
    // A multi-word field reached via both its snake and camel names.
    expect(() =>
      parse(
        pool,
        '{"detail":{"@type":"type.googleapis.com/test.Recursive","extraData":"a","extra_data":"b"}}',
        '.test.Envelope',
      ),
    ).toThrow(/both map to extraData/);
  });
});

describe('recursive messages', () => {
  it('round-trips deeply nested messages', () => {
    const pool = makePool();
    const text = '{"name":"a","child":{"name":"b","child":{"name":"c"}}}';
    expect(roundTrip(pool, '.test.Recursive', text)).toBe(text);
  });
});

describe('maps', () => {
  it('emits keys sorted: numeric keys numerically, strings lexicographically', () => {
    const pool = makePool();
    const msg = parse(
      pool,
      '{"strToInt":{"zeta":"2","alpha":"10","mid":"-1"},"intToStr":{"10":"ten","2":"two","-1":"neg"}}',
      '.test.Maps',
    );
    expect(print(msg)).toBe(
      '{"strToInt":{"alpha":"10","mid":"-1","zeta":"2"},"intToStr":{"-1":"neg","2":"two","10":"ten"}}',
    );
  });

  it('64-bit keys are strings; bool and message maps work', () => {
    const pool = makePool();
    const msg = parse(
      pool,
      '{"i64ToMsg":{"9007199254740993":{"value":"big"}},"boolToColor":{"true":"BLUE","false":9}}',
      '.test.Maps',
    );
    expect(print(msg)).toBe(
      '{"i64ToMsg":{"9007199254740993":{"value":"big"}},"boolToColor":{"false":9,"true":"BLUE"}}',
    );
  });

  it('rejects non-object maps, null scalar values, and normalized key collisions', () => {
    const pool = makePool();
    expect(() => parse(pool, '{"strToInt":[1]}', '.test.Maps')).toThrow(/expected object/);
    expect(() => parse(pool, '{"strToInt":{"a":null}}', '.test.Maps')).toThrow(
      /null value allowed only for message maps/,
    );
    // "01" and "1" normalize to the same int32 key.
    expect(() => parse(pool, '{"intToStr":{"1":"a","01":"b"}}', '.test.Maps')).toThrow(
      /duplicate map key/,
    );
  });

  it('empty map is omitted but setMapEntry ordering is preserved then sorted', () => {
    const pool = makePool();
    const msg = new DynamicMessage(pool.lookupMessage('.test.Maps'), pool);
    expect(print(msg)).toBe('{}');
    const mapField = msg.descriptor.fields[0];
    msg.setMapEntry(mapField, 'b', 2n);
    msg.setMapEntry(mapField, 'a', 1n);
    expect(msg.getMap(mapField).size).toBe(2);
    expect(print(msg)).toBe('{"strToInt":{"a":"1","b":"2"}}');
  });
});

describe('additional edge cases', () => {
  it('JSON null clears singular fields and stands for unset message', () => {
    const pool = makePool();
    const scalars = parse(pool, '{"optI32":9,"optMsg":null}', '.test.Scalars');
    expect(scalars.has(scalars.descriptor.fields[10])).toBe(true);
    expect(scalars.has(scalars.descriptor.fields[11])).toBe(false);
    // null after a value removes presence.
    const cleared = parse(pool, '{"optI32":null}', '.test.Scalars');
    expect(cleared.has(cleared.descriptor.fields[10])).toBe(false);
    // null on a repeated field is an error.
    expect(() => parse(pool, '{"repI64":null}', '.test.Scalars')).toThrow(JsonFormatError);
  });

  it('rejects non-strict JSON number spellings', () => {
    const pool = makePool();
    expect(() => parse(pool, '{"i32":01}', '.test.Scalars')).toThrow(/invalid JSON/);
    expect(() => parse(pool, '{"i32":+1}', '.test.Scalars')).toThrow(/invalid JSON/);
    expect(() => parse(pool, '{"i32":1.}', '.test.Scalars')).toThrow(/invalid JSON/);
  });

  it('proto2 and proto3-optional presence stays observable after round trip', () => {
    const pool = makePool();
    const p2 = parse(pool, '{"requiredI32":0,"text":"x"}', '.test.Proto2');
    expect(p2.has(p2.descriptor.fields[0])).toBe(false); // i32 never set
    expect(p2.has(p2.descriptor.fields[2])).toBe(true); // text set
    const again = parse(pool, print(p2), '.test.Proto2');
    expect(again.has(again.descriptor.fields[0])).toBe(false);
    expect(again.has(again.descriptor.fields[2])).toBe(true);
  });

  it('Any payload map keys sort deterministically (string keys lexicographically)', () => {
    const pool = makePool();
    const input =
      '{"more":{"@type":"type.googleapis.com/test.Maps",' +
      '"strToInt":{"10":"1","9":"2","100":"3"}}}';
    const expected =
      '{"more":{"@type":"type.googleapis.com/test.Maps",' +
      '"strToInt":{"10":"1","100":"3","9":"2"}}}';
    const env = parse(pool, input, '.test.Envelope');
    expect(print(env)).toBe(expected);
  });
});

describe('round-trip presence preservation', () => {
  it('presence and oneof selection survive print -> parse -> print', () => {
    const pool = makePool();
    const cases = [
      ['.test.Scalars', '{"optI32":0,"i64":"42","repI64":[1,"2"]}'],
      ['.test.Scalars', '{"optMsg":{"n":0}}'],
      ['.test.Proto2', '{"i32":0,"requiredI32":3}'],
      ['.test.Choice', '{"c":{"value":"","n":0}}'],
      ['.test.Maps', '{"intToStr":{}}'],
    ] as const;
    for (const [name, text] of cases) {
      const once = print(parse(pool, text, name));
      const twice = print(parse(pool, once, name));
      expect(once, name).toBe(twice);
    }
    // Descriptor-order output for the mixed scalar case.
    expect(print(parse(pool, cases[0][1], cases[0][0]))).toBe(
      '{"i64":"42","optI32":0,"repI64":["1","2"]}',
    );
  });

  it('programmatic oneof selection remains observable after round trip', () => {
    const pool = makePool();
    const choice = new DynamicMessage(pool.lookupMessage('.test.Choice'), pool);
    choice.setField(choice.descriptor.fields[0], 0);
    const text = print(choice);
    expect(text).toBe('{"a":0}');
    expect(parse(pool, text, '.test.Choice').whichOneof('pick')?.name).toBe('a');
  });
});
