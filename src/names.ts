// Field-name / FieldMask-path case conversion, matching the protobuf JSON
// mapping rules (proto snake_case <-> lowerCamelCase).

export function snakeToLowerCamel(name: string): string {
  let out = '';
  let upper = false;
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (c === '_') {
      upper = true;
    } else if (upper) {
      out += c.toUpperCase();
      upper = false;
    } else {
      out += c;
    }
  }
  return out;
}

// Inverse of the algorithm used by protobuf for FieldMask paths:
// an uppercase letter starts a new snake_case word when it follows a
// lowercase letter, or when it is the last upper in an uppercase run.
export function lowerCamelToSnake(name: string): string {
  const isLower = (c: string) => c >= 'a' && c <= 'z';
  const isUpper = (c: string) => c >= 'A' && c <= 'Z';
  let out = '';
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (isUpper(c)) {
      const prev = i > 0 ? name[i - 1] : '';
      const next = i + 1 < name.length ? name[i + 1] : '';
      if (
        i > 0 &&
        (isLower(prev) || (isUpper(prev) && isLower(next)))
      ) {
        out += '_';
      }
      out += c.toLowerCase();
    } else {
      out += c;
    }
  }
  return out;
}
