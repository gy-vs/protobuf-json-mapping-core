// Timestamp / Duration parsing and canonical formatting.
//
// Timestamp: RFC 3339, canonical `YYYY-MM-DDTHH:MM:SS[.fff|.ffffff|.fffffffff]Z`
// Duration:  `[-]DIGITS[.fff|.ffffff|.fffffffff]s`
// Nanos carry the sign of the seconds for durations; timestamps keep nanos >= 0.

export interface SecondsNanos {
  seconds: bigint;
  nanos: number;
}

export class TimeParseError extends Error {}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Days since 1970-01-01 (Howard Hinnant's civil-date algorithm). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = month + (month > 2 ? -3 : 9);
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [y + (m <= 2 ? 1 : 0), m, d];
}

const TIMESTAMP_RE =
  /^(\d{4,})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/;

// Inclusive valid Timestamp range: 0001-01-01T00:00:00Z .. 9999-12-31T23:59:59.999999999Z
const MIN_TIMESTAMP_SECONDS = -62135596800n;
const MAX_TIMESTAMP_SECONDS = 253402300799n;

export function parseTimestamp(text: string): SecondsNanos {
  const m = TIMESTAMP_RE.exec(text);
  if (!m) throw new TimeParseError(`invalid Timestamp: ${JSON.stringify(text)}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const frac = m[7] ?? '';
  const zone = m[8];

  if (month < 1 || month > 12) throw new TimeParseError(`invalid month in ${JSON.stringify(text)}`);
  const maxDay = MONTH_LENGTHS[month - 1] + (month === 2 && isLeap(year) ? 1 : 0);
  if (day < 1 || day > maxDay) throw new TimeParseError(`invalid date in ${JSON.stringify(text)}`);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new TimeParseError(`invalid time of day in ${JSON.stringify(text)}`);
  }
  if (year < 1 || year > 9999) {
    throw new TimeParseError(`Timestamp year out of range: ${JSON.stringify(text)}`);
  }

  let offsetSeconds = 0;
  if (zone !== 'Z' && zone !== 'z') {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) throw new TimeParseError(`invalid UTC offset: ${JSON.stringify(text)}`);
    offsetSeconds = (oh * 3600 + om * 60) * (zone[0] === '-' ? -1 : 1);
  }

  let seconds =
    BigInt(daysFromCivil(year, month, day)) * 86400n +
    BigInt(hour * 3600 + minute * 60 + second) -
    BigInt(offsetSeconds);
  const nanos = frac.length === 0 ? 0 : Number(frac.padEnd(9, '0'));

  // Normalize at the boundary: nanos are always non-negative.
  if (nanos !== 0 && seconds === MIN_TIMESTAMP_SECONDS) {
    throw new TimeParseError(`Timestamp out of range: ${JSON.stringify(text)}`);
  }
  if (seconds < MIN_TIMESTAMP_SECONDS || seconds > MAX_TIMESTAMP_SECONDS) {
    throw new TimeParseError(`Timestamp out of range: ${JSON.stringify(text)}`);
  }
  if (nanos < 0 || nanos > 999_999_999) {
    throw new TimeParseError(`Timestamp nanos out of range: ${JSON.stringify(text)}`);
  }
  return { seconds, nanos };
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** Canonical Timestamp string (UTC, `Z`, 3/6/9 fractional digits only). */
export function formatTimestamp({ seconds, nanos }: SecondsNanos): string {
  if (nanos < 0 || nanos > 999_999_999) {
    throw new TimeParseError(`Timestamp nanos must be in [0, 999999999], got ${nanos}`);
  }
  let days = Number(seconds / 86400n);
  let remainder = Number(seconds % 86400n);
  if (remainder < 0) {
    remainder += 86400;
    days -= 1;
  }
  const [year, month, day] = civilFromDays(days);
  if (year < 1 || year > 9999) {
    throw new TimeParseError(`Timestamp seconds out of range: ${seconds}`);
  }
  const hour = Math.floor(remainder / 3600);
  const minute = Math.floor((remainder % 3600) / 60);
  const second = remainder % 60;
  let frac = '';
  if (nanos !== 0) {
    const digits = String(nanos).padStart(9, '0');
    // Trim to 3, 6 or 9 digits.
    frac = '.' + digits.replace(/0{3}$/, '').replace(/0{3}$/, '').replace(/0{3}$/, '');
  }
  return (
    String(year).padStart(4, '0') +
    `-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}${frac}Z`
  );
}

const DURATION_RE = /^(-)?(\d+)(?:\.(\d{1,9}))?s$/;

// +/-10000 years, using the Gregorian average year.
const MAX_DURATION_SECONDS = 315_576_000_000n;

export function parseDuration(text: string): SecondsNanos {
  const m = DURATION_RE.exec(text);
  if (!m) throw new TimeParseError(`invalid Duration: ${JSON.stringify(text)}`);
  const negative = m[1] === '-';
  const whole = BigInt(m[2]);
  const frac = m[3] ?? '';
  let nanos = frac.length === 0 ? 0 : Number(frac.padEnd(9, '0'));

  if (whole > MAX_DURATION_SECONDS) {
    throw new TimeParseError(`Duration out of range: ${JSON.stringify(text)}`);
  }
  let seconds = whole;
  if (negative) {
    seconds = -whole;
    nanos = -nanos;
  }
  if (whole === MAX_DURATION_SECONDS && nanos !== 0) {
    throw new TimeParseError(`Duration out of range: ${JSON.stringify(text)}`);
  }
  validateDurationSign(seconds, nanos);
  return { seconds, nanos };
}

function validateDurationSign(seconds: bigint, nanos: number): void {
  if (nanos < -999_999_999 || nanos > 999_999_999) {
    throw new TimeParseError(`Duration nanos out of range: ${nanos}`);
  }
  if (seconds > 0n && nanos < 0) throw new TimeParseError('Duration nanos sign must match seconds');
  if (seconds < 0n && nanos > 0) throw new TimeParseError('Duration nanos sign must match seconds');
}

/** Canonical Duration string; fraction trimmed, sign taken from seconds/nanos. */
export function formatDuration({ seconds, nanos }: SecondsNanos): string {
  validateDurationSign(seconds, nanos);
  if (seconds < -MAX_DURATION_SECONDS || seconds > MAX_DURATION_SECONDS) {
    throw new TimeParseError(`Duration seconds out of range: ${seconds}`);
  }
  const negative = seconds < 0n || nanos < 0;
  const absSeconds = negative ? -seconds : seconds;
  const absNanos = negative ? -nanos : nanos;
  if (absSeconds === MAX_DURATION_SECONDS && absNanos !== 0) {
    throw new TimeParseError('Duration out of range');
  }
  let frac = '';
  if (absNanos !== 0) {
    const digits = String(absNanos).padStart(9, '0');
    frac = '.' + digits.replace(/0{3}$/, '').replace(/0{3}$/, '').replace(/0{3}$/, '');
  }
  return `${negative ? '-' : ''}${absSeconds}${frac}s`;
}
