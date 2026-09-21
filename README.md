# Protocol Buffers canonical JSON mapping

Descriptor-based dynamic messages with canonical proto3 JSON mapping.

Run `npm install`, then `npm test` and `npm run build`.

## Modules

- `src/descriptors.ts` — `DescriptorPool`, message/enum/field descriptors,
  proto2/proto3 syntax, `proto3 optional`, oneofs, map entries, well-known types.
- `src/dynamic.ts` — `DynamicMessage` value tree with explicit presence
  tracking (`has()`, `whichOneof()`, `isExplicitlySet()`), bigint 64-bit
  integers, bytes as `Uint8Array`, map and repeated helpers, `Any` payload.
- `src/json.ts` — `JsonPrinter` / `JsonParser`.
- `src/time.ts` — Timestamp/Duration parse + canonical formatting.
- `src/names.ts` — snake/camel conversion and base64.

## Canonical JSON mapping

- 64-bit integers: decimal strings (input accepts safe numbers or strings).
- `bytes`: padded standard base64 on output; standard/URL-safe, padded or
  unpadded on input.
- enums: names on output (first declared name for aliases); names or numbers
  on input, unknown numbers preserved numerically.
- `Timestamp` RFC 3339 (`Z`, 3/6/9 fractional digits), `Duration`
  `[-]D[.fff]s` with sign-consistent nanos, `FieldMask` comma-joined
  snake_case paths, `Any` as `{"@type": ...}` envelopes resolved through the
  descriptor pool (specialized WKTs wrapped under `"value"`, recursive `Any`
  supported).
- proto3 implicit scalar defaults are omitted; proto2, `proto3 optional`,
  oneof and message fields retain explicit presence, including default values.
- Output field order follows descriptor order; map keys are sorted.
- Unknown fields: strict (default, error) or `ignoreUnknownFields`; duplicate
  raw keys, snake/camel alias collisions and oneof conflicts are always
  errors. `-0.0`, `NaN`, `Infinity` and out-of-range timestamps/durations are
  handled per spec.

```ts
import { JsonParser, JsonPrinter, standardPool } from './dist/index.js';

const pool = standardPool([{ messages: [{ name: '.pkg.Msg', fields: [
  { name: 'user_id', number: 1, type: 'int64' },
] }] }]);

const msg = new JsonParser(pool).parse('{"userId":"42"}', pool.lookupMessage('.pkg.Msg'));
new JsonPrinter().print(msg); // '{"userId":"42"}'
```
