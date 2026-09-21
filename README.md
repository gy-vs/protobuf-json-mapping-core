# Protocol Buffers JSON mapping

TypeScript library providing the canonical protobuf JSON mapping on top of
descriptor-driven dynamic messages.

Run `npm install`, then `npm test` and `npm run build`.

## Features

- **Descriptor pool & dynamic messages** (`DescriptorPool`, `DynamicMessage`)
  with full proto2 / proto3 presence semantics:
  - proto3 implicit-presence scalars (default value ⇔ unset)
  - proto2 optional/required fields and explicit defaults
  - `proto3 optional`, `oneof`, and message-typed fields keep explicit presence
- **Canonical serialization** (`toJson`, `toJsonValue`) with deterministic
  field order (by field number) and sorted map keys:
  - 64-bit integers as decimal strings
  - `bytes` as padded standard-alphabet base64
  - enums by name (first-declared name for alias values), unknown numeric
    enum values emitted as numbers
  - `Timestamp`, `Duration`, `FieldMask`, `Any` special forms
  - wrapper types (`Int64Value`, …) as bare scalars
  - `NaN` / `Infinity` / `-Infinity` quoted; `-0` preserved
- **Lenient parsing** (`fromJson`) that accepts every alternative the spec
  allows and emits the canonical form:
  - snake_case and lowerCamelCase field names (using both for the same field
    in one object is an error; literal duplicate JSON keys are rejected)
  - numbers or strings for 64-bit values (decimal or hex), enums by name or
    number, floats as numbers/strings/`"NaN"`/`"Infinity"`
  - base64 standard/URL-safe, padded/unpadded
  - RFC 3339 timestamps with offsets; durations with fractional seconds
  - camelCase FieldMask paths
  - `null` clears a singular field
  - `unknownFields: 'strict'` (default) or `'ignore'`
  - oneof conflicts and conflicting field aliases are errors
  - `Any` type URLs are resolved against the descriptor pool, including
    recursively nested `Any` values

## Example

```ts
import { DescriptorPool, DynamicMessage, toJson, fromJson } from './dist/index.js';

const pool = new DescriptorPool(); // includes google.protobuf.* WKTs
pool.addFile({
  name: 'demo.proto',
  package: 'demo',
  syntax: 'proto3',
  messages: [
    {
      kind: 'message',
      name: 'Msg',
      fields: [
        { name: 'id', number: 1, type: 'int64' },
        { name: 'ts', number: 2, type: 'google.protobuf.Timestamp' },
        { name: 'any', number: 3, type: 'google.protobuf.Any' },
      ],
    },
  ],
});

const Msg = pool.findMessage('demo.Msg')!;
const msg = fromJson(Msg, '{"id":"42","ts":"2020-01-01T00:00:00Z"}', pool);
toJson(msg); // {"id":"42","ts":"2020-01-01T00:00:00Z"}
```
