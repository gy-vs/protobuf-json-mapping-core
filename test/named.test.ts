import { expect, it, describe } from 'vitest';
import {
  DescriptorPool,
  DynamicMessage,
  toJson,
  fromJson,
  type FileProto,
} from '../src/index.js';

function build(): DescriptorPool {
  const p = new DescriptorPool();
  p.addFile({
    name: 'm.proto',
    package: 'm',
    syntax: 'proto3',
    messages: [
      {
        kind: 'message',
        name: 'M',
        fields: [
          { name: 'snake_here', number: 1, type: 'int32', oneof: 'o' },
          { name: 'other_one', number: 2, type: 'int32', oneof: 'o' },
          { name: 'colors', number: 3, type: 'Col', label: 'repeated' },
          { name: 'mask', number: 4, type: 'google.protobuf.FieldMask' },
          { name: 'any', number: 5, type: 'google.protobuf.Any' },
          { name: 'p3opt_bytes', number: 6, type: 'bytes', proto3Optional: true },
        ],
        oneofs: [{ name: 'o' }],
      },
      {
        kind: 'enum',
        name: 'Col',
        values: [
          { name: 'ZERO', number: 0 },
          { name: 'A', number: 1 },
          { name: 'A_ALIAS', number: 1 },
        ],
      },
    ],
  } as FileProto);
  return p;
}

describe('named requirement scenarios', () => {
  it('oneof conflict via snake/camel dual names of different members', () => {
    const p = build();
    const M = p.findMessage('m.M')!;
    // two members of oneof "o" supplied through mixed name styles
    expect(() => fromJson(M, '{"snakeHere":1,"other_one":2}', p)).toThrow(/oneof/);
    expect(() => fromJson(M, '{"snake_here":1,"otherOne":2}', p)).toThrow(/oneof/);
  });

  it('enum alias accepted in parsing, canonical name in output', () => {
    const p = build();
    const M = p.findMessage('m.M')!;
    const m = fromJson(M, '{"colors":["A","A_ALIAS",1]}', p);
    expect(m.get('colors')).toEqual([1, 1, 1]);
    expect(toJson(m)).toBe('{"colors":["A","A","A"]}');
  });

  it('inline empty FieldMask prints empty string', () => {
    const p = build();
    const M = p.findMessage('m.M')!;
    const m = fromJson(M, '{"mask":""}', p);
    expect((m.get('mask') as DynamicMessage).get('paths')).toEqual([]);
    expect(toJson(m)).toBe('{"mask":""}');
  });

  it('Any general form with unknown keys in ignore mode', () => {
    const p = build();
    const M = p.findMessage('m.M')!;
    const m = fromJson(
      M,
      '{"any":{"@type":"type.googleapis.com/m.M","colors":["A"],"future":123}}',
      p,
      { unknownFields: 'ignore' },
    );
    const any = m.get('any') as DynamicMessage;
    const inner = any.get('value') as DynamicMessage;
    expect(inner.get('colors')).toEqual([1]);
    expect(toJson(m)).toBe(
      '{"any":{"@type":"type.googleapis.com/m.M","colors":["A"]}}',
    );
  });

  it('proto3 optional bytes explicit empty value stays present', () => {
    const p = build();
    const M = p.findMessage('m.M')!;
    const m = fromJson(M, '{"p3optBytes":""}', p);
    expect(m.has('p3opt_bytes')).toBe(true);
    expect((m.get('p3opt_bytes') as Uint8Array).length).toBe(0);
    expect(toJson(m)).toBe('{"p3optBytes":""}');
  });

  it('regular proto3 scalar presence matrix across round trip', () => {
    const p = new DescriptorPool();
    p.addFile({
      name: 's.proto',
      package: 's',
      syntax: 'proto3',
      messages: [
        {
          kind: 'message',
          name: 'S',
          fields: [
            { name: 'a', number: 1, type: 'int32' },
            { name: 'b', number: 2, type: 'int32', proto3Optional: true },
            { name: 'c', number: 3, type: 'string' },
            { name: 'd', number: 4, type: 'bool' },
            { name: 'e', number: 5, type: 'double' },
          ],
        },
      ],
    } as FileProto);
    const S = p.findMessage('s.S')!;
    const m = fromJson(S, '{"a":0,"b":0,"c":"","d":false,"e":0}', p);
    expect([m.has('a'), m.has('b'), m.has('c'), m.has('d'), m.has('e')]).toEqual([
      false, true, false, false, false,
    ]);
    expect(toJson(m)).toBe('{"b":0}');
  });
});
